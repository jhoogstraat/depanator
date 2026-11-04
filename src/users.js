import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { Settings, SCHEDULE, INTERVALS, NIGHT_PAUSES } from './settings.js';
import { FormApp } from './forms.js';
import { Workflow } from './workflow.js';
import { IS24Adapter, searchFilters } from './is24.js';
import { feedKey } from './feed.js';
import { createEvaluator } from './llm.js';
import { codexLoggedIn, loginWithCodex, listCodexModels, codexAccount } from './codex.js';
import { Telegram } from './telegram.js';
import { Assistant } from './assistant.js';
import { BRANDS, ConnectApp } from './connect.js';
import { IS24Session } from './is24-auth.js';
import { ImmomioSession } from './immomio.js';

// Why Workflow.check() did not search.
const SKIPPED = { paused: 'Paused', quiet: 'Night pause', skipped: 'Backing off IS24' };
const INVITE_MS = 24 * 3_600_000;
// Across everybody: they all use one ChatGPT login, so one person's burst must not starve the others.
const LLM_CONCURRENCY = 3;
const SESSIONS = ['is24-session.json', 'immomio-session.json'];

// At most `max` calls at once, first come first served.
export function limiter(max) {
  let active = 0;
  const waiting = [];
  return async work => {
    if (active < max) active++;
    else await new Promise(resolve => waiting.push(resolve));
    try { return await work(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}

export const userIds = dataDir => {
  const root = join(dataDir, 'users');
  return existsSync(root) ? readdirSync(root).filter(name => /^\d+$/.test(name)) : [];
};

// Moves a single-owner data directory to the first person's folder; its owner, or whoever pairs now (firstId),
// becomes the admin. The database moves last, so an interrupted move is finished by the next start. The ChatGPT
// login stays shared.
function migrate(dataDir, firstId) {
  const database = join(dataDir, 'agent.db');
  if (!existsSync(database)) return;
  const store = new Store(database);
  const chatId = store.settings().chatId ?? firstId;
  if (/^\d+$/.test(String(chatId ?? ''))) store.saveSetting('admin', true);
  store.close(); // Folds any write-ahead log into the database.
  if (!/^\d+$/.test(String(chatId ?? ''))) return; // Nobody paired yet: it waits for the first person.
  const folder = join(dataDir, 'users', String(chatId));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (const file of [...SESSIONS, 'agent.db-wal', 'agent.db-shm', 'agent.db']) {
    if (existsSync(join(dataDir, file))) renameSync(join(dataDir, file), join(folder, file));
  }
}

const sameSearch = (a, b) => JSON.stringify(searchFilters(a)) === JSON.stringify(searchFilters(b));
// People used to paste their own search URL. Its rent, rooms and area become their limits and the rest joins the
// admin's list, so people who differed only in those three share one search as before.
function adoptSearchUrls(dataDir) {
  const stores = userIds(dataDir).map(id => new Store(join(dataDir, 'users', id, 'agent.db')));
  const limit = ({ min, max }) => min === null && max === null ? '' : `${min ?? ''}-${max ?? ''}`;
  try {
    const admin = stores.find(store => store.settings().admin);
    for (const store of admin ? stores : []) {
      const { searchUrl } = store.settings();
      if (!searchUrl) continue;
      let filters;
      try { filters = searchFilters(searchUrl); } catch { store.deleteSetting('searchUrl'); continue; } // They pick again in the chat.
      const url = new URL(/^https?:\/\//i.test(searchUrl) ? searchUrl : `https://${searchUrl}`);
      for (const key of [...url.searchParams.keys()]) if (/^(price|pricetype|numberofrooms|livingspace)$/i.test(key)) url.searchParams.delete(key);
      url.pathname = url.pathname.replace(/wohnung-bis-\d+-euro-warm$/, 'wohnung-mieten');
      const catalog = admin.settings().catalog ?? [];
      const search = catalog.find(entry => sameSearch(entry.url, url.href)) ?? { name: `Search ${catalog.length + 1}`, url: url.href };
      if (!catalog.includes(search)) admin.saveSetting('catalog', [...catalog, search]);
      store.saveSetting('rent', limit(filters.price));
      store.saveSetting('rooms', limit(filters.rooms));
      store.saveSetting('area', limit(filters.livingSpace));
      store.saveSetting('searches', [search.name]);
      store.deleteSetting('searchUrl');
    }
  } finally { for (const store of stores) store.close(); }
}

// Everyone on this agent: one private chat with the bot and one folder per person (users/<chat id>/).
// Shared: the bot, the admin's list of IS24 searches and their feeds, and the ChatGPT login. Nobody's store, sessions or chat reach another's.
export class Users {
  // feeds: the crawled searches (feed.js). onCatalog: the admin's list or a search's schedule changed.
  constructor({ runtime, bot, feeds, onCatalog = () => {}, log = console }) {
    Object.assign(this, { runtime, bot, feeds, onCatalog, log });
    this.users = new Map();
    this.limit = limiter(LLM_CONCURRENCY);
    this.pairingCode = null;
  }
  get size() { return this.users.size; }
  get(id) { return this.users.get(String(id)); }
  get admin() { return [...this.users.values()].find(user => user.settings.values.admin); }
  load() {
    migrate(this.runtime.dataDir);
    adoptSearchUrls(this.runtime.dataDir);
    for (const id of userIds(this.runtime.dataDir)) this.open(id);
  }
  // One person's agent. initial: settings of someone new.
  open(id, initial = {}) {
    const { runtime, bot, feeds } = this;
    const folder = join(runtime.dataDir, 'users', id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const store = new Store(join(folder, 'agent.db'));
    const settings = new Settings(store, runtime);
    const config = settings.config;
    for (const [key, value] of Object.entries({ chatId: id, ...initial })) settings.assign(key, value);
    const isAdmin = settings.values.admin === true;
    const error = text => this.log.error(`[${id}] ${text}`);
    const session = new IS24Session(join(folder, SESSIONS[0]));
    // The account email comes from the connected IS24 session; without one, setup asks to connect.
    if (!session.connected && config.accountEmail) settings.set('accountEmail', '');
    const immomioSession = new ImmomioSession(join(folder, SESSIONS[1]));
    if (!immomioSession.connected && config.immomioEmail) settings.set('immomioEmail', '');
    const adapter = new IS24Adapter(config, { session, immomio: immomioSession, feeds, catalog: () => this.catalog,
      cursors: { get: () => store.settings().cursors ?? {}, set: value => store.saveSetting('cursors', value) } });
    const is24App = new ConnectApp({ config, session });
    const immomioApp = new ConnectApp({ config, session: immomioSession, brand: BRANDS.immomio });
    // The settings forms. The name IS24 knows prefills the form until one is saved.
    const formApp = new FormApp({ config, settings,
      prefill: () => ({ 'persona.vorname': session.profile.firstname || undefined, 'persona.nachname': session.profile.lastname || undefined }),
      onSaved: part => telegram.assistant.formSaved(part).catch(failure => error(failure.message)) });
    let telegram;
    // Sends the connect button (once per request) and resolves with the connected email, saved as `setting`.
    const connector = (app, setting, name, path) => async intro => {
      const { fresh, done } = app.request();
      if (fresh) {
        this.log.log(`[${id}] Waiting for them to connect ${name}.`);
        await telegram.send(intro, { reply_markup: { inline_keyboard: [[{ text: `🔗 Connect ${name}`, web_app: { url: `${config.publicUrl}/${path}` } }]] } }).catch(failure => error(failure.message));
      }
      const email = await done;
      if (email !== config[setting]) settings.set(setting, email);
      return email;
    };
    const connect = connector(is24App, 'accountEmail', 'ImmoScout24', 'connect');
    // Optional: only listings that link to Immomio need it.
    const connectImmomio = connector(immomioApp, 'immomioEmail', 'Immomio', 'immomio');
    const evaluate = createEvaluator(config);
    const workflow = new Workflow({
      store, adapter, config, evaluate: (snapshot, options) => this.limit(() => evaluate(snapshot, options)),
      notify: review => telegram.notify(review),
      report: review => telegram.notifyOutcome(review),
      withdraw: review => telegram.withdraw(review),
      alert: text => { error(text); return telegram.send(text); }, interval: () => this.interval(),
      beforeWork: () => adapter.authenticate(() => connect('🔗 ImmoScout24 ended my login. Please connect your account again; checks are paused until then.')),
      onEvent: event => {
        if (event.type === 'submission') this.log.log(`[${id}] ${event.review.exposeId}: ${event.review.status} — ${event.review.detail || ''}`);
        if (event.type.endsWith('_error')) error(`${event.type}: ${event.detail}`);
      },
    });
    telegram = new Telegram({ config, store, workflow, bot, onError: error });
    // Resolves with the tick's result, or { error } (logged here). A wake-up during a tick runs one more after it,
    // so a crawl that finished meanwhile is never missed. Outcome reports go out even while a tick is stuck.
    let running = null, again = false;
    const tick = () => {
      if (!settings.complete()) return Promise.resolve();
      if (running) { again = true; workflow.reportOutcomes(); return running; }
      running = (async () => {
        let result;
        do { again = false; result = await once(); } while (again && !workflow.closed);
        return result;
      })().finally(() => { running = null; });
      return running;
    };
    const once = () => {
      return workflow.tick().then(result => {
        const skipped = Object.keys(SKIPPED).find(reason => result?.[reason]);
        this.log.log(`[${id}] ${skipped ? `${SKIPPED[skipped]}; poll skipped.` : `Poll complete. ${result.tracked} listings tracked.`}`);
        if (result?.warning) error(result.warning);
        return result;
      }).catch(failure => { error(`Agent: ${failure.message}`); return { error: failure.message }; });
    };
    telegram.assistant = new Assistant({
      settings, store, send: (text, extra) => telegram.send(text, extra),
      codex: { loggedIn: () => codexLoggedIn(config), login: options => loginWithCodex(config, options), models: () => listCodexModels(config), account: () => codexAccount(config) },
      is24: { connect: () => connect('🔗 Connect your ImmoScout24 account, so I can read listings and send the applications you approve.') },
      immomio: { connect: () => connectImmomio('🔗 Connect your Immomio account, so I can apply there to the listings you approve that link to Immomio.') },
      workflow, redeliver: review => telegram.notify(review, { again: true }),
      catalog: () => this.catalog, feedStatus: search => feeds.status(feedKey(searchFilters(search.url))),
      admin: isAdmin ? { invite: () => this.invite(), users: () => this.list(), remove: target => this.remove(target), addSearch: (name, url) => this.addSearch(name, url),
        renameSearch: (name, to) => this.renameSearch(name, to), scheduleSearch: (name, change) => this.scheduleSearch(name, change), removeSearch: name => this.removeSearch(name) } : null,
      onReady: () => tick(), onError: error,
    });
    // Back from a pause: only what is crawled from now on is new, and what is online now counts as already online.
    settings.onChange(key => { if (key === 'paused' && !config.paused) store.saveSetting('cursors', {}); });
    const user = {
      id, folder, store, settings, workflow, telegram, tick, connects: [is24App, immomioApp, formApp],
      close: async () => {
        workflow.stop();
        telegram.close();
        for (const app of user.connects) app.close();
        await workflow.close();
      },
    };
    this.users.set(id, user);
    return user;
  }
  // Checks run as often as the most frequent search someone searching picked; each search runs on its own interval.
  interval() {
    const picked = new Set([...this.users.values()].filter(user => user.settings.complete() && !user.settings.config.paused).flatMap(user => user.settings.config.searches));
    const intervals = this.catalog.filter(search => picked.has(search.name)).map(search => search.intervalMs);
    return intervals.length ? Math.min(...intervals) : this.defaults().intervalMs;
  }
  // Everybody's housekeeping besides the crawls: outcome reports, approved sends, the morning cleanup.
  round() { return Promise.allSettled([...this.users.values()].map(user => user.tick())); }
  // Everyone searching, and who picked what.
  searching() { return [...this.users.values()].filter(user => user.settings.complete() && !user.settings.config.paused); }
  // The admin's searches as the crawlers need them. wanted: someone searching picked it.
  feedSearches() {
    const picked = new Set(this.searching().flatMap(user => user.settings.config.searches));
    return this.catalog.map(search => ({ ...search, key: feedKey(searchFilters(search.url)), filters: searchFilters(search.url), wanted: picked.has(search.name) }));
  }
  // The people a search's news is for. A rename keeps the key, so they are found by name in the current list.
  followers(key) {
    const name = this.catalog.find(search => feedKey(searchFilters(search.url)) === key)?.name;
    return [...this.users.values()].filter(user => user.settings.complete() && user.settings.config.searches.includes(name));
  }
  // A crawl of `key` finished: whoever picked it reads what is new.
  crawled(key) { for (const user of this.followers(key)) if (!user.settings.config.paused) user.tick(); }
  // A search's failure streak: whoever picked it hears it, and the admin always.
  alert(key, text) {
    this.log.error(text);
    for (const user of new Set([...this.followers(key), this.admin].filter(Boolean))) user.telegram.send(text).catch(error => this.log.error(`[${user.id}] ${error.message}`));
  }
  // Persisted approvals go out independently of a temporary search outage.
  resume() {
    for (const user of this.users.values()) {
      if (user.settings.complete()) user.workflow.sendApproved().catch(error => this.log.error(`[${user.id}] Send queue: ${error.message}`));
      else user.telegram.assistant.resume().catch(error => this.log.error(`[${user.id}] ${error.message}`));
    }
  }
  // What a new search starts with: the admin's last choice. Before searches had their own, the admin's interval and
  // night pause were everybody's.
  defaults() {
    const stored = this.admin?.store.settings() ?? {};
    return { ...SCHEDULE, ...(stored.pollIntervalMs && { intervalMs: stored.pollIntervalMs }), ...(stored.quietHours !== undefined && { quietHours: stored.quietHours }), ...stored.searchDefaults };
  }
  // The searches IS24 is asked for: the admin's list, kept in their store. [{ name, url, intervalMs, quietHours }]
  get catalog() {
    const defaults = this.defaults();
    return (this.admin?.store.settings().catalog ?? []).map(search => ({ ...defaults, ...search }));
  }
  // A search's interval and/or night pause; also what the next new search starts with.
  scheduleSearch(name, change) {
    if (change.intervalMs !== undefined && !INTERVALS.includes(change.intervalMs)) throw new Error('Please pick one of the intervals.');
    if (change.quietHours !== undefined && !NIGHT_PAUSES.includes(change.quietHours)) throw new Error('Please pick one of the night pauses.');
    const { catalog } = this;
    const search = catalog.find(entry => entry.name === name);
    if (!search) throw new Error(`${name} is no longer on the list.`);
    const updated = { ...search, ...change };
    this.admin.store.saveSetting('catalog', catalog.map(entry => entry === search ? updated : entry));
    this.admin.store.saveSetting('searchDefaults', { intervalMs: updated.intervalMs, quietHours: updated.quietHours });
    this.onCatalog();
    return updated;
  }
  addSearch(name, url) {
    const { href } = new URL(url);
    searchFilters(href); // A filter that cannot be applied exactly is refused here, with the reason.
    const { catalog } = this;
    if (catalog.some(search => search.name === name)) throw new Error(`There already is a search named ${name}.`);
    const twin = catalog.find(search => sameSearch(search.url, href));
    if (twin) throw new Error(`${twin.name} is already this search.`);
    this.admin.store.saveSetting('catalog', [...catalog, { name, url: href, ...this.defaults() }]);
    this.onCatalog();
  }
  // Same search, new name, for everyone who picked it.
  renameSearch(name, to) {
    if (!to || to.length > 40 || /[\r\n]/.test(to)) throw new Error('Please send a name of one line, at most 40 characters.');
    const { catalog } = this;
    if (!catalog.some(search => search.name === name)) throw new Error(`${name} is no longer on the list.`);
    if (to !== name && catalog.some(search => search.name === to)) throw new Error(`There already is a search named ${to}.`);
    this.admin.store.saveSetting('catalog', catalog.map(search => search.name === name ? { ...search, name: to } : search));
    for (const user of this.users.values()) {
      const { searches } = user.settings.config;
      if (searches.includes(name)) user.settings.assign('searches', searches.map(picked => picked === name ? to : picked));
    }
  }
  // Whoever had picked it hears so; someone with nothing left gets the list again.
  async removeSearch(name) {
    const { catalog } = this;
    if (catalog.length < 2) throw new Error('This is the last search. Add another one first.');
    this.admin.store.saveSetting('catalog', catalog.filter(search => search.name !== name));
    this.onCatalog();
    for (const user of this.users.values()) {
      const { searches } = user.settings.config;
      if (!searches.includes(name)) continue;
      user.settings.assign('searches', searches.filter(picked => picked !== name));
      await user.telegram.send(`🔎 The search ${name} is no longer available.`).then(() => user.telegram.assistant.continue()).catch(error => this.log.error(`[${user.id}] ${error.message}`));
    }
  }
  invite() {
    const code = randomBytes(16).toString('base64url');
    const { store } = this.admin;
    const now = Date.now();
    const open = Object.entries(store.settings().invites ?? {}).filter(([, expires]) => expires > now);
    store.saveSetting('invites', Object.fromEntries([...open, [code, now + INVITE_MS]]));
    return `https://t.me/${this.bot.me.username}?start=${code}`;
  }
  // Single use: true if the code was valid.
  redeem(code) {
    const { store } = this.admin ?? {};
    const invites = store?.settings().invites ?? {};
    if (!(invites[code] > Date.now())) return false;
    delete invites[code];
    store.saveSetting('invites', invites);
    return true;
  }
  list() {
    return [...this.users.values()].map(({ id, settings }) => ({ id, email: settings.config.accountEmail, ready: settings.complete(), admin: settings.values.admin === true, searches: settings.config.searches }));
  }
  async remove(id) {
    const user = this.get(id);
    if (!user || user.settings.values.admin) throw new Error('This person cannot be removed.');
    this.users.delete(user.id);
    await user.telegram.send('Your access to this apartment agent has ended.').catch(() => {});
    await user.close();
    // Kept for the admin to delete: sent applications may still need looking up.
    renameSync(user.folder, join(this.runtime.dataDir, 'users', `removed-${user.id}-${Date.now()}`));
  }
  // Every update from one person's private chat goes to that person. Group chats and strangers reach nobody.
  async route(update) {
    const message = update.message;
    const query = update.callback_query;
    const user = this.get(message?.chat?.id ?? query?.message?.chat?.id ?? '');
    if (user) return user.telegram.handleUpdate(update);
    if (query) return this.bot.api('answerCallbackQuery', { callback_query_id: query.id, text: 'This approval is invalid.' });
    if (message) return this.join(message);
  }
  // The bot stays private: the first person joins with the pairing code from the log, everyone else with an
  // invite from the admin. Anyone else's messages go unanswered.
  async join(message) {
    const id = String(message.chat?.id ?? '');
    const [command, code] = String(message.text ?? '').trim().split(/\s+/);
    if (message.chat?.type !== 'private' || String(message.from?.id) !== id || command !== '/start') return;
    const reply = text => this.bot.api('sendMessage', { chat_id: id, text });
    if (!this.size) {
      if (!this.pairingCode || code !== this.pairingCode) return reply('To connect, send /start followed by the code shown in the agent log, for example: /start 123456');
      this.pairingCode = null;
      migrate(this.runtime.dataDir, id); // Settings stored before anyone paired are theirs.
      adoptSearchUrls(this.runtime.dataDir);
      const user = this.open(id, { admin: true });
      this.onCatalog(); // Searches stored before anyone paired are theirs now.
      return user.telegram.welcome();
    }
    if (!code) return;
    if (!this.redeem(code)) return reply('This invite is not valid any more. Please ask for a new one.');
    return this.open(id).telegram.welcome();
  }
  stop() { for (const user of this.users.values()) { user.workflow.stop(); user.telegram.close(); } }
  async close() {
    const results = await Promise.allSettled([...this.users.values()].map(user => user.close()));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}
