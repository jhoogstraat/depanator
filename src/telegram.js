import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

function chunks(text, limit = 3500) {
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

export class Telegram {
  constructor({ config, store, bindings, onApproved, fetchImpl = fetch, onError = () => {} }) {
    Object.assign(this, { config, store, bindings, onApproved, fetchImpl, onError });
    this.chatId = String(config.notification.chatId);
    this.token = config.telegramBotToken;
    this.offsetFile = join(config.dataDir, 'telegram-offset.json');
    this.offset = 0;
    try { this.offset = JSON.parse(readFileSync(this.offsetFile, 'utf8')).offset || 0; } catch (error) { if (error.code !== 'ENOENT') throw new Error('Telegram update offset is unreadable'); }
    this.controller = new AbortController();
    this.loop = null;
  }
  async api(method, body, signal = AbortSignal.timeout(30_000)) {
    // Never include the token-bearing URL or response body in errors/logs.
    let response;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
      });
    } catch { throw new Error(`Telegram ${method} network request failed`); }
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
  async formatted(text, entities = []) {
    let offset = 0;
    for (const part of chunks(text)) {
      const end = offset + part.length;
      const clipped = entities.flatMap(entity => {
        const start = Math.max(offset, entity.offset);
        const stop = Math.min(end, entity.offset + entity.length);
        return stop > start ? [{ ...entity, offset: start - offset, length: stop - start }] : [];
      });
      // Native entities preserve literal listing/draft text. No markup from
      // untrusted content can become formatting, links, or hidden instructions.
      await this.api('sendMessage', { chat_id: this.chatId, text: part, entities: clipped, link_preview_options: { is_disabled: true } });
      offset = end;
    }
  }
  async notify(review) {
    const listing = review.snapshot;
    let facts = '';
    const entities = [];
    const append = (text, type, extra = {}) => {
      if (type) entities.push({ type, offset: facts.length, length: text.length, ...extra });
      facts += text;
    };
    append('🏡 New apartment match', 'bold'); append('\n\n');
    const safeLink = /^\d+$/.test(review.exposeId) ? `https://www.immobilienscout24.de/expose/${review.exposeId}` : null;
    append(String(listing.title), safeLink ? 'text_link' : 'bold', safeLink ? { url: safeLink } : {});
    append(`\n📍 ${listing.address || 'Address unavailable'}\n\n`);
    append('💶 Rent', 'bold'); append(`: €${listing.price ?? '?'} / month\n`);
    append('📐 Size', 'bold'); append(`: ${listing.area ?? '?'} m²  ·  ${listing.rooms ?? '?'} rooms\n\n`);
    append('🧠 Why it matches', 'bold'); append(`\n${review.reasons.map(reason => `• ${reason}`).join('\n')}\n\n`);
    append('👤 Sending account', 'bold'); append(`: ${this.config.accountEmail}\n`);
    append('⏳ Approval expires', 'bold'); append(`: ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(review.expiresAt)} (Berlin)\n`);
    await this.formatted(facts, entities);
    const detailHeader = '📋 Listing details\n\n';
    const detailText = [listing.description, ...(listing.amenities || []).map(item => `• ${item}`)].filter(Boolean).join('\n\n');
    if (detailText) await this.formatted(detailHeader + detailText, [
      { type: 'bold', offset: 0, length: detailHeader.trim().length },
      { type: 'expandable_blockquote', offset: detailHeader.length, length: detailText.length },
    ]);
    const draftHeader = 'Exact draft for your approval:\n\n';
    await this.formatted(draftHeader + review.draft, [
      { type: 'bold', offset: 0, length: draftHeader.trim().length },
      { type: 'blockquote', offset: draftHeader.length, length: review.draft.length },
    ]);
    // Buttons follow every part of the full exact draft, never a truncated preview.
    await this.api('sendMessage', {
      chat_id: this.chatId, text: `Send this exact draft?\n${String(listing.title).slice(0, 200)}\n\nReview ${review.id} · version ${review.version}`,
      entities: [{ type: 'bold', offset: 0, length: 'Send this exact draft?'.length }],
      reply_markup: { inline_keyboard: [[{ text: '✅ Approve & send', callback_data: this.callback(review, 'a') }, { text: '✖️ Dismiss', callback_data: this.callback(review, 'd') }]] },
    });
  }
  async notifyOutcome(review) {
    const text = review.status === 'sent' ? 'Message sent and confirmed.'
      : review.status === 'unknown_outcome' ? 'Submission outcome is uncertain. Check your IS24 messages before taking any further action. The agent will not retry.'
      : 'The message was not sent. No automatic retry will occur.';
    const heading = review.status === 'sent' ? '✅ Message sent' : review.status === 'unknown_outcome' ? '⚠️ Check your IS24 account' : '❌ Message not sent';
    await this.formatted(`${heading}\n\n${review.snapshot.title}\n\n${text}\n${review.detail || ''}`, [{ type: 'bold', offset: 0, length: heading.length }]);
  }
  async handleUpdate(update) {
    if (this.controller.signal.aborted) return;
    const query = update.callback_query;
    if (!query) return;
    let answer = 'This approval is invalid or expired.';
    if (query.message?.chat?.type === 'private' && String(query.message.chat.id) === this.chatId && String(query.from?.id) === this.chatId) {
      const match = /^([ad]):([a-f0-9]{32}):(\d+):([A-Za-z0-9_-]{16})$/.exec(query.data || '');
      if (match) {
        const [, action, rawId, version, supplied] = match;
        const id = `${rawId.slice(0, 8)}-${rawId.slice(8, 12)}-${rawId.slice(12, 16)}-${rawId.slice(16, 20)}-${rawId.slice(20)}`;
        const review = this.store.get(id);
        if (review && review.version === Number(version) && timingSafeEqual(Buffer.from(supplied), Buffer.from(this.signature(review, action)))) {
          try {
            if (action === 'a') {
              this.store.approve(id, { version: review.version, draftHash: review.draftHash, ...this.bindings() });
              answer = 'Approved. The agent will verify and send this exact draft.';
              Promise.resolve().then(() => this.onApproved()).catch(error => this.onError(error.message));
            } else {
              this.store.dismiss(id, { version: review.version });
              answer = 'Dismissed. No message will be sent.';
            }
          } catch (error) { answer = error.code === 'CONFLICT' ? 'This review was already handled, changed, or expired.' : 'The action failed; check the agent terminal.'; }
        }
      }
    }
    await this.api('answerCallbackQuery', { callback_query_id: query.id, text: answer });
  }
  saveOffset(offset) {
    const temp = `${this.offsetFile}.tmp`;
    writeFileSync(temp, JSON.stringify({ offset }), { mode: 0o600 });
    renameSync(temp, this.offsetFile);
    this.offset = offset;
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
        const updates = await this.api('getUpdates', { offset: this.offset, timeout: 20, allowed_updates: ['callback_query'] }, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
        for (const update of updates) {
          if (signal.aborted) break;
          await this.handleUpdate(update);
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
