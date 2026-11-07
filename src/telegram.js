import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { compactId, conflict, expandId } from './review.js';
import { usesImmomio } from './immomio.js';

const LIMIT = 4096; // Telegram's message length in UTF-16 units.
const COPY_LIMIT = 256; // Telegram's cap on a copy_text button's text.
const TOAST_LIMIT = 200; // Telegram's cap on a tap's answer; a longer one is refused and the button keeps spinning.
const INVALID = { text: 'This approval is invalid.' };
// Review buttons, one letter each to fit Telegram's 64-byte limit: a approve, d dismiss, w write the message,
// p copy a draft too long for a copy button, and the two edits below, whose prompt's reply revises the draft.
const EDITS = {
  e: { mode: 'ai', ask: '✏️ How should I rewrite it?', placeholder: 'e.g. shorter, different opening, mention move-in 1 March' },
  m: { mode: 'manual', ask: '📝 Send the message exactly as it should go out. Tip: copy the draft above and change it.', placeholder: 'Your message' },
};

// What a sent application tells the user, by outcome status and site.
const OUTCOME = {
  sent: site => site === 'IS24' ? { heading: '✅ Message sent', text: 'IS24 accepted your request.' } : { heading: '✅ Applied on Immomio', text: '' },
  unknown_outcome: site => ({ heading: `⚠️ Check your ${site} account`,
    text: `Submission outcome is uncertain. Check your ${site === 'IS24' ? 'IS24 messages' : 'Immomio applications'} before taking any further action. The agent will not retry.` }),
  failed: () => ({ heading: '❌ Message not sent', text: 'The message was not sent. No automatic retry will occur.' }),
};

// A cut at `end` that keeps a UTF-16 surrogate pair together.
const safeEnd = (text, end) => end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end;

function chunks(text, limit = LIMIT) {
  const result = [];
  while (text.length) {
    const end = safeEnd(text, Math.min(limit, text.length));
    result.push(text.slice(0, end));
    text = text.slice(end);
  }
  return result;
}

// Only IS24's own image CDN: listing data must not choose what Telegram fetches. URL parsing
// percent-encodes the CDN's raw "800x600>" (Telegram rejects it); JPEG previews more reliably than WebP.
function previewImage(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'pictures.immobilienscout24.de') return null;
    url.pathname = url.pathname.replace('/format/webp/', '/format/jpg/');
    return url.href;
  } catch { return null; }
}

// The listing's photos as preview URLs; the first is the one a new card shows.
const photos = listing => (listing.images || [listing.image_url]).map(previewImage).filter(Boolean);
const preview = url => ({ url, prefer_large_media: true, show_above_text: true });
const photoRow = row => row.some(button => button.callback_data?.startsWith('g:'));

// A listing as one message, with native entities: an optional outcome heading and note, its facts and links,
// as much of the description as fits, and under draftLabel the draft. URLs are built here, never taken from listing data.
function listingMessage(review, { heading, note, draftLabel, immomio }) {
  const listing = review.snapshot;
  let text = '';
  const entities = [];
  const append = (part, type, extra = {}) => {
    if (type) entities.push({ type, offset: text.length, length: part.length, ...extra });
    text += part;
  };
  if (heading) { append(heading, 'bold'); append(`\n${note}\n\n`); }
  const address = String(listing.address || '').replace(/\s*\([^)]*\)/g, '').trim();
  append(String(listing.title), 'bold');
  append(`\n📍 ${address || 'Address unavailable'}\n💶 `); append(`${listing.price ?? '?'} €`, 'bold');
  const facts = [`📐 ${listing.area ?? '?'} m²`, `🚪 ${listing.rooms ?? '?'} Zi.`,
    listing.earlyAccess && '🔒 Suchen+'].filter(Boolean);
  append(` · ${facts.join(' · ')}\n`);
  if (immomio) append('🏢 Applies on Immomio with your profile and this message\n');
  const query = encodeURIComponent(address);
  const links = [
    /^\d+$/.test(review.exposeId) && ['Listing', `https://www.immobilienscout24.de/expose/${review.exposeId}`],
    address && ['Google Maps', `https://www.google.com/maps/search/?api=1&query=${query}`],
    address && ['Apple Maps', `https://maps.apple.com/?q=${query}`],
  ].filter(Boolean);
  const tail = [...links.flatMap(([label, url], index) => [...(index ? [[' · ']] : []), [label, 'text_link', { url }]]),
    ...(draftLabel ? [[`\n\n${draftLabel}\n`, 'bold'], [review.draft, 'blockquote']] : [])];
  const details = [listing.description, ...(listing.amenities || []).map(item => `• ${item}`)].filter(Boolean).join('\n');
  const room = LIMIT - text.length - tail.reduce((sum, [part]) => sum + part.length, 0) - 2;
  if (details && room > 100) {
    const cut = safeEnd(details, Math.min(details.length, room - 1));
    append(cut < details.length ? `${details.slice(0, cut)}…` : details, 'expandable_blockquote'); append('\n');
  }
  for (const [part, type, extra] of tail) append(part, type, extra);
  return { text, entities };
}

