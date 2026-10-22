import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { compactId, conflict, expandId } from './review.js';
import { usesImmomio } from './immomio.js';

const LIMIT = 4096; // Telegram's message length in UTF-16 units.
const INVALID = { text: 'This approval is invalid.' };
// Review buttons, one letter each to fit Telegram's 64-byte limit: a approve, d dismiss, w write the message,
// and the three edits below, whose prompt's reply revises the draft.
const EDITS = {
  e: { mode: 'ai', ask: '✏️ What should change?', placeholder: 'e.g. shorter, mention move-in 1 March' },
  m: { mode: 'manual', ask: '📝 Send the message exactly as it should go out. Tip: copy the draft above and change it.', placeholder: 'Your message' },
  r: { mode: 'remember', ask: '🧠 What should I always do differently? I save it to your writing style (/prompt) and rewrite this draft with it.', placeholder: 'e.g. always mention my cat' },
};

function chunks(text, limit = LIMIT) {
  const result = [];
  while (text.length) {
    let end = Math.min(limit, text.length);
    // Keep UTF-16 surrogate pairs together when splitting long drafts.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    result.push(text.slice(0, end));
    text = text.slice(end);
  }
  return result;
}

// Only IS24's own image CDN: listing data must not choose what Telegram fetches. URL parsing
// percent-encodes the CDN's raw "800x600>" (Telegram rejects it); JPEG previews more reliably than WebP.
export function previewImage(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'pictures.immobilienscout24.de') return null;
    url.pathname = url.pathname.replace('/format/webp/', '/format/jpg/');
    return url.href;
  } catch { return null; }
}

