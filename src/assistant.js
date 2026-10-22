import { FIELDS, isQuiet } from './settings.js';
import { expandId } from './review.js';
import { MENU_HINT, fingerprint, rows, statusView, waitingView, clearView, sentView, modelView, thinkingView, criteriaLines, criteriaView, promptView, aboutView } from './menu.js';

const STALE = { text: 'These buttons are outdated; open the menu again.' };
const BUSY = 'One moment, I am still on the previous step.';
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The menu's buttons (x:<name>:<arguments>, written by menu.js), run with the Assistant as `this`.
const ACTIONS = {
  async status() { return { text: 'Updated.', edit: await this.statusView() }; },
  async pause() { return { text: this.togglePause() ? '⏸ Paused' : '▶️ Searching again', edit: await this.statusView() }; },
  criteria() { return this.sendView(criteriaView(this.settings.config.preferences)); },
  about() { return this.sendView(aboutView(this.persona())); },
  sent() { return this.sendView(sentView(this.store.list())); },
  // mode 'edit': replace the tapped message (Cancel on the clear confirmation).
  waiting(mode) {
    const view = waitingView(this.store.list('awaiting_approval'));
    return mode === 'edit' ? { text: '', edit: view } : this.sendView(view);
  },
  // Without count: ask to confirm. With it: dismiss exactly the listings that were waiting when confirmed.
  clear(count) {
    const waiting = this.store.list('awaiting_approval');
    if (!waiting.length) return { text: 'Nothing is waiting.', edit: waitingView(waiting) };
    if (!count) return { text: '', edit: clearView(waiting.length) };
    if (Number(count) !== waiting.length) return { text: 'The list changed; check it again.', edit: waitingView(waiting) };
    let cleared = 0;
    for (const review of waiting) { try { this.workflow.dismiss(review.id, review.version); cleared++; } catch (error) { if (error.code !== 'CONFLICT') throw error; } }
    return { text: `Cleared ${cleared}.`, edit: { text: `🧹 Cleared ${plural(cleared, 'waiting listing')}. No messages were sent.`, extra: {} } };
  },
  // Shows a waiting listing again with its buttons.
  async show(compact) {
    const review = /^[a-f0-9]{32}$/.test(compact || '') && this.store.get(expandId(compact));
    if (review?.status !== 'awaiting_approval') return { text: 'This listing is no longer waiting.' };
    await this.redeliver(review);
    return { text: '' };
  },
  // /model step 1: a model was picked, now its thinking level.
  m(index, mark) {
    const model = this.pickedModel(index, mark);
    if (!model) return STALE;
    const { llm } = this.settings.config;
    return { text: '', edit: thinkingView(model, Number(index), llm.model, llm.thinking) };
  },
  // /model step 2: model and thinking level are saved together.
  t(index, level, mark) {
    const model = this.pickedModel(index, mark);
    if (!model?.thinking.includes(level)) return STALE;
    this.settings.set('model', model.id);
    this.settings.set('thinking', level === model.defaultThinking ? '' : level);
    return { text: 'Saved.', edit: { text: `✅ Using ${model.name} · thinking ${level}. Applies to the next listing.`, extra: {} } };
  },
  // Add a criterion: the next typed message is the new line.
  async ca() {
    this.asking = 'criteria+';
    return this.sendView({ text: '➕ Send one more criterion, for example "No ground floor" or "At most 3rd floor without a lift".' });
  },
  // Delete a criterion; the last one stays.
  cd(index, mark) {
    const lines = criteriaLines(this.settings.config.preferences);
    if (lines.length < 2 || !lines[Number(index)] || fingerprint(lines[Number(index)]) !== mark) return STALE;
    lines.splice(Number(index), 1);
    this.settings.set('preferences', lines.join('\n'));
    return { text: 'Removed.', edit: criteriaView(this.settings.config.preferences) };
  },
};