// The one connection to Telegram: every person's private chat with the bot arrives here, and route(update)
// hands each update to that person.
export class Bot {
  constructor({ config, fetchImpl = fetch, route = async () => {}, onError = () => {} }) {
    Object.assign(this, { fetchImpl, route, onError });
    this.token = config.telegramBotToken;
    this.offsetFile = join(config.dataDir, 'telegram-offset.json');
    this.offset = 0;
    try { this.offset = JSON.parse(readFileSync(this.offsetFile, 'utf8')).offset || 0; } catch (error) { if (error.code !== 'ENOENT') throw new Error('Telegram update offset is unreadable'); }
    this.controller = new AbortController();
    this.loop = null;
  }
  async api(method, body, signal = AbortSignal.timeout(30_000), retried = false) {
    // Never include the token-bearing URL or response body in errors/logs.
    let response;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
      });
    } catch { throw new Error(`Telegram ${method} network request failed`); }
    // Bursts (the first poll can deliver dozens of reviews) hit Telegram's rate limit: wait as told, once.
    if (response.status === 429 && !retried) {
      const wait = Math.min(Number((await response.json().catch(() => ({}))).parameters?.retry_after) || 5, 60);
      await new Promise(resolve => setTimeout(resolve, wait * 1000));
      return this.api(method, body, AbortSignal.timeout(30_000), true);
    }
    if (!response.ok) throw new Error(`Telegram ${method} failed (HTTP ${response.status})`);
    const result = await response.json();
    if (!result.ok) throw new Error(`Telegram ${method} was rejected`);
    return result.result;
  }
  // The bot's name and profile photo, for the Mini App pages. Read once; a failure is tried again next time.
  profile() {
    this.profileInfo ??= (async () => {
      const me = this.me ?? await this.api('getMe', {});
      let photo = null;
      try {
        const sizes = (await this.api('getUserProfilePhotos', { user_id: me.id, limit: 1 })).photos[0];
        if (sizes) {
          const file = await this.api('getFile', { file_id: sizes[Math.min(1, sizes.length - 1)].file_id });
          const response = await this.fetchImpl(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
          if (response.ok) photo = Buffer.from(await response.arrayBuffer());
        }
      } catch { /* No photo: the page shows a placeholder. */ }
      return { name: me.first_name || me.username || 'Your agent', photo };
    })().catch(error => { this.profileInfo = null; throw error; });
    return this.profileInfo;
  }
  saveOffset(offset) {
    const temp = `${this.offsetFile}.tmp`;
    writeFileSync(temp, JSON.stringify({ offset }), { mode: 0o600 });
    renameSync(temp, this.offsetFile);
    this.offset = offset;
  }
  // Fails fast on a wrong token, or a webhook that would make getUpdates fail forever.
  async verify() {
    this.me = await this.api('getMe', {}).catch(error => { throw /HTTP 401|HTTP 404/.test(error.message) ? new Error('Telegram rejected TELEGRAM_BOT_TOKEN; copy the token from @BotFather again') : error; });
    if ((await this.api('getWebhookInfo', {})).url) throw new Error('This Telegram bot has a webhook set; use a dedicated bot without one (or call deleteWebhook)');
  }
  start() {
    if (this.loop) return this.loop;
    this.loop = this.pollUpdates();
    return this.loop;
  }
  async pollUpdates() {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      try {
        const updates = await this.api('getUpdates', { offset: this.offset, timeout: 20, allowed_updates: ['callback_query', 'message'] }, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
        for (const update of updates) {
          if (signal.aborted) break;
          // A failing update (e.g. a button tapped long ago) must not block every later one.
          // ponytail: one update at a time for everybody; a slow step delays the others by seconds. Per-chat queues if that shows.
          try { await this.route(update); } catch (error) { this.onError(error.message); }
          this.saveOffset(update.update_id + 1);
        }
      } catch (error) {
        if (signal.aborted) break;
        this.onError(error.message);
        await new Promise(resolve => {
          const timer = setTimeout(done, 5000);
          function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
          signal.addEventListener('abort', done, { once: true });
        });
      }
    }
  }
  async close() { this.controller.abort(); await this.loop; }
}

