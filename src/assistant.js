import { DEFAULT_LLM, INTERVALS, NIGHT_PAUSES, allQuiet, isQuiet, pickedSearches } from './settings.js';
import { expandId } from './review.js';
import { MENU_HINT, plural, fingerprint, fit, statusView, waitingView, clearView, sentView, modelView, thinkingView, requirementsView, searchesView, searchAddedView, searchView, scheduleView, removeSearchView, catalogView, adminView, styleView, aboutView, settingsView, usersView, removeUserView } from './menu.js';

const STALE = { text: 'Diese Buttons sind veraltet; sende /settings für neue.' };
const BUSY = 'Einen Moment, ich bin noch beim vorherigen Schritt.';
const RECONNECT = { '/connect': 'connectIS24', '/immomio': 'connectImmomio', '/login': 'chatgptLogin' };
// Buttons that work during setup, which includes choosing searches.
const SETUP_ACTIONS = ['searches', 'catalog', 'st', 'sd', 'sa', 'se', 'si', 'sq', 'sn', 'su', 'sr', 'cancel'];
// Buttons only the admin's chat has.
const ADMIN_ACTIONS = ['admin', 'users', 'invite', 'rm', 'model', 'm', 't', 'sa', 'se', 'si', 'sq', 'sn', 'su', 'sr'];
// What a setup form is for, with its button.
const FORM_INTRO = {
  search: ['🔍 Was suchst du? Trag Miete, Zimmer und Wohnfläche ein und beschreib im AI-Filter in eigenen Worten, worauf es dir sonst ankommt.', '✏️ Suche ausfüllen'],
  profile: ['👤 Jetzt zu dir, für deine Bewerbungen: deine Kontaktdaten für das IS24-Formular und ein paar Worte über dich für ChatGPT.', '✏️ Über dich ausfüllen'],
};

// What the chat waits for: the next plain message answers it. One question at a time; asking anything new
// replaces the open one, and answering or cancelling closes it. Saved, so it stays open through a restart.
//   null                                         nothing open: during setup the next setup question takes a
//                                                typed answer, otherwise a plain message opens the settings
//   { kind: 'setting', key }                     a typed value for that setting
//   { kind: 'newSearch' }                        "<name> <link>" of a search for the admin's list
//   { kind: 'renameSearch', name }               a new name for that search
//   { kind: 'relinkSearch', name }               a new link for that search
//   { kind: 'edit', id, version, mode, prompt }  how to rewrite a draft (mode 'ai') or the message itself
//                                                ('manual'); prompt: the question's message_id. Telegram answers it.
const ADMIN_QUESTIONS = ['newSearch', 'renameSearch', 'relinkSearch'];
// Before, the open question was one string: a setting key, search+, search~<name> or search@<name>.
function savedQuestion(value) {
  if (typeof value !== 'string') return value ?? null;
  if (value === 'search+') return { kind: 'newSearch' };
  const [, sign, name] = /^search([~@])(.*)$/s.exec(value) ?? [];
  if (sign) return { kind: sign === '~' ? 'renameSearch' : 'relinkSearch', name };
  return { kind: 'setting', key: value };
}
// How a typed message answers each kind of question, run with the Assistant as `this`.
const ANSWERS = {
  setting({ key }, message) {
    try { this.settings.set(key, message); } catch (error) { return this.send(`${error.message}\n\n${this.settings.field(key).ask}`); }
    this.awaiting = null;
    return this.saved(key);
  },
  newSearch(question, message) {
    const [, name, url] = /^(.{1,40}?)\s+(https:\/\/\S+)$/.exec(message.trim()) ?? [];
    if (!name) return this.send('Bitte sende einen Namen mit höchstens 40 Zeichen und dann den Link, zum Beispiel: Berlin https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten');
    return this.changeSearches(async () => searchAddedView(name, await this.admin.addSearch(name, url)));
  },
  renameSearch({ name }, message) { return this.changeSearches(() => this.admin.renameSearch(name, message.trim())); },
  relinkSearch({ name }, message) { return this.changeSearches(async () => searchAddedView(name, await this.admin.changeSearchUrl(name, message.trim()))); },
};