// The chat side of configuration: guides the owner through setup and changes settings later.
// Which question comes next is derived from the stored settings, so setup resumes after a restart.
export class Assistant {
  // workflow: health for /status. redeliver(review) shows a waiting listing again.
  constructor({ settings, store, send, codex, is24, immomio = null, workflow = null, redeliver = async () => {}, onReady = () => {}, onError = () => {} }) {
    Object.assign(this, { settings, store, send, codex, is24, immomio, workflow, redeliver, onReady, onError });
    this.modelCache = null; // { at, list }: the plan's models, read through Codex.
    this.busy = null; // A long step (ChatGPT login, connecting IS24) in progress.
    this.chatgpt = false;
    this.ready = settings.complete(); // "All set" is announced once, when setup completes.
  }
  // Keep typed prompts through a deployment/restart, including an unfinished criterion addition.
  get asking() { return this.store.settings().pendingQuestion ?? null; }
  set asking(value) { this.store.saveSetting('pendingQuestion', value); }
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
      return this.ready ? this.send(`To change something, use the menu. ${MENU_HINT}`) : this.continue();
    }
    try { this.settings.set(key, message); } catch (error) { return this.send(`${error.message}\n\n${this.settings.field(key).ask}`); }
    this.asking = null;
    return this.saved(key);
  }
  // Button taps: c:<key>:<index|-|s> answers a question (a choice, Skip, or the field's shortcut),
  // k:<key> asks to change a setting, x:<action> is a menu action. Returns the toast, whether the tap was
  // used up (then its buttons are removed), and optionally `edit`: a view that replaces the tapped message.
  async choice(data) {
    const [kind, key, index, mark] = data.split(':');
    if (kind === 'x') return this.action(...data.split(':').slice(1));
    const field = this.settings.field(key);
    if (kind === 'k') {
      if (!field) return { text: 'Unknown setting.' };
      if (key === 'model' || key === 'thinking') { await this.modelMenu(); return { text: '' }; }
      await this.ask(key);
      return { text: 'Choose or send the new value.' };
    }
    const values = field && this.answer(field, index, mark);
    if (!values) return STALE;
    for (const [setting, value] of Object.entries(values)) this.settings.set(setting, value);
    if (this.asking === key) this.asking = null;
    await this.saved(key);
    return { text: 'Saved.', used: true };
  }
  // The { setting: value } a question's button stands for; null if the button is outdated.
  answer(field, index, mark) {
    if (index === 's') return field.shortcut?.[1] ?? null;
    if (index === '-') return field.optional ? { [field.key]: '' } : null;
    const choice = this.settings.choices(field.key)[Number(index)];
    return choice && mark === fingerprint(choice[1]) ? { [field.key]: choice[0] } : null;
  }
  show(view) { return this.send(view.text, view.extra); }
  // 🧠 Remember on a draft: one more line of writing style, used for every later draft.
  remember(instruction) {
    const style = [this.settings.config.style, instruction.trim()].filter(Boolean).join('\n');
    if (style.length > 1000) throw new Error('Your writing style is full (1000 characters). Shorten it in /prompt first.');
    this.settings.set('style', style);
  }
  async command(name) {
    if (name === '/start' || name === '/setup') return this.settings.complete() ? this.send(`Setup is complete. ${MENU_HINT}`) : this.continue();
    // Reconnecting works during setup too: setup may be waiting for it.
    if (!this.settings.complete() && !['/connect', '/login'].includes(name)) return this.send('Let us finish the setup first.').then(() => this.continue());
    const longStep = { '/connect': () => this.connectIS24(), '/immomio': () => this.connectImmomio(), '/login': () => this.chatgptLogin() }[name];
    if (longStep) return this.track(longStep, name) ? undefined : this.send(BUSY);
    const commands = {
      '/status': async () => this.show(await this.statusView()),
      '/pause': () => this.send(this.togglePause() ? '⏸ Paused. I stop searching; waiting drafts and sending still work. Send /pause again to resume.' : `▶️ Searching again, every ${this.settings.display('pollIntervalMs')}.`),
      '/criteria': () => this.show(criteriaView(this.settings.config.preferences)),
      '/prompt': () => this.show(this.promptView()),
      '/model': () => this.modelMenu(),
      '/interval': () => this.ask('pollIntervalMs'),
      '/autosend': () => this.ask('autoSend'),
    };
    return Object.hasOwn(commands, name) ? commands[name]() : this.send(`I do not know ${name}. ${MENU_HINT}`);
  }
  // Returns whether searching is now paused.
  togglePause() { return this.settings.set('paused', !this.settings.config.paused); }
  promptView() {
    const about = this.persona().filter(([key]) => this.settings.values[key]).map(([, label, value]) => [label, value]);
    return promptView({ ...this.settings.config, about: [['Email', this.settings.config.accountEmail], ...about] });
  }
  // [[key, label, display]] of every personal detail.
  persona() { return FIELDS.filter(field => field.key.startsWith('persona.')).map(field => [field.key, field.label, this.settings.display(field.key)]); }
  async statusView() {
    const counts = {};
    for (const review of this.store.list()) counts[review.status] = (counts[review.status] ?? 0) + 1;
    const { config } = this.settings;
    // The level the model uses when none is chosen; unknown if the model list cannot be read.
    const modelDefault = config.llm.thinking ? null : await this.models().then(list => list.find(model => model.id === config.llm.model)?.defaultThinking, () => null);
    return statusView({ counts, lastPollAt: this.workflow?.lastPollAt, failures: this.workflow?.failures ?? { IS24: 0, LLM: 0 }, blocked: this.workflow?.backoff.blocked,
      paused: config.paused, interval: this.settings.display('pollIntervalMs'), autoSend: config.autoSend, email: config.accountEmail, immomioEmail: config.immomioEmail, model: config.llm.model, thinking: config.llm.thinking || (modelDefault ? `${modelDefault} (default)` : ''),
      quietHours: config.quietHours, quiet: isQuiet(config.quietHours), chatgpt: this.codex.account?.() ?? {} });
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
  // Menu buttons: x:<name>:<arguments>, see ACTIONS.
  async action(name, ...args) {
    if (!this.settings.complete()) return { text: 'Finish the setup first.' };
    return Object.hasOwn(ACTIONS, name) ? ACTIONS[name].apply(this, args) : STALE;
  }
  // Shows a view as a new message; the tapped one stays.
  async sendView(view) {
    await this.show(view);
    return { text: '' };
  }
  // The model a model-menu button names, if the cached list still has it at that index.
  pickedModel(index, mark) {
    const model = this.modelCache?.list[Number(index)];
    return model && fingerprint(model.id) === mark ? model : null;
  }
  async chatgptLogin() {
    await this.send('First, connect your ChatGPT subscription. It reviews listings and writes your applications.');
    await this.codex.login({ onCode: ({ url, code }) => this.send(`1. Open ${url}\n2. Sign in to ChatGPT\n3. Enter this code: ${code}\n\nThe code expires in 15 minutes. If ChatGPT asks, allow device code login in its security settings.`).catch(error => this.onError(error.message)) });
    this.chatgpt = true;
    await this.send('✅ ChatGPT connected.');
  }
  async connectImmomio() {
    const email = await this.immomio.connect();
    await this.send(`✅ Connected to Immomio as ${email}. When a listing's IS24 description links to an Immomio application, I apply there with your Immomio profile once you approve. Keep that profile complete on tenant.immomio.com.`);
  }
  // Sends the "Connect ImmoScout24" button and waits until the owner connected the account there.
  async connectIS24() {
    const email = await this.is24.connect();
    await this.send(`✅ Connected to ImmoScout24 as ${email}.`);
  }
}