// The user's interface. Reads reviews to verify signed buttons; every decision goes to the workflow,
// every configuration message to the assistant. Until paired, only `/start <pairingCode>` is accepted.
export class Telegram {
  constructor({ config, store, workflow, assistant = null, pairingCode = null, onPair = () => {}, fetchImpl = fetch, onError = () => {} }) {
    Object.assign(this, { config, store, workflow, assistant, pairingCode, onPair, fetchImpl, onError });
    this.token = config.telegramBotToken;
    this.offsetFile = join(config.dataDir, 'telegram-offset.json');
    this.offset = 0;
    try { this.offset = JSON.parse(readFileSync(this.offsetFile, 'utf8')).offset || 0; } catch (error) { if (error.code !== 'ENOENT') throw new Error('Telegram update offset is unreadable'); }
    this.controller = new AbortController();
    this.loop = null;
    // Edit prompt message_id -> review. In memory: after a restart, tapping ✏️ Edit again is enough.
    this.editPrompts = new Map();
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
  signature(review, action) {
    return createHmac('sha256', this.token).update(JSON.stringify([this.chatId, review.id, action, review.version, review.draftHash, review.snapshotHash, review.accountBinding, review.configHash])).digest('base64url').slice(0, 16);
  }
  callback(review, action) {
    const value = `${action}:${compactId(review.id)}:${review.version}:${this.signature(review, action)}`;
    if (Buffer.byteLength(value) > 64) throw new Error('Review callback is too long');
    return value;
  }
  async formatted(text, entities = [], { last = {}, image = null, reviewId = null, replyTo = null } = {}) {
    let offset = 0;
    const parts = chunks(text);
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
      // A rejected photo must never block the review itself.
      const sent = index === 0 && image
        ? await this.api('sendMessage', { ...message, link_preview_options: { url: image, prefer_large_media: true, show_above_text: true } }).catch(() => this.api('sendMessage', message))
        : await this.api('sendMessage', message);
      if (reviewId) this.store.recordTelegramMessage(reviewId, this.chatId, sent.message_id);
      offset = end;
    }
  }
  buttons(review, layout) {
    return { inline_keyboard: layout.map(row => row.map(([text, action]) => ({ text, callback_data: this.callback(review, action) }))) };
  }
  cardButtons(review) { return this.buttons(review, [[['✍️ Write message', 'w'], ['✖️ Dismiss', 'd']]]); }
  // A new listing is a compact card; you decide from it whether ChatGPT writes a message. A draft (written
  // on request, or revised) arrives as its own short reply under the card. again: show the card and its draft.
  // heading/note: an outcome shown above the listing and its message instead of buttons (auto-sent reviews).
  // An Immomio listing has no message: its card shows the application it approves and is decided right there.
  async notify(review, { heading = '', note = '', again = false } = {}) {
    const listing = review.snapshot;
    const immomio = usesImmomio(listing, this.config);
    if (review.draft && !heading && !again && !immomio) return this.notifyDraft(review);
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
      listing.published && `🕒 ${new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date()).replace(',', '')}`,
      listing.earlyAccess && '🔒 Suchen+'].filter(Boolean);
    append(` · ${facts.join(' · ')}\n`);
    // URLs are built here, never taken from listing data.
    const query = encodeURIComponent(address);
    const links = [
      /^\d+$/.test(review.exposeId) && ['Listing', `https://www.immobilienscout24.de/expose/${review.exposeId}`],
      address && ['Google Maps', `https://www.google.com/maps/search/?api=1&query=${query}`],
      address && ['Apple Maps', `https://maps.apple.com/?q=${query}`],
    ].filter(Boolean);
    const tail = [...links.flatMap(([label, url], index) => [...(index ? [[' · ']] : []), [label, 'text_link', { url }]]),
      ...((heading || immomio) && review.draft ? [[immomio ? '\n\n🏢 Immomio application\n' : '\n\n✉️ Message\n', 'bold'], [review.draft, 'blockquote']] : [])];
    const details = [listing.description, ...(listing.amenities || []).map(item => `• ${item}`)].filter(Boolean).join('\n');
    const room = LIMIT - text.length - tail.reduce((sum, [part]) => sum + part.length, 0) - 2;
    if (details && room > 100) {
      let cut = Math.min(details.length, room - 1);
      if (cut < details.length && /[\uD800-\uDBFF]/.test(details[cut - 1])) cut--;
      append(cut < details.length ? `${details.slice(0, cut)}…` : details, 'expandable_blockquote'); append('\n');
    }
    for (const [part, type, extra] of tail) append(part, type, extra);
    const image = previewImage(listing.image_url);
    const buttons = immomio ? this.buttons(review, [[['✅ Apply on Immomio', 'a'], ['✖️ Dismiss', 'd']]]) : this.cardButtons(review);
    await this.formatted(text, entities, { image, reviewId: heading ? null : review.id, last: heading || (review.draft && !immomio) ? {} : { reply_markup: buttons } });
    if (again && review.draft && !heading && !immomio) await this.notifyDraft(review);
  }
  // Only a draft near the 5000-character cap splits; the draft is never shortened and the buttons sit on the final part.
  async notifyDraft(review) {
    const heading = `✉️ ${review.snapshot.title}`;
    const card = (review.telegramMessages || []).find(message => message.chatId === this.chatId)?.messageId;
    await this.formatted(`${heading}\n${review.draft}`, [{ type: 'bold', offset: 0, length: heading.length }, { type: 'blockquote', offset: heading.length + 1, length: review.draft.length }], {
      reviewId: review.id, replyTo: card, last: { reply_markup: this.buttons(review, [[['✅ Send', 'a'], ['✖️ Dismiss', 'd']], [['✏️ Improve', 'e'], ['📝 Write myself', 'm'], ['🧠 Remember', 'r']]]) },
    });
  }
  async notifyOutcome(review) {
    const site = usesImmomio(review.snapshot, this.config) ? 'Immomio' : 'IS24';
    const text = review.status === 'sent' ? (site === 'IS24' ? 'IS24 accepted your request.' : '')
      : review.status === 'unknown_outcome' ? `Submission outcome is uncertain. Check your ${site === 'IS24' ? 'IS24 messages' : 'Immomio applications'} before taking any further action. The agent will not retry.`
      : 'The message was not sent. No automatic retry will occur.';
    const heading = review.status === 'sent' ? (site === 'IS24' ? '✅ Message sent' : '✅ Applied on Immomio') : review.status === 'unknown_outcome' ? `⚠️ Check your ${site} account` : '❌ Message not sent';
    // You never saw an auto-sent listing, so it comes with the full listing and the message.
    if (review.approvedBy === 'auto') return this.notify(review, { heading: `${heading} (auto-send)`, note: `${text}${review.detail ? `\n${review.detail}` : ''}` });
    await this.formatted(`${heading}\n\n${review.snapshot.title}\n\n${text}\n${review.detail || ''}`, [{ type: 'bold', offset: 0, length: heading.length }]);
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
  // The private chat that sent the pairing code becomes the owner; everyone else is ignored.
  async pair(message, text) {
    const [command, code] = text.split(/\s+/);
    if (message.chat?.type !== 'private' || String(message.from?.id) !== String(message.chat.id) || command !== '/start') return;
    if (!this.pairingCode || code !== this.pairingCode) return this.api('sendMessage', { chat_id: message.chat.id, text: 'To connect, send /start followed by the code shown in the agent log, for example: /start 123456' });
    this.pairingCode = null;
    this.onPair(String(message.chat.id));
    await this.send('👋 Hi! I am your apartment agent. I find new listings on ImmobilienScout24, write applications with ChatGPT, and send them when you approve. Let us set things up; it takes about five minutes.');
    await this.assistant.continue();
  }
  // Commands and setup answers go to the assistant; replies to an ✏️ Edit prompt revise that draft.
  async handleMessage(message) {
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!this.chatId) return this.pair(message, text);
    if (message.chat?.type !== 'private' || String(message.chat.id) !== this.chatId || String(message.from?.id) !== this.chatId) return;
    if (text.startsWith('/')) return this.assistant.command(text.split(/[\s@]/)[0].toLowerCase());
    const promptId = message.reply_to_message ? message.reply_to_message.message_id : this.assistant.asking ? undefined : [...this.editPrompts.keys()].at(-1);
    const target = this.editPrompts.get(promptId);
    const instructions = text;
    if (!target) return instructions ? this.assistant.text(instructions) : undefined;
    if (!instructions) return;
    const manual = target.mode === 'manual';
    if (!manual && instructions.length > 2000) return this.send('Please keep edit instructions under 2000 characters.');
    // 🧠 Remember: kept in your writing style, so every later draft follows it too.
    if (target.mode === 'remember') {
      try { this.assistant.remember(instructions); } catch (error) { return this.send(error.message); }
    }
    this.editPrompts.delete(promptId);
    if (!manual) await this.send(target.mode === 'remember' ? '🧠 Saved to your writing style (/prompt). Revising the draft…' : '✍️ Revising the draft…');
    // Long-polling continues while the agent works; the revised draft arrives as a new approval message.
    this.revise(target.id, target.version, instructions, { manual });
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
      : await this.reviewTap(query);
    await this.api('answerCallbackQuery', { callback_query_id: query.id, text: tap.text });
    const tapped = { chat_id: this.chatId, message_id: query.message?.message_id };
    // Older reviews have no saved IDs; remove the tapped listing message too.
    if (tap.dismissed) return this.withdraw(tap.dismissed, [tapped.message_id]);
    if (tap.edit) await this.api('editMessageText', { ...tapped, text: tap.edit.text, ...tap.edit.extra }).catch(() => {});
    // Decided reviews lose their buttons, so old messages cannot be mistaken for open ones.
    else if (tap.used) await this.api('editMessageReplyMarkup', { ...tapped, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
  // A review button: <action>:<review ID without dashes>:<version>:<signature>, see callback().
  async reviewTap(query) {
    const match = /^([adewmr]):([a-f0-9]{32}):(\d+):([A-Za-z0-9_-]{16})$/.exec(query.data || '');
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
    if (action === 'w') {
      if (review.draft) conflict('The message is already written.');
      this.revise(id, version, '');
      return { text: 'Writing the message…', used: true };
    }
    // An edit: the owner's reply to this prompt, threaded under the review, so the listing need not be repeated.
    const { ask, placeholder, mode } = EDITS[action];
    const prompt = await this.send(ask, { reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
      reply_markup: { force_reply: true, input_field_placeholder: placeholder } });
    this.editPrompts.set(prompt.message_id, { id, version, mode });
    this.assistant.asking = null; // The newest prompt wins: the next plain message is this edit.
    return { text: 'Reply to the prompt with your changes.' };
  }
  saveOffset(offset) {
    const temp = `${this.offsetFile}.tmp`;
    writeFileSync(temp, JSON.stringify({ offset }), { mode: 0o600 });
    renameSync(temp, this.offsetFile);
    this.offset = offset;
  }
  // Fails fast on a wrong token, or a webhook that would make getUpdates fail forever.
  async verify() {
    await this.api('getMe', {}).catch(error => { throw /HTTP 401|HTTP 404/.test(error.message) ? new Error('Telegram rejected TELEGRAM_BOT_TOKEN; copy the token from @BotFather again') : error; });
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
          try { await this.handleUpdate(update); } catch (error) { this.onError(error.message); }
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