// The menu's buttons (x:<name>:<arguments>, written by menu.js), run with the Assistant as `this`.
// Moving through the menus edits the tapped message (navigate), so the chat keeps one menu; /commands start a new one.
const navigate = view => ({ text: '', edit: view });
// Under a question that waits for a typed answer.
const CANCEL = { reply_markup: { inline_keyboard: [[{ text: 'Abbrechen', callback_data: 'x:cancel' }]] } };
const ACTIONS = {
  async status() { return navigate(await this.statusView()); },
  // ✖️ Close on a root menu: the menu message is deleted.
  close() { return { text: '', close: true }; },
  async pause() { return { text: this.togglePause() ? '⏸ Pausiert' : '▶️ Suche läuft wieder', edit: await this.statusView() }; },
  requirements() { return navigate(this.requirementsView()); },
  settings() { return navigate(this.settingsView()); },
  style() { return navigate(this.styleView()); },
  // 📤 switches at once; the settings show what it means now.
  autosend() {
    const on = this.settings.set('autoSend', !this.settings.config.autoSend);
    return { text: on ? '📤 Auto-Senden an' : '📤 Auto-Senden aus', edit: this.settingsView() };
  },
  // Step 1 of the 🧠 Model menu (admin only): the one model that screens and writes for everyone.
  async model() {
    let list;
    try { list = await this.models(); } catch (error) { return { text: `⚠️ Ich konnte die Modelle des Abos nicht lesen (${error.message}).` }; }
    const { model, thinking } = this.llm();
    return navigate(modelView(list, model, thinking));
  },
  // Cancel on a question that waits for a typed answer (a search's name or link): back to the searches.
  cancel() {
    this.awaiting = null;
    return { text: 'Abgebrochen.', edit: this.searchList() };
  },
  // 🗑 Remove: the writing style and its example.
  clearStyle() {
    for (const key of ['style', 'style.example']) if (this.settings.values[key]) this.settings.set(key, '');
    return { text: 'Entfernt.', edit: this.styleView() };
  },
  reconnect(command) {
    if (!Object.hasOwn(RECONNECT, command)) return STALE;
    return { text: this.reconnect(command) ? '' : BUSY };
  },
  about() { return navigate(this.aboutView()); },
  sent() { return navigate(sentView(this.store.list())); },
  waiting() { return navigate(waitingView(this.store.list('awaiting_approval'))); },
  // Without count: ask to confirm. With it: dismiss exactly the listings that were waiting when confirmed.
  clear(count) {
    const waiting = this.store.list('awaiting_approval');
    if (!waiting.length) return { text: 'Es wartet nichts.', edit: waitingView(waiting) };
    if (!count) return { text: '', edit: clearView(waiting.length) };
    if (Number(count) !== waiting.length) return { text: 'Die Liste hat sich geändert; sieh sie dir noch einmal an.', edit: waitingView(waiting) };
    let cleared = 0;
    for (const review of waiting) { try { this.workflow.dismiss(review.id, review.version); cleared++; } catch (error) { if (error.code !== 'CONFLICT') throw error; } }
    return { text: `🧹 ${plural(cleared, 'wartendes Inserat', 'wartende Inserate')} verworfen. Es wurden keine Nachrichten gesendet.`, edit: waitingView(this.store.list('awaiting_approval')) };
  },
  // Shows a waiting listing again with its buttons.
  async show(compact) {
    const review = /^[a-f0-9]{32}$/.test(compact || '') && this.store.get(expandId(compact));
    if (review?.status !== 'awaiting_approval') return { text: 'Dieses Inserat wartet nicht mehr.' };
    await this.redeliver(review);
    return { text: '' };
  },
  // Model menu step 1: a model was picked, now its thinking level.
  m(index, mark) {
    const model = this.pickedModel(index, mark);
    if (!model) return STALE;
    const { model: current, thinking } = this.llm();
    return { text: '', edit: thinkingView(model, Number(index), current, thinking) };
  },
  // Model menu step 2: model and thinking level are saved together.
  t(index, level, mark) {
    const model = this.pickedModel(index, mark);
    if (!model?.thinking.includes(level)) return STALE;
    const thinking = level === model.defaultThinking ? '' : level;
    this.admin.setLlm({ model: model.id, thinking });
    return { text: `✅ ${model.name} · Denken ${level}. Prüft und schreibt ab jetzt für alle.`, edit: modelView(this.modelCache.list, model.id, thinking) };
  },
  admin() { return navigate(adminView()); },
  // 🛠 Admin → 🔎 Manage searches; during setup, the list the admin adds the first ones to.
  catalog() { return navigate(this.searchList()); },
  users() { return navigate(usersView(this.admin.users())); },
  invite() {
    return this.sendView({ text: `🔗 Schick diesen Link der Person, die du einladen möchtest. Er funktioniert einmal, innerhalb von 24 Stunden, und öffnet ihren eigenen privaten Chat mit mir:\n${this.admin.invite()}` });
  },
  // Without sure: ask to confirm.
  async rm(id, sure) {
    if (!sure) return { text: '', edit: removeUserView(id) };
    await this.admin.remove(id);
    return { text: 'Entfernt.', edit: usersView(this.admin.users()) };
  },
  searches() { return navigate(this.searchesView()); },
  // Pick or unpick a search.
  st(index, mark) {
    const search = this.pickedSearch(index, mark);
    if (!search) return STALE;
    const { searches } = this.settings.config;
    this.settings.assign('searches', searches.includes(search.name) ? searches.filter(name => name !== search.name) : [...searches, search.name]);
    return { text: '', edit: this.searchesView() };
  },
  // Done (during setup) or ← Search: each tap already saved its pick.
  async sd() {
    if (!this.settings.config.searches.length) return { text: 'Wähle mindestens eine Suche.' };
    if (this.settings.complete()) return navigate(this.requirementsView());
    await this.saved('searches');
    return { text: 'Gespeichert.', used: true };
  },
  // Add a search to the shared list: the next typed message names it.
  async sa() {
    this.awaiting = { kind: 'newSearch' };
    return this.sendView({ extra: CANCEL, text: 'Stell auf immobilienscout24.de das Gebiet und eventuelle Filter ein und sende dann einen Namen und die Adresse der Ergebnisseite, zum Beispiel:\nBerlin https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten\n\nJede Suche kostet pro Prüfung eine Anfrage mehr, und alle können sie wählen. Miete, Zimmer und Wohnfläche jeder Person werden auf die Ergebnisse angewendet; lass sie also aus dem Link heraus, außer sie gelten für alle.' });
  },
  // One search of the list: rename or remove it.
  se(index, mark) {
    const search = this.pickedSearch(index, mark);
    if (!search) return STALE;
    return { text: '', edit: searchView(search, index, this.using(search.name)) };
  },
  // How often a search runs (si) and when it pauses (sq). Without choice: the options.
  si(index, mark, choice) { return this.schedule('si', index, mark, choice); },
  sq(index, mark, choice) { return this.schedule('sq', index, mark, choice); },
  // Rename a search: the next typed message is its new name.
  async sn(index, mark) {
    const search = this.pickedSearch(index, mark);
    if (!search) return STALE;
    this.awaiting = { kind: 'renameSearch', name: search.name };
    return this.sendView({ extra: CANCEL, text: `✏️ Sende den neuen Namen für ${search.name}, höchstens 40 Zeichen. Alle, die sie gewählt haben, behalten sie.` });
  },
  // Change a search's link: the next typed message is its new address.
  async su(index, mark) {
    const search = this.pickedSearch(index, mark);
    if (!search) return STALE;
    this.awaiting = { kind: 'relinkSearch', name: search.name };
    return this.sendView({ extra: CANCEL, text: `🔗 Sende die neue Adresse der IS24-Ergebnisseite für ${search.name}. Ich probiere sie einmal aus, bevor ich sie speichere; Name, Zeitplan und alle, die sie gewählt haben, bleiben.\n\nJetzt: ${search.url}` });
  },
  // Without sure: ask to confirm.
  async sr(index, mark, sure) {
    const search = this.pickedSearch(index, mark);
    if (!search) return STALE;
    if (!sure) return { text: '', edit: removeSearchView(search, index, this.using(search.name)) };
    await this.admin.removeSearch(search.name);
    return { text: 'Entfernt.', edit: this.searchList() };
  },
};