// One person's interface. Reads reviews to verify signed buttons; every decision goes to the workflow,
// every configuration message to the assistant.
export class Telegram {
  // inbox: the person's Immomio conversations (immomio.js ImmomioInbox), or null.
  constructor({ config, store, workflow, bot, assistant = null, inbox = null, onError = () => {} }) {
    Object.assign(this, { config, store, workflow, bot, assistant, inbox, onError });
    this.onReplied = () => {}; // After an Immomio reply went out.
    this.token = config.telegramBotToken;
    this.controller = new AbortController();
  }
  api(...args) { return this.bot.api(...args); }
  signature(review, action) {
    return createHmac('sha256', this.token).update(JSON.stringify([this.chatId, review.id, action, review.version, review.draftHash, review.snapshotHash, review.accountBinding, review.configHash])).digest('base64url').slice(0, 16);
  }
  callback(review, action) {
    const value = `${action}:${compactId(review.id)}:${review.version}:${this.signature(review, action)}`;
    if (Buffer.byteLength(value) > 64) throw new Error('Review callback is too long');
    return value;
  }
  // carousel: buttons above the others on the first part, the one that shows the photo.
  async formatted(text, entities = [], { last = {}, image = null, carousel = null, reviewId = null, replyTo = null } = {}) {
    let offset = 0;
    const parts = chunks(text), ids = [];
    for (const [index, part] of parts.entries()) {
      const end = offset + part.length;
      const clipped = entities.flatMap(entity => {
        const start = Math.max(offset, entity.offset);
        const stop = Math.min(end, entity.offset + entity.length);
        return stop > start ? [{ ...entity, offset: start - offset, length: stop - start }] : [];
      });
      // Native entities preserve literal listing/draft text. No markup from
      // untrusted content can become formatting, links, or hidden instructions.
      // The photo is a large link preview, not a captioned photo: captions are capped at 1024 characters.
      const message = { chat_id: this.chatId, text: part, entities: clipped, link_preview_options: { is_disabled: true },
        ...(index === 0 && replyTo && { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }), ...(index === parts.length - 1 ? last : {}) };
      if (index === 0 && carousel) message.reply_markup = { inline_keyboard: [carousel, ...(message.reply_markup?.inline_keyboard || [])] };
      // A rejected photo must never block the review itself.
      const sent = index === 0 && image
        ? await this.api('sendMessage', { ...message, link_preview_options: preview(image) }).catch(() => this.api('sendMessage', message))
        : await this.api('sendMessage', message);
      if (reviewId) this.store.recordTelegramMessage(reviewId, this.chatId, sent.message_id);
      ids.push(sent.message_id);
      offset = end;
    }
    return ids;
  }
  buttons(review, layout) {
    return { inline_keyboard: layout.map(row => row.map(([text, action]) => ({ text, callback_data: this.callback(review, action) }))) };
  }
  // A carousel: ◀️/▶️ swap the card's photo in place, so the card stays one message. g:<review>:<photo>; the counter is g:<review>.
  photoButtons(review, index, count) {
    const id = compactId(review.id);
    return [{ text: '◀️', callback_data: `g:${id}:${(index + count - 1) % count}` }, { text: `${index + 1}/${count}`, callback_data: `g:${id}` },
      { text: '▶️', callback_data: `g:${id}:${(index + 1) % count}` }];
  }
  cardButtons(review) { return this.buttons(review, [[['✨ Write message', 'w'], ['✖️ Dismiss', 'd']]]); }
  // A new listing is a compact card; you decide from it whether ChatGPT writes a message. A draft (written
  // on request, or revised) arrives as its own short reply under the card. again: show the card and its draft.
  // heading/note: an outcome shown above the listing and its message instead of buttons (auto-sent reviews).
  // A listing that links to Immomio is applied for there, with the same message, once approved.
  async notify(review, { heading = '', note = '', again = false } = {}) {
    const card = !heading; // The draft, once written, is a separate reply under this card.
    if (card && review.draft && !again) return this.notifyDraft(review);
    const draftLabel = !card && review.draft ? '✉️ Message' : '';
    const { text, entities } = listingMessage(review, { heading, note, draftLabel, immomio: usesImmomio(review.snapshot, this.config) });
    const buttons = heading || review.draft ? null : this.cardButtons(review);
    const images = photos(review.snapshot);
    await this.formatted(text, entities, { image: images[0], carousel: images.length > 1 ? this.photoButtons(review, 0, images.length) : null,
      reviewId: heading ? null : review.id, last: buttons ? { reply_markup: buttons } : {} });
    if (card && again && review.draft) await this.notifyDraft(review);
  }
  // Only a draft near the 5000-character cap splits; the draft is never shortened and the buttons sit on the final part.
  async notifyDraft(review) {
    const heading = `✉️ ${review.snapshot.title}`;
    const card = (review.telegramMessages || []).find(message => message.chatId === this.chatId)?.messageId;
    const send = usesImmomio(review.snapshot, this.config) ? '✅ Apply + send' : '✅ Send';
    const keyboard = this.buttons(review, [[[send, 'a'], ['✖️ Dismiss', 'd']], [['✏️ Rewrite', 'e'], ['📝 Write myself', 'm']], []]);
    // A short draft copies with one tap; a longer one is sent as a code block, which Telegram copies with one tap.
    keyboard.inline_keyboard[2].push(review.draft.length <= COPY_LIMIT
      ? { text: '📋 Copy', copy_text: { text: review.draft } } : { text: '📋 Copy', callback_data: this.callback(review, 'p') });
    await this.formatted(`${heading}\n${review.draft}`, [{ type: 'bold', offset: 0, length: heading.length }, { type: 'blockquote', offset: heading.length + 1, length: review.draft.length }], {
      reviewId: review.id, replyTo: card, last: { reply_markup: keyboard },
    });
  }
  async notifyOutcome(review) {
    const site = usesImmomio(review.snapshot, this.config) ? 'Immomio' : 'IS24';
    const { heading, text } = (OUTCOME[review.status] ?? OUTCOME.failed)(site);
    // You never saw an auto-sent listing, so it comes with the full listing and the message.
    if (review.approvedBy === 'auto') return this.notify(review, { heading: `${heading} (auto-send)`, note: `${text}${review.detail ? `\n${review.detail}` : ''}` });
    await this.formatted(`${heading}\n\n${review.snapshot.title}\n\n${text}\n${review.detail || ''}`, [{ type: 'bold', offset: 0, length: heading.length }]);
  }
  // A landlord's Immomio message, with ↩️ Reply. The text is shown literally, like a listing. Returns the message IDs.
  forwardImmomio({ subject, from, text, attachments = [] }) {
    const heading = `📨 Immomio · ${subject}`;
    const body = text.trim() || '(no text)';
    const head = `${heading}\n${from}:\n`;
    const files = attachments.length ? `\n📎 ${attachments.join(', ')} (open them on Immomio)` : '';
    return this.formatted(`${head}${body}${files}`, [{ type: 'bold', offset: 0, length: heading.length }, { type: 'blockquote', offset: head.length, length: body.length }],
      { last: { reply_markup: { inline_keyboard: [[{ text: '↩️ Reply', callback_data: 'i:reply' }]] } } });
  }
  // ↩️ Reply under a forwarded message: a prompt whose reply goes to that conversation.
  async inboxTap(query) {
    const thread = this.inbox?.thread(query.message?.message_id);
    if (!thread) return { text: 'This conversation is no longer available here; answer on Immomio.' };
    const prompt = await this.send(`↩️ Your reply to ${thread.subject} on Immomio:`, { reply_parameters: { message_id: query.message.message_id, allow_sending_without_reply: true },
      reply_markup: { force_reply: true, input_field_placeholder: 'Your reply' } });
    this.inbox.remember([prompt.message_id], thread.conversationId, thread.subject);
    return { text: 'Reply to the prompt with your message.' };
  }
  // A reply to a forwarded Immomio message or its prompt goes out as is: you wrote it yourself.
  async replyImmomio(thread, text) {
    if (text.length > 5000) return this.send('Please keep Immomio replies under 5000 characters.');
    try {
      await this.inbox.reply(thread.conversationId, text);
      this.onReplied();
      await this.send(`✅ Sent on Immomio to ${thread.subject}.`);
    } catch (error) { await this.send(`❌ Not sent on Immomio: ${error.message}`); }
  }
  // Deletes every message shown for a review.
  async withdraw(review, extra = []) {
    const messageIds = new Set([...(review.telegramMessages || []).filter(message => message.chatId === this.chatId).map(message => message.messageId), ...extra]);
    for (const messageId of messageIds) {
      if (!Number.isInteger(messageId)) continue;
      await this.api('deleteMessage', { chat_id: this.chatId, message_id: messageId }).catch(error => this.onError(error.message));
    }
  }
  get chatId() { return String(this.config.chatId || ''); }
  send(text, extra = {}) { return this.api('sendMessage', { chat_id: this.chatId, text, ...extra }); }
  // A new person's first message from the bot.
  async welcome() {
    await this.send('👋 Hi! I am your apartment agent. I find new listings on ImmobilienScout24, write applications with ChatGPT, and send them when you approve. Let us set things up; it takes a few minutes.');
    await this.assistant.continue();
  }
  // Commands and typed answers go to the assistant, except the answer to an edit prompt (the assistant's
  // open question { kind: 'edit' }), which revises that draft.
  async handleMessage(message) {
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (message.chat?.type !== 'private' || String(message.chat.id) !== this.chatId || String(message.from?.id) !== this.chatId) return;
    if (text.startsWith('/')) return this.assistant.command(text.split(/[\s@]/)[0].toLowerCase());
    if (!text) return;
    const thread = message.reply_to_message && this.inbox?.thread(message.reply_to_message.message_id);
    if (thread) return this.replyImmomio(thread, text);
    const question = this.assistant.awaiting;
    const edit = question?.kind === 'edit' ? question : null;
    // Replying to an older edit prompt must not answer whatever is open now.
    const reply = message.reply_to_message;
    if (reply && reply.message_id !== edit?.prompt && Object.values(EDITS).some(({ ask }) => ask === reply.text)) {
      return this.send('This prompt is outdated. Tap ✏️ Rewrite or 📝 Write myself under the draft again.');
    }
    if (!edit) return this.assistant.text(text);
    // The draft was handled or replaced meanwhile: the question is over, and the message is an ordinary one.
    const review = this.store.get(edit.id);
    if (review?.status !== 'awaiting_approval' || review.version !== edit.version) {
      this.assistant.awaiting = null;
      return this.assistant.text(text);
    }
    const manual = edit.mode === 'manual';
    if (!manual && text.length > 2000) return this.send('Please keep edit instructions under 2000 characters.');
    this.assistant.awaiting = null;
    if (!manual) await this.send('✍️ Revising the draft…');
    // Long-polling continues while the agent works; the revised draft arrives as a new approval message.
    this.revise(edit.id, edit.version, text, { manual });
  }
  revise(id, version, instructions, options) {
    Promise.resolve().then(() => this.workflow.revise(id, version, instructions, options))
      .catch(error => this.send(`Could not ${instructions ? 'revise' : 'write'} the draft: ${error.message}`, instructions ? {} : { reply_markup: this.cardButtons(this.store.get(id)) })
        .catch(failure => this.onError(failure.message)));
  }
  // Every tap answers with { text } (the toast), and optionally used (remove its buttons), edit (a view that
  // replaces the message) or dismissed (delete that review's messages).
  async handleUpdate(update) {
    if (this.controller.signal.aborted) return;
    if (update.message) return this.handleMessage(update.message);
    const query = update.callback_query;
    if (!query) return;
    const owner = this.chatId && query.message?.chat?.type === 'private' && String(query.message.chat.id) === this.chatId && String(query.from?.id) === this.chatId;
    const tap = !owner ? INVALID
      : /^[ckx]:/.test(query.data || '') ? await this.assistant.choice(query.data).catch(error => ({ text: error.message }))
      : /^g:/.test(query.data || '') ? this.photoTap(query)
      : query.data === 'i:reply' ? await this.inboxTap(query).catch(error => ({ text: error.message }))
      : await this.reviewTap(query);
    const tapped = { chat_id: this.chatId, message_id: query.message?.message_id };
    // The new view before the answer: once the tap is answered, the message already shows what it led to.
    if (tap.edit && !tap.dismissed) await this.api('editMessageText', { ...tapped, text: tap.edit.text, ...tap.edit.extra }).catch(() => {});
    // A toast too long for Telegram is cut, and the whole text follows as a message. If the answer is refused anyway,
    // one without text still stops the spinner.
    const long = (tap.text?.length ?? 0) > TOAST_LIMIT;
    await this.api('answerCallbackQuery', { callback_query_id: query.id, text: long ? `${tap.text.slice(0, safeEnd(tap.text, TOAST_LIMIT - 1))}…` : tap.text })
      .catch(() => this.api('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {}));
    if (long) await this.send(tap.text).catch(() => {});
    // Older reviews have no saved IDs; remove the tapped listing message too.
    if (tap.dismissed) return this.withdraw(tap.dismissed, [tapped.message_id]);
    // Decided reviews lose their buttons, so old messages cannot be mistaken for open ones. The photos stay browsable.
    if (!tap.edit && tap.used) await this.api('editMessageReplyMarkup', { ...tapped, reply_markup: { inline_keyboard: (query.message?.reply_markup?.inline_keyboard || []).filter(photoRow) } }).catch(() => {});
  }
  // Shows another photo on the tapped card: the same text and buttons Telegram sent back with the tap, a new preview and counter.
  photoTap({ data, message }) {
    const [, id, index] = /^g:([a-f0-9]{32})(?::(\d{1,3}))?$/.exec(data) || [];
    const review = id && this.store.get(expandId(id));
    const images = review ? photos(review.snapshot) : [];
    if (images.length < 2 || !message?.text) return { text: 'These photos are no longer available.' };
    if (index === undefined) return { text: 'Tap ◀️ or ▶️ for the other photos.' };
    const at = Number(index) % images.length;
    const rows = (message.reply_markup?.inline_keyboard || []).map(row => photoRow(row) ? this.photoButtons(review, at, images.length) : row);
    return { text: '', edit: { text: message.text, extra: { entities: message.entities || [], link_preview_options: preview(images[at]), reply_markup: { inline_keyboard: rows } } } };
  }
  // A review button: <action>:<review ID without dashes>:<version>:<signature>, see callback().
  async reviewTap(query) {
    const match = /^([adewmp]):([a-f0-9]{32}):(\d+):([A-Za-z0-9_-]{16})$/.exec(query.data || '');
    const review = match && this.store.get(expandId(match[2]));
    if (!review) return INVALID;
    const [, action, , version, signature] = match;
    // Deleting a dismissed listing's leftovers changes nothing, so any of its Dismiss buttons may do it, even an older card's.
    if (review.status === 'dismissed' && action === 'd') return { text: 'Already dismissed. Removing it.', dismissed: review };
    if (review.version !== Number(version)) return { text: 'A newer draft replaced this one.' };
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(this.signature(review, action)))) return INVALID;
    try { return await this.reviewAction(action, review, query.message.message_id); }
    catch (error) { return { text: error.code === 'CONFLICT' ? error.message : 'The action failed; check the agent logs.' }; }
  }
  async reviewAction(action, review, messageId) {
    const { id, version } = review;
    if (action === 'a') {
      this.workflow.approve(id, version, review.draftHash);
      return { text: 'Approved. The agent will verify and send this exact draft.', used: true };
    }
    if (action === 'd') {
      this.workflow.dismiss(id, version);
      return { text: 'Dismissed. No message will be sent.', dismissed: review };
    }
    if (review.status !== 'awaiting_approval') conflict('Review was already handled');
    if (action === 'p') {
      await this.formatted(review.draft, [{ type: 'pre', offset: 0, length: review.draft.length }], { reviewId: id, replyTo: messageId });
      return { text: 'Tap the code block to copy the message.' };
    }
    if (action === 'w') {
      if (review.draft) conflict('The message is already written.');
      this.revise(id, version, '');
      return { text: 'Writing the message…', used: true };
    }
    // An edit: the owner's reply to this prompt, threaded under the review, so the listing need not be repeated.
    const { ask, placeholder, mode } = EDITS[action];
    const prompt = await this.send(ask, { reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
      reply_markup: { force_reply: true, input_field_placeholder: placeholder } });
    this.assistant.awaiting = { kind: 'edit', id, version, mode, prompt: prompt.message_id }; // It replaces any open question.
    return { text: 'Reply to the prompt with your changes.' };
  }
  close() { this.controller.abort(); }
}
