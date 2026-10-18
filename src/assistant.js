import { FIELDS } from './settings.js';
import { MENU_HINT, fingerprint, rows, statusView, waitingView, clearView, sentView, modelView, thinkingView, criteriaLines, criteriaView, promptView, aboutView } from './menu.js';

const stale = { text: 'These buttons are outdated; open the menu again.' };
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The chat side of configuration: guides the owner through setup and changes settings later.
// Which question comes next is derived from the stored settings, so setup resumes after a restart.
export class Assistant {
  // workflow: health for /status. check() runs a search now. redeliver(review) shows a waiting listing again.
  constructor({ settings, store, send, codex, is24, workflow = null, check = async () => {}, redeliver = async () => {}, onReady = () => {}, onError = () => {} }) {
    Object.assign(this, { settings, store, send, codex, is24, workflow, check, redeliver, onReady, onError });
    this.asking = null; // Setting key (or 'criteria+') awaiting a typed answer.
    this.modelCache = null; // { at, list }: the plan's models, read through Codex.
    this.busy = null; // A long step (ChatGPT login, connecting IS24) in progress.
    this.chatgpt = false;
    this.ready = settings.complete(); // "All set" is announced once, when setup completes.
  }
  // Ask the next setup question, start a long step, or announce that setup is done.
  async continue() {
    if (this.busy) return;
    if (!this.chatgpt) return this.track(async () => { this.chatgpt = await this.codex.loggedIn(); if (!this.chatgpt) await this.chatgptLogin(); });
    const field = this.settings.next();
    if (!field) {
      if (this.ready) return;
      this.ready = true;
      await this.send(`✅ All set. I check your search every ${this.settings.display('pollIntervalMs')} and send new matches here. You approve every application; once you trust the drafts, /autosend lets me send clear matches myself.\n\n${MENU_HINT}`);
      return this.onReady();
    }
    if (field.key === 'is24') return this.track(() => this.connectIS24());
    return this.ask(field.key);
  }
  // After a restart: resume a long step, but do not repeat a question that is still open in the chat
  // (its buttons and a typed answer keep working). /setup asks it again on request.
  async resume() {
    if (!this.chatgpt) this.chatgpt = await this.codex.loggedIn().catch(() => false);
    const field = this.settings.next();
    if (this.chatgpt && field && field.key !== 'is24') return;
    return this.continue();
  }
  // Long steps run one at a time beside the chat; Telegram keeps answering meanwhile. False if one is running.
  track(step, retry = '/setup') {
    if (this.busy) return false;
    this.busy = (async () => {
      try { await step(); } catch (error) { await this.send(`⚠️ ${error.message}\nSend ${retry} to try again.`); return false; }
      return true;
    })().then(ok => { this.busy = null; if (ok) return this.continue(); }).catch(error => { this.busy = null; this.onError(error.message); });
    return true;
  }
  async ask(key) {
    const field = this.settings.field(key);
    const choices = this.settings.choices(key);
    this.asking = choices.length ? null : key;
    const buttons = [...choices.map(([, label], index) => ({ text: label, callback_data: `c:${key}:${index}:${fingerprint(label)}` })), ...(field.optional ? [{ text: 'Skip', callback_data: `c:${key}:-` }] : []),
      ...(field.shortcut ? [{ text: field.shortcut[0], callback_data: `c:${key}:s` }] : [])];
    const current = this.settings.values[key] !== undefined ? `\n\nCurrently: ${this.settings.display(key)}` : '';
    await this.send(`${field.ask}${current}`, buttons.length ? { reply_markup: { inline_keyboard: rows(buttons, choices.length > 4 || choices.some(([, label]) => label.length > 14) ? 1 : 3) } } : {});
  }
  async saved(key) {
    if (this.ready && this.settings.complete()) return this.send(`Saved: ${this.settings.field(key)?.label ?? key} = ${this.settings.display(key)}`);
    return this.continue(); // During setup: the next question, or "All set" after the last one.
  }
  // A typed message that is not a command or a draft edit.
  async text(message) {
    if (this.busy) return this.send('One moment, I am still on the previous step.');
    if (this.asking === 'criteria+') {
      this.asking = null;
      try { this.settings.set('preferences', [...criteriaLines(this.settings.config.preferences), message.trim()].join('\n')); } catch (error) { return this.send(error.message); }
      return this.show(criteriaView(this.settings.config.preferences));
    }
    const key = this.asking ?? (this.ready ? null : this.settings.next()?.key);
    if (!key || !this.settings.field(key) || this.settings.choices(key).length) {
      return this.ready ? this.send(`To change something, use /settings. ${MENU_HINT}`) : this.continue();
    }
    try { this.settings.set(key, message); } catch (error) { return this.send(`${error.message}\n\n${this.settings.field(key).ask}`); }
    this.asking = null;
    return this.saved(key);
  }
  // Button taps: c:<key>:<index|-> answers a question, k:<key> asks to change a setting, x:<action> is a
  // menu action. Returns the toast, whether the tap was used up (then its buttons are removed), and
  // optionally `edit`: a view that replaces the tapped message.
  async choice(data) {
    const [kind, key, index, mark] = data.split(':');
    if (kind === 'x') return this.action(...data.split(':').slice(1));
    if (kind === 'k') {
      if (!this.settings.field(key)) return { text: 'Unknown setting.' };
      if (key === 'model' || key === 'thinking') { await this.modelMenu(); return { text: '' }; }
      await this.ask(key);
      return { text: 'Choose or send the new value.' };
    }
    const shortcut = index === 's' && this.settings.field(key)?.shortcut;
    if (shortcut) {
      for (const [setting, value] of Object.entries(shortcut[1])) this.settings.set(setting, value);
      if (this.asking === key) this.asking = null;
      await this.saved(key);
      return { text: 'Saved.', used: true };
    }
    const choices = this.settings.choices(key);
    const choice = choices[Number(index)];
    const value = index === '-' && this.settings.field(key)?.optional ? '' : choice && mark === fingerprint(choice[1]) ? choice[0] : undefined;
    if (!this.settings.field(key) || value === undefined) return { text: 'These buttons are outdated; use /settings.' };
    this.settings.set(key, value);
    if (this.asking === key) this.asking = null;
    await this.saved(key);
    return { text: 'Saved.', used: true };
  }
  show(view) { return this.send(view.text, view.extra); }
  async command(name) {
    if (name === '/start' || name === '/setup') {
      if (this.settings.complete()) return this.send(`Setup is complete. ${MENU_HINT}`);
      return this.continue();
    }
    if (!this.settings.complete() && !['/settings', '/connect', '/login'].includes(name)) return this.send('Let us finish the setup first.').then(() => this.continue());
    if (name === '/status') return this.show(this.statusView());
    if (name === '/pause') {
      const paused = this.settings.set('paused', !this.settings.config.paused);
      return this.send(paused ? '⏸ Paused. I stop searching; waiting drafts and sending still work. Send /pause again to resume.' : '▶️ Searching again, every ' + this.settings.display('pollIntervalMs') + '. /status → 🔎 Search now checks right away.');
    }
    if (name === '/criteria') return this.show(criteriaView(this.settings.config.preferences));
    if (name === '/prompt') {
      const about = this.persona().filter(([key]) => this.settings.values[key]).map(([, label, value]) => [label, value]);
      return this.show(promptView({ ...this.settings.config, about: [['Email', this.settings.config.accountEmail], ...about] }));
    }
    if (name === '/model') return this.modelMenu();
    if (name === '/settings') {
      const lines = FIELDS.map(field => `${field.label}: ${this.settings.display(field.key)}`);
      const buttons = FIELDS.map(field => ({ text: field.label, callback_data: `k:${field.key}` }));
      return this.send(`ImmoScout24 account: ${this.settings.config.accountEmail || 'not connected'}\n${lines.join('\n')}\n\nTap what you want to change:`, { reply_markup: { inline_keyboard: rows(buttons, 2) } });
    }
    if (name === '/interval') return this.ask('pollIntervalMs');
    if (name === '/autosend') return this.ask('autoSend');
    if (name === '/connect') {
      if (this.track(() => this.connectIS24(), '/connect')) return;
      return this.send('One moment, I am still on the previous step.');
    }
    if (name === '/login') {
      if (this.track(() => this.chatgptLogin(), '/login')) return;
      return this.send('One moment, I am still on the previous step.');
    }
    return this.send(`I do not know ${name}. ${MENU_HINT}`);
  }
  // [[key, label, display]] of every personal detail.
  persona() { return FIELDS.filter(field => field.key.startsWith('persona.')).map(field => [field.key, field.label, this.settings.display(field.key)]); }
  statusView() {
    const counts = {};
    for (const review of this.store.list()) counts[review.status] = (counts[review.status] ?? 0) + 1;
    const { config } = this.settings;
    return statusView({ counts, lastPollAt: this.workflow?.lastPollAt, failures: this.workflow?.failures ?? { IS24: 0, LLM: 0 }, blocked: this.workflow?.backoff.blocked,
      paused: config.paused, interval: this.settings.display('pollIntervalMs'), autoSend: config.autoSend, email: config.accountEmail, model: config.llm.model, thinking: config.llm.thinking });
  }
  // ponytail: 10-minute cache; plans rarely change their models more often.
  async models() {
    if (!this.modelCache || Date.now() - this.modelCache.at > 600_000) this.modelCache = { at: Date.now(), list: await this.codex.models() };
    return this.modelCache.list;
  }
  async modelMenu() {
    let list;
    try { list = await this.models(); } catch (error) { await this.send(`⚠️ I could not read your plan's models (${error.message}).`); return this.ask('model'); }
    return this.show(modelView(list, this.settings.config.llm.model, this.settings.config.llm.thinking));
  }
  async searchNow() {
    const before = this.store.count();
    const result = await this.check();
    if (result?.error) return this.send(`⚠️ The search failed: ${result.error}`);
    if (result?.skipped) return this.send('⏳ IS24 is blocking me right now. I back off and try again on my own.');
    const found = this.store.count() - before;
    return this.send(found ? `🔎 Done: ${plural(found, 'new listing')}. Matches arrive as separate messages.` : '🔎 Done: no new listings.');
  }
  // Menu buttons (x:<name>:<args>), see menu.js.
  async action(name, a, b, c) {
    const { config } = this.settings;
    if (!this.settings.complete()) return { text: 'Finish the setup first.' };
    if (name === 'status') return { text: 'Updated.', edit: this.statusView() };
    if (name === 'pause') {
      const paused = this.settings.set('paused', !config.paused);
      return { text: paused ? '⏸ Paused' : '▶️ Searching again', edit: this.statusView() };
    }
    if (name === 'check') {
      this.searchNow().catch(error => this.onError(error.message));
      return { text: '🔎 Searching…' };
    }
    if (name === 'criteria') { await this.show(criteriaView(config.preferences)); return { text: '' }; }
    if (name === 'about') { await this.show(aboutView(this.persona())); return { text: '' }; }
    if (name === 'waiting') {
      const view = waitingView(this.store.list('awaiting_approval'));
      if (a === 'edit') return { text: '', edit: view };
      await this.show(view);
      return { text: '' };
    }
    if (name === 'clear') {
      const waiting = this.store.list('awaiting_approval');
      if (!waiting.length) return { text: 'Nothing is waiting.', edit: waitingView(waiting) };
      if (!a) return { text: '', edit: clearView(waiting.length) };
      // Only the listings that were waiting when you confirmed; a listing that arrived since stays.
      if (Number(a) !== waiting.length) return { text: 'The list changed; check it again.', edit: waitingView(waiting) };
      let cleared = 0;
      for (const review of waiting) { try { this.workflow.dismiss(review.id, review.version); cleared++; } catch (error) { if (error.code !== 'CONFLICT') throw error; } }
      return { text: `Cleared ${cleared}.`, edit: { text: `🧹 Cleared ${plural(cleared, 'waiting listing')}. No messages were sent.`, extra: {} } };
    }
    if (name === 'sent') { await this.show(sentView(this.store.list())); return { text: '' }; }
    if (name === 'show') {
      const review = /^[a-f0-9]{32}$/.test(a || '') && this.store.get(a.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-'));
      if (review?.status !== 'awaiting_approval') return { text: 'This listing is no longer waiting.' };
      await this.redeliver(review);
      return { text: '' };
    }
    if (name === 'm' || name === 't') {
      const model = this.modelCache?.list[Number(a)];
      if (!model || fingerprint(model.id) !== (name === 'm' ? b : c)) return stale;
      if (name === 'm') return { text: '', edit: thinkingView(model, Number(a), config.llm.model, config.llm.thinking) };
      if (!model.thinking.includes(b)) return stale;
      this.settings.set('model', model.id);
      this.settings.set('thinking', b === model.defaultThinking ? '' : b);
      return { text: 'Saved.', edit: { text: `✅ Using ${model.name} · thinking ${b}. Applies to the next listing.`, extra: {} } };
    }
    if (name === 'ca') {
      this.asking = 'criteria+';
      await this.send('➕ Send one more criterion, for example "No ground floor" or "At most 3rd floor without a lift".');
      return { text: '' };
    }
    if (name === 'cd') {
      const lines = criteriaLines(config.preferences);
      if (lines.length < 2 || !lines[Number(a)] || fingerprint(lines[Number(a)]) !== b) return stale;
      lines.splice(Number(a), 1);
      this.settings.set('preferences', lines.join('\n'));
      return { text: 'Removed.', edit: criteriaView(config.preferences) };
    }
    return stale;
  }
  async chatgptLogin() {
    await this.send('First, connect your ChatGPT subscription. It reviews listings and writes your applications.');
    await this.codex.login({ onCode: ({ url, code }) => this.send(`1. Open ${url}\n2. Sign in to ChatGPT\n3. Enter this code: ${code}\n\nThe code expires in 15 minutes. If ChatGPT asks, allow device code login in its security settings.`).catch(error => this.onError(error.message)) });
    this.chatgpt = true;
    await this.send('✅ ChatGPT connected.');
  }
  // Sends the "Connect ImmoScout24" button and waits until the owner connected the account there.
  async connectIS24() {
    const email = await this.is24.connect();
    await this.send(`✅ Connected to ImmoScout24 as ${email}.`);
  }
}
