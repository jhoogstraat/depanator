import { createHash } from 'node:crypto';
import { FIELDS } from './settings.js';

const HELP = `/settings – see and change everything
/interval – how often I check for new listings
/autosend – send clear matches without asking
/status – what I have done so far
/login – reconnect your ChatGPT subscription
/connect – reconnect your ImmoScout24 account
/setup – continue the guided setup`;
// Buttons name an option by index plus a short fingerprint, so a stale button never picks a different option.
const fingerprint = label => createHash('sha256').update(String(label)).digest('base64url').slice(0, 4);
const rows = (buttons, perRow) => Array.from({ length: Math.ceil(buttons.length / perRow) }, (_, index) => buttons.slice(index * perRow, index * perRow + perRow));

// The chat side of configuration: guides the owner through setup and changes settings later.
// Which question comes next is derived from the stored settings, so setup resumes after a restart.
export class Assistant {
  constructor({ settings, store, send, codex, is24, onReady = () => {}, onError = () => {} }) {
    Object.assign(this, { settings, store, send, codex, is24, onReady, onError });
    this.asking = null; // Setting key awaiting a typed answer.
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
      await this.send(`✅ All set. I check your search every ${this.settings.display('pollIntervalMs')} and send new matches here. You approve every application; once you trust the drafts, /autosend lets me send clear matches myself.\n\n${HELP}`);
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
    const key = this.asking ?? (this.ready ? null : this.settings.next()?.key);
    if (!key || !this.settings.field(key) || this.settings.choices(key).length) {
      return this.ready ? this.send(`To change something, use /settings.\n\n${HELP}`) : this.continue();
    }
    try { this.settings.set(key, message); } catch (error) { return this.send(`${error.message}\n\n${this.settings.field(key).ask}`); }
    this.asking = null;
    return this.saved(key);
  }
  // Button taps: c:<key>:<index|-> answers a question, k:<key> asks to change a setting.
  // Returns the toast and whether the tap was used up (then its buttons are removed).
  async choice(data) {
    const [kind, key, index, mark] = data.split(':');
    if (kind === 'k') {
      if (!this.settings.field(key)) return { text: 'Unknown setting.' };
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
  async command(name) {
    if (name === '/start' || name === '/setup') {
      if (this.settings.complete()) return this.send(`Setup is complete.\n\n${HELP}`);
      return this.continue();
    }
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
    if (name === '/status') {
      const counts = {};
      for (const review of this.store.list()) counts[review.status] = (counts[review.status] ?? 0) + 1;
      const summary = Object.entries(counts).map(([status, count]) => `${status.replaceAll('_', ' ')}: ${count}`).join('\n') || 'No listings yet.';
      return this.send(`${summary}\n\nChecking every ${this.settings.display('pollIntervalMs')}. Auto-send: ${this.settings.display('autoSend')}.`);
    }
    return this.send(HELP);
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
