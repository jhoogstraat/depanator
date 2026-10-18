import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { conflict } from './review.js';

const LIMIT = 4096; // Telegram's message length in UTF-16 units.

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
    const value = `${action}:${review.id.replaceAll('-', '')}:${review.version}:${this.signature(review, action)}`;
    if (Buffer.byteLength(value) > 64) throw new Error('Review callback is too long');
    return value;
  }
  async formatted(text, entities = [], { last = {}, image = null } = {}) {
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
      const message = { chat_id: this.chatId, text: part, entities: clipped, link_preview_options: { is_disabled: true }, ...(index === parts.length - 1 ? last : {}) };
      // A rejected photo must never block the review itself.
      if (index === 0 && image) await this.api('sendMessage', { ...message, link_preview_options: { url: image, prefer_large_media: true, show_above_text: true } }).catch(() => this.api('sendMessage', message));
      else await this.api('sendMessage', message);
      offset = end;
    }
  }
  // One message per listing. Only a draft near the 5000-character cap splits it; the draft is never
  // shortened (listing details are, to fit), and the buttons sit on the final part.
  // heading/note: an outcome shown above the listing instead of approval buttons (auto-sent reviews).
  async notify(review, { heading = '', note = '' } = {}) {
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
    append(`\n\n📍 ${address || 'Address unavailable'}`);
    append('\n\n💶 '); append(`${listing.price ?? '?'} €`, 'bold');
    append(`  ·  📐 ${listing.area ?? '?'} m²  ·  🚪 ${listing.rooms ?? '?'} Zi.\n\n`);
    const badges = [listing.published && `🕒 ${listing.published}`, listing.earlyAccess && '🔒 Suchen+'].filter(Boolean).join('  ·  ');
    if (badges) append(`${badges}\n\n`);
    // URLs are built here, never taken from listing data.
    const query = encodeURIComponent(address);
    const links = [
      /^\d+$/.test(review.exposeId) && ['Listing', `https://www.immobilienscout24.de/expose/${review.exposeId}`],
      address && ['Google Maps', `https://www.google.com/maps/search/?api=1&query=${query}`],
      address && ['Apple Maps', `https://maps.apple.com/?q=${query}`],
    ].filter(Boolean);
    const tail = [[review.draft, 'blockquote'], ...(links.length ? [['\n\n']] : []),
      ...links.flatMap(([label, url], index) => [...(index ? [['  ·  ']] : []), [label, 'text_link', { url }]])];
    const detailHeader = '📋 Listing details';
    const details = [listing.description, ...(listing.amenities || []).map(item => `• ${item}`)].filter(Boolean).join('\n\n');
    const room = LIMIT - text.length - tail.reduce((sum, [part]) => sum + part.length, 0) - detailHeader.length - 3;
    if (details && room > 100) {
      let cut = Math.min(details.length, room - 1);
      if (cut < details.length && /[\uD800-\uDBFF]/.test(details[cut - 1])) cut--;
      append(detailHeader, 'bold'); append('\n');
      append(cut < details.length ? `${details.slice(0, cut)}…` : details, 'expandable_blockquote'); append('\n\n');
    }
    for (const [part, type, extra] of tail) append(part, type, extra);
    const image = previewImage(listing.image_url);
    await this.formatted(text, entities, { image, last: heading ? {} : {
      reply_markup: { inline_keyboard: [[{ text: '✅ Send', callback_data: this.callback(review, 'a') }, { text: '✏️ Edit', callback_data: this.callback(review, 'e') }, { text: '✖️ Dismiss', callback_data: this.callback(review, 'd') }]] },
    } });
  }
  async notifyOutcome(review) {
    const text = review.status === 'sent' ? 'IS24 accepted your request.'
      : review.status === 'unknown_outcome' ? 'Submission outcome is uncertain. Check your IS24 messages before taking any further action. The agent will not retry.'
      : 'The message was not sent. No automatic retry will occur.';
    const heading = review.status === 'sent' ? '✅ Message sent' : review.status === 'unknown_outcome' ? '⚠️ Check your IS24 account' : '❌ Message not sent';
    // You never saw an auto-sent listing, so it comes with the full listing and the message.
    if (review.approvedBy === 'auto') return this.notify(review, { heading: `${heading} (auto-send)`, note: `${text}${review.detail ? `\n${review.detail}` : ''}` });
    await this.formatted(`${heading}\n\n${review.snapshot.title}\n\n${text}\n${review.detail || ''}`, [{ type: 'bold', offset: 0, length: heading.length }]);
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
    if (instructions.length > 2000) return this.send('Please keep edit instructions under 2000 characters.');
    this.editPrompts.delete(promptId);
    await this.send('✍️ Revising the draft…');
    // Long-polling continues while the agent works; the revised draft arrives as a new approval message.
    Promise.resolve().then(() => this.workflow.revise(target.id, target.version, instructions))
      .catch(error => this.send(`Could not revise the draft: ${error.message}`).catch(failure => this.onError(failure.message)));
  }
  async handleUpdate(update) {
    if (this.controller.signal.aborted) return;
    if (update.message) return this.handleMessage(update.message);
    const query = update.callback_query;
    if (!query) return;
    let answer = 'This approval is invalid.';
    let accepted = false;
    const owner = this.chatId && query.message?.chat?.type === 'private' && String(query.message.chat.id) === this.chatId && String(query.from?.id) === this.chatId;
    if (owner && /^[ck]:/.test(query.data || '')) {
      try { ({ text: answer, used: accepted = false } = await this.assistant.choice(query.data)); }
      catch (error) { answer = error.message; }
    } else if (owner) {
      const match = /^([ade]):([a-f0-9]{32}):(\d+):([A-Za-z0-9_-]{16})$/.exec(query.data || '');
      if (match) {
        const [, action, rawId, version, supplied] = match;
        const id = `${rawId.slice(0, 8)}-${rawId.slice(8, 12)}-${rawId.slice(12, 16)}-${rawId.slice(16, 20)}-${rawId.slice(20)}`;
        const review = this.store.get(id);
        if (review && review.version !== Number(version)) answer = 'A newer draft replaced this one.';
        else if (review && timingSafeEqual(Buffer.from(supplied), Buffer.from(this.signature(review, action)))) {
          try {
            if (action === 'a') {
              this.workflow.approve(id, review.version, review.draftHash);
              accepted = true;
              answer = 'Approved. The agent will verify and send this exact draft.';
            } else if (action === 'e') {
              if (review.status !== 'awaiting_approval') conflict('Review was already handled');
              // Threaded under the review it edits, so the listing need not be repeated.
              const prompt = await this.send('✏️ What should change?', { reply_parameters: { message_id: query.message.message_id, allow_sending_without_reply: true },
                reply_markup: { force_reply: true, input_field_placeholder: 'e.g. shorter, mention move-in 1 March' } });
              this.editPrompts.set(prompt.message_id, { id, version: review.version });
              this.assistant.asking = null; // The newest prompt wins: the next plain message is this edit.
              answer = 'Reply to the prompt with your changes.';
            } else {
              this.workflow.dismiss(id, review.version);
              accepted = true;
              answer = 'Dismissed. No message will be sent.';
            }
          } catch (error) { answer = error.code === 'CONFLICT' ? error.message : 'The action failed; check the agent logs.'; }
        }
      }
    }
    await this.api('answerCallbackQuery', { callback_query_id: query.id, text: answer });
    // Decided reviews lose their buttons, so old messages cannot be mistaken for open ones.
    if (accepted) await this.api('editMessageReplyMarkup', { chat_id: this.chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
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