// The chat side of configuration: guides one person through setup and changes settings later.
// Which question comes next is derived from the stored settings, so setup resumes after a restart.
export class Assistant {
  // workflow: health for /status. redeliver(review) shows a waiting listing again.
  // admin: Users#adminActions() (people, the searches everyone picks from, the models) for the person running the
  // agent, null for everyone else. catalog() -> the admin's [{ name, url }].
  // feedStatus(search) -> { crawledAt, failures, blocked } of one search's crawler.
  constructor({ settings, store, send, codex, is24, immomio = null, workflow = null, admin = null, catalog = () => [], feedStatus = () => ({}), redeliver = async () => {}, onReady = () => {}, onError = () => {},
    llm = () => DEFAULT_LLM }) {
    // llm() -> { model, thinking }: the one model the admin set for everyone.
    Object.assign(this, { settings, store, send, codex, is24, immomio, workflow, admin, catalog, feedStatus, redeliver, onReady, onError, llm });
    this.modelCache = null; // { at, list }: the plan's models, read through Codex.
    this.busy = null; // A long step (ChatGPT login, connecting IS24) in progress.
    this.chatgpt = false;
    this.ready = settings.complete(); // "All set" is announced once, when setup completes.
  }
  // The open question, see ANSWERS.
  get awaiting() { return savedQuestion(this.store.settings().pendingQuestion); }
  set awaiting(question) { this.store.saveSetting('pendingQuestion', question); }
  // Ask the next setup question, start a long step, or announce that setup is done.
  async continue() {
    if (this.busy) return;
    if (!this.chatgpt) return this.track(async () => { this.chatgpt = await this.codex.loggedIn(); if (!this.chatgpt) await this.chatgptLogin(); });
    const field = this.settings.next();
    if (!field) {
      if (this.ready) return;
      this.ready = true;
      await this.send(`✅ Alles eingerichtet. Ich prüfe deine Suchen wie unter 🔍 Suche → 🔎 Suchen angezeigt und schicke neue Treffer hierher. Du gibst jede Bewerbung frei; sobald du den Entwürfen vertraust, kann ich mit 📤 Auto-Senden in /settings eindeutige Treffer selbst senden.\n\n${MENU_HINT}`);
      return this.onReady();
    }
    if (field.key === 'is24') return this.track(() => this.connectIS24());
    if (field.key === 'searches') return this.show(this.searchesView());
    if (field.key === 'form') {
      const [intro, label] = FORM_INTRO[field.part];
      return this.send(intro, { reply_markup: { inline_keyboard: [[{ text: label, web_app: { url: this.formUrl(field.part) } }]] } });
    }
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
      try { await step(); } catch (error) { await this.send(`⚠️ ${error.message}\nSende ${retry}, um es noch einmal zu versuchen.`); return false; }
      return true;
    })().then(ok => { this.busy = null; if (ok) return this.continue(); }).catch(error => { this.busy = null; this.onError(error.message); });
    return true;
  }
  async ask(key) {
    const field = this.settings.field(key);
    const choices = this.settings.choices(key);
    this.awaiting = choices.length ? null : { kind: 'setting', key };
    const buttons = [...choices.map(([, label], index) => ({ text: label, callback_data: `c:${key}:${index}:${fingerprint(label)}` })), ...(field.optional ? [{ text: 'Überspringen', callback_data: `c:${key}:-` }] : [])];
    const current = this.settings.values[key] !== undefined ? `\n\nAktuell: ${this.settings.display(key)}` : '';
    await this.send(`${field.ask}${current}`, buttons.length ? { reply_markup: { inline_keyboard: fit(buttons) } } : {});
  }
  async saved(key) {
    if (this.ready && this.settings.complete()) return this.send(`Gespeichert: ${this.settings.field(key)?.label ?? key} = ${this.settings.display(key)}`);
    return this.continue(); // During setup: the next question, or "All set" after the last one.
  }
  // A typed message that is not a command or a draft edit: the answer to the open question.
  async text(message) {
    if (this.busy) return this.send(BUSY);
    const question = this.awaiting ?? (this.ready ? null : this.setupQuestion());
    if (!this.answerable(question)) {
      if (this.awaiting) this.awaiting = null;
      return this.ready ? this.show(this.settingsView()) : this.continue();
    }
    return ANSWERS[question.kind].call(this, question, message);
  }
  // The setup step a typed message can answer, if it is one.
  setupQuestion() {
    const key = this.settings.next()?.key;
    return this.typed(key) ? { kind: 'setting', key } : null;
  }
  // A setting set by typing, not by a form or buttons.
  typed(key) {
    const field = key && this.settings.field(key);
    return Boolean(field && !field.form && !this.settings.choices(key).length);
  }
  // Whether this chat can still answer the question: a known kind, a typed setting, the admin's searches.
  answerable(question) {
    if (!question || !Object.hasOwn(ANSWERS, question.kind)) return false;
    if (question.kind === 'setting') return this.typed(question.key);
    return !ADMIN_QUESTIONS.includes(question.kind) || Boolean(this.admin);
  }
  // Button taps: c:<key>:<index|-> answers a question (a choice or Skip),
  // k:<key> asks to change a setting, x:<action> is a menu action. Returns the toast, whether the tap was
  // used up (then its buttons are removed), and optionally `edit`: a view that replaces the tapped message.
  async choice(data) {
    const [kind, key, index, mark] = data.split(':');
    if (kind === 'x') return this.action(...data.split(':').slice(1));
    const field = this.settings.field(key);
    if (kind === 'k') {
      if (!field || (field.form && key !== 'style')) return { text: 'Unbekannte Einstellung.' };
      if (key === 'style') return ACTIONS.style.call(this);
      await this.ask(key);
      return { text: 'Wähle oder sende den neuen Wert.' };
    }
    const values = field && this.answer(field, index, mark);
    if (!values) return STALE;
    for (const [setting, value] of Object.entries(values)) this.settings.set(setting, value);
    if (this.awaiting?.kind === 'setting' && this.awaiting.key === key) this.awaiting = null;
    await this.saved(key);
    return { text: 'Gespeichert.', used: true };
  }
  // The { setting: value } a question's button stands for; null if the button is outdated.
  answer(field, index, mark) {
    if (index === '-') return field.optional ? { [field.key]: '' } : null;
    const choice = this.settings.choices(field.key)[Number(index)];
    return choice && mark === fingerprint(choice[1]) ? { [field.key]: choice[0] } : null;
  }
  show(view) { return this.send(view.text, view.extra); }
  // A form was saved in the Mini App: setup goes on, otherwise the chat shows what is set now.
  async formSaved(part) {
    if (!this.ready || !this.settings.complete()) return this.continue();
    const views = { search: () => this.requirementsView(), profile: () => this.aboutView(), style: () => this.styleView() };
    return this.show(views[part]());
  }
  // The Mini App address of a settings form (forms.js).
  formUrl(part) { return `${this.settings.config.publicUrl}/form?part=${part}`; }
  async command(name) {
    if (name === '/start' || name === '/setup') return this.settings.complete() ? this.send(`Die Einrichtung ist abgeschlossen. ${MENU_HINT}`) : this.continue();
    // Reconnecting works during setup too: setup may be waiting for it.
    if (!this.settings.complete() && !['/connect', '/login'].includes(name)) return this.send('Lass uns zuerst die Einrichtung abschließen.').then(() => this.continue());
    if (Object.hasOwn(RECONNECT, name)) return this.reconnect(name) ? undefined : this.send(BUSY);
    const commands = {
      '/status': async () => this.show(await this.statusView()),
      '/pause': () => this.send(this.togglePause() ? '⏸ Pausiert. Ich suche nicht mehr; wartende Entwürfe und das Senden funktionieren weiter. Sende /pause noch einmal, um fortzufahren.' : '▶️ Suche läuft wieder.'),
      '/settings': () => this.show(this.settingsView()),
      '/search': () => this.show(this.requirementsView()),
      '/prompt': () => this.show(this.styleView()),
      '/autosend': () => this.ask('autoSend'),
      ...(this.admin && {
        '/users': () => this.show(usersView(this.admin.users())),
        '/model': () => this.modelMenu(),
      }),
    };
    return Object.hasOwn(commands, name) ? commands[name]() : this.send(`${name} kenne ich nicht. ${MENU_HINT}`);
  }
  // Starts a reconnect from a command or a /settings button; false if a long step is running.
  reconnect(name) { return this.track(() => this[RECONNECT[name]](), name); }
  // Returns whether searching is now paused.
  togglePause() { return this.settings.set('paused', !this.settings.config.paused); }
  settingsView() { return settingsView({ autoSend: this.settings.config.autoSend, admin: Boolean(this.admin) }); }
  // The searches this person picked, with their schedules.
  picked() { return pickedSearches(this.catalog(), this.settings.config.searches); }
  schedule(what, index, mark, choice) {
    const search = this.pickedSearch(index, mark);
    if (!search) return STALE;
    if (choice === undefined) return { text: '', edit: scheduleView(search, index, what) };
    const value = (what === 'si' ? INTERVALS : NIGHT_PAUSES)[Number(choice)];
    if (value === undefined) return STALE;
    const updated = this.admin.scheduleSearch(search.name, what === 'si' ? { intervalMs: value } : { quietHours: value });
    return { text: 'Gespeichert. Gilt für alle, die diese Suche gewählt haben.', edit: searchView(updated, index, this.using(search.name)) };
  }
  requirementsView() { return requirementsView(this.settings.config.preferences, this.settings.config, this.formUrl('search')); }
  aboutView() { return aboutView(this.settings.config.persona, this.settings.config.accountEmail, this.formUrl('profile')); }
  styleView() { return styleView(this.settings.config.style, this.formUrl('style')); }
  // How many people picked a search.
  using(name) { return this.admin.users().filter(user => user.searches.includes(name)).length; }
  // Where the admin's search changes lead back to: 🛠 Admin's list, or during setup the one they pick from.
  searchList() { return this.admin && this.settings.complete() ? catalogView(this.catalog(), name => this.using(name)) : this.searchesView(); }
  searchesView() { return searchesView({ catalog: this.catalog(), selected: this.settings.config.searches, admin: Boolean(this.admin), ready: this.settings.complete() }); }
  // A typed search addition or rename: the error to correct, or the updated list.
  // change() may return a view to show before the list.
  async changeSearches(change) {
    let view;
    try { view = await change(); } catch (error) { return this.send(error.message); }
    this.awaiting = null;
    if (view) await this.show(view);
    return this.show(this.searchList());
  }
  // The search a button names, if the list still has it at that index.
  pickedSearch(index, mark) {
    const search = this.catalog()[Number(index)];
    return search && fingerprint(search.name) === mark ? search : null;
  }
  async statusView() {
    const counts = {};
    for (const review of this.store.list()) counts[review.status] = (counts[review.status] ?? 0) + 1;
    const { config } = this.settings;
    const picked = this.picked();
    // The level a model uses when none is chosen; unknown if the model list cannot be read.
    const list = this.admin ? await this.models().catch(() => []) : [];
    const level = ({ model, thinking }) => {
      const fallback = list.find(entry => entry.id === model)?.defaultThinking;
      return thinking || (fallback ? `${fallback} (Standard)` : '');
    };
    return statusView({ counts, failures: { IS24: this.workflow?.health.IS24.failures ?? 0, LLM: this.workflow?.health.LLM.failures ?? 0 }, blocked: this.workflow?.health.IS24.blocked,
      paused: config.paused, autoSend: config.autoSend, email: config.accountEmail, immomioEmail: config.immomioEmail,
      llm: this.admin ? { ...this.llm(), thinking: level(this.llm()) } : null,
      searches: picked.map(search => ({ ...search, quiet: isQuiet(search.quietHours), ...this.feedStatus(search) })), quiet: allQuiet(picked), chatgpt: (this.admin && this.codex.account?.()) || {} }); // The shared account's address stays with the admin.
  }
  // ponytail: 10-minute cache; plans rarely change their models more often.
  async models() {
    if (!this.modelCache || Date.now() - this.modelCache.at > 600_000) this.modelCache = { at: Date.now(), list: await this.codex.models() };
    return this.modelCache.list;
  }
  async modelMenu() {
    let list;
    try { list = await this.models(); } catch (error) { return this.send(`⚠️ Ich konnte die Modelle des Abos nicht lesen (${error.message}).`); }
    const { model, thinking } = this.llm();
    return this.show(modelView(list, model, thinking));
  }
  // Menu buttons: x:<name>:<arguments>, see ACTIONS.
  async action(name, ...args) {
    if (!this.settings.complete() && !SETUP_ACTIONS.includes(name)) return { text: 'Schließ zuerst die Einrichtung ab.' };
    return Object.hasOwn(ACTIONS, name) && (this.admin || !ADMIN_ACTIONS.includes(name)) ? ACTIONS[name].apply(this, args) : STALE;
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
    if (!this.admin) throw new Error('ChatGPT wird bei diesem Agenten geteilt. Wenn es nicht mehr funktioniert, kann der Admin es mit /login neu verbinden.');
    await this.send('Verbinde zuerst dein ChatGPT-Abo. Es prüft Inserate und schreibt deine Bewerbungen.');
    await this.codex.login({ onCode: ({ url, code }) => this.send(`1. Öffne ${url}\n2. Melde dich bei ChatGPT an\n3. Gib diesen Code ein: ${code}\n\nDer Code läuft in 15 Minuten ab. Falls ChatGPT fragt, erlaube in den Sicherheitseinstellungen die Anmeldung per Gerätecode.`).catch(error => this.onError(error.message)) });
    this.chatgpt = true;
    await this.send('✅ ChatGPT verbunden.');
  }
  async connectImmomio() {
    const email = await this.immomio.connect();
    await this.send(`✅ Mit Immomio verbunden als ${email}. Wenn die IS24-Beschreibung eines Inserats auf eine Immomio-Bewerbung verweist, bewerbe ich mich dort mit deinem Immomio-Profil und deiner Nachricht, sobald du sie freigibst (oder von selbst mit Auto-Senden). Neue Immomio-Nachrichten von Vermietern erscheinen hier; antworte auf eine, um zu antworten. Halte dein Profil auf tenant.immomio.com vollständig.`);
  }
  // Sends the "Connect ImmoScout24" button and waits until the person connected their account there.
  async connectIS24() {
    const email = await this.is24.connect();
    await this.send(`✅ Mit ImmoScout24 verbunden als ${email}.`);
  }
}
