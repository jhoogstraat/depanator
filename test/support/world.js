import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROW_WIDTH, width } from '../../src/menu.js';
import { Store } from '../../src/store.js';

export const OWNER = 42;
export const STRANGER = 777;
export const FRIEND = 55;
export const SEARCH_URL = 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?price=-1500';
const TOKEN = 'e2e-bot-token';
// The names the fake IS24 account has, as its login tells them.
const NAMES = { 'alex@example.com': { given_name: 'Alex', family_name: 'Doe' }, 'friend@example.com': { given_name: 'Robin' } };
const POLL_MS = 100; // Below the chat's choices, so tests need no fake clock. Shown as "every 0.1 s".
const ROOT = new URL('../..', import.meta.url).pathname;
const FAKE_CODEX = new URL('./fake-codex.js', import.meta.url).pathname;

export const until = async (what, condition, timeout = 10_000) => {
  for (const start = Date.now(); Date.now() - start < timeout; await new Promise(resolve => setTimeout(resolve, 10))) {
    const value = condition();
    if (value) return value;
  }
  assert.fail(`Timed out waiting for ${what}`);
};
export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const jwt = claims => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const answer = (res, { status = 200, type = 'application/json', body }) => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };

// The same JSON shapes the IS24 app API answers with.
// rent: null and exposeArea: null are the gaps IS24 really leaves. photos: picture IDs, the first the title picture;
// gallery: the IDs the expose lists, the photos unless set.
const picture = (id, size) => `https://pictures.immobilienscout24.de/listings/${id}.jpg/ORIG/resize/${size}/format/webp/quality/80`;
const searchItem = ({ id, title, rent = '900 €', rooms = '2', published, photos = [] }) => ({ id, title, published, address: { line: 'Berlin' }, attributes: [rent, '50 m²', `${rooms} Zi.`].filter(Boolean).map(value => ({ value })),
  ...(photos.length && { titlePicture: { full: picture(photos[0], '800x600'), preview: picture(photos[0], '210x210') } }) });
const expose = ({ title, description, rent = '900 €', rooms = '2', exposeArea = '50 m²', photos = [], gallery = photos }) => ({
  sections: [
    // As IS24 sends it: an ad slot among the pictures.
    ...(gallery.length ? [{ type: 'MEDIA', media: gallery.flatMap((id, index) => [...(index === 1 ? [{ type: 'AD', caption: 'Gesponsert', ad: { id: '/4467/IS24_APP_DE/app_iOS_gallery_ad' } }] : []),
      { type: 'PICTURE', caption: 'Zimmer', previewImageUrl: picture(id, '800x600'), imageUrlForWeb: picture(id, '%WIDTH%x%HEIGHT%'), fullImageUrl: picture(id, '1500x1000') }]) }] : []),
    { type: 'TOP_ATTRIBUTES', attributes: [...(rent ? [{ label: 'Warmmiete', text: rent }] : []), { label: 'Zimmer', text: rooms }, ...(exposeArea ? [{ label: 'Wohnfläche', text: exposeArea }] : [])] },
    { type: 'TITLE', title }, { type: 'MAP', addressLine1: 'Teststraße 1', addressLine2: '10115 Berlin' }, { type: 'TEXT_AREA', title: 'Objektbeschreibung', text: description },
  ],
  contact: { premiumProfileRequiredForContacting: 'false', contactData: { formFieldConfig: { firstnameField: 'MANDATORY', lastnameField: 'MANDATORY', emailAddressField: 'MANDATORY' } } },
});

// One run's outside world: fakes for Telegram, IS24, Immomio and the Codex CLI, a private data directory, and the
// real agent as a child process. Tests act as the owner in the chat and watch what reaches the services.
export async function createWorld(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'depanator-e2e-'));
  const world = {
    dataDir, listings: [], searches: 0, searchUrls: [], reads: {}, contacts: [], immomioApplications: [], unexpected: [], telegram: [], agentLog: '',
    updates: [], nextUpdate: 1, nextMessage: 1,
    // Set to { status, type, body } to make IS24 answer exactly that.
    respond: { search: null, expose: {}, contact: null },
    listing(id, title, description, facts) {
      const listing = { id, title, description, ...facts };
      this.listings.push(listing);
      return listing;
    },
    // The responses the agent saved, see docs/raw-responses.md. A file still being written is picked up next time.
    kept() {
      const directory = join(dataDir, 'raw');
      if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
      return readdirSync(directory).sort().flatMap(file => {
        try { return [{ file, label: file.replace(/-[0-9a-f]{12}\.json$/, ''), mode: statSync(join(directory, file)).mode & 0o777, ...JSON.parse(readFileSync(join(directory, file), 'utf8')) }]; }
        catch { return []; }
      });
    },
    // What the owner receives. The newest message wins, as in the chat.
    messages() { return this.telegram.filter(call => ['sendMessage', 'editMessageText'].includes(call.method)); },
    sees(pattern) { return until(`a message like ${pattern}`, () => this.messages().find(call => pattern.test(call.body.text))); },
    never(pattern) { assert.ok(!this.messages().some(call => pattern.test(call.body.text)), `unexpected message like ${pattern}`); },
    // One person's chat.
    chat(id) { return this.messages().filter(call => String(call.body.chat_id) === String(id)).map(call => call.body.text); },
    seesIn(id, pattern) { return until(`a message like ${pattern} for ${id}`, () => this.chat(id).find(text => pattern.test(text))); },
    labels() { return this.messages().findLast(call => call.body.reply_markup?.inline_keyboard?.length)?.body.reply_markup.inline_keyboard.flat().map(button => button.text) ?? []; },
    // Their own chat first; a stranger tapping an owner's button finds it in the owner's.
    button(label, from) {
      const own = call => String(call.body.chat_id) === String(from);
      for (const call of [...this.messages().filter(own).toReversed(), ...this.messages().toReversed()]) {
        const button = call.body.reply_markup?.inline_keyboard?.flat().find(entry => entry.text === label);
        if (button) return { ...button, messageId: call.body.message_id ?? call.result?.message_id };
      }
      assert.fail(`No button "${label}" in the chat`);
    },
    say(text, from = OWNER) { this.updates.push({ update_id: this.nextUpdate++, message: { message_id: this.nextMessage++, text, chat: { id: from, type: 'private' }, from: { id: from } } }); },
    // Taps a button and resolves with the toast Telegram showed.
    // Telegram sends the tapped message back as it now looks.
    async press({ callback_data, messageId }, from = OWNER) {
      const id = String(this.nextUpdate);
      const versions = this.telegram.filter(call => ['sendMessage', 'editMessageText', 'editMessageReplyMarkup'].includes(call.method) && (call.body.message_id ?? call.result?.message_id) === messageId);
      const { text, entities } = versions.findLast(call => call.method !== 'editMessageReplyMarkup')?.body ?? {};
      const message = { message_id: messageId, chat: { id: from, type: 'private' }, text, entities, reply_markup: versions.at(-1)?.body.reply_markup };
      this.updates.push({ update_id: this.nextUpdate++, callback_query: { id, data: callback_data, from: { id: from }, message } });
      return (await until(`the answer to tap ${callback_data}`, () => this.telegram.find(call => call.method === 'answerCallbackQuery' && call.body.callback_query_id === id))).body.text;
    },
    tap(label, from) { return this.press(this.button(label, from), from); },
    // What the Telegram app does when the owner opens a Connect button.
    signed(from) {
      const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: from }) };
      const check = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('\n');
      const hash = createHmac('sha256', createHmac('sha256', 'WebAppData').update(TOKEN).digest()).update(check).digest('hex');
      return new URLSearchParams({ ...fields, hash }).toString();
    },
    async connect(label, path, email, password, from = OWNER) {
      const { web_app } = await until(`the ${label} button`, () => this.messages().filter(call => String(call.body.chat_id) === String(from)).flatMap(call => call.body.reply_markup?.inline_keyboard?.flat() ?? []).find(button => button.text === label));
      assert.equal(new URL(web_app.url).pathname, `/${path}`);
      const response = await fetch(`http://127.0.0.1:${this.port}/${path}/login`, { method: 'POST', headers: { 'x-init-data': this.signed(from) }, body: JSON.stringify({ email, password }) });
      assert.equal(response.status, 204);
    },
    // What the Telegram app shows when they open a ✏️ form button: that form with its current values.
    async form(part, from = OWNER) {
      const { web_app } = await until(`the ${part} form button`, () => this.messages().filter(call => String(call.body.chat_id) === String(from)).flatMap(call => call.body.reply_markup?.inline_keyboard?.flat() ?? [])
        .find(button => button.web_app && new URL(button.web_app.url).searchParams.get('part') === part));
      assert.equal(new URL(web_app.url).pathname, '/form');
      const response = await fetch(`http://127.0.0.1:${this.port}/form/state?part=${part}`, { headers: { 'x-init-data': this.signed(from) } });
      assert.equal(response.status, 200);
      return response.json();
    },
    // Opens the form, changes `values` and saves it. Resolves with the form as it was opened and the error shown, if any.
    async fill(part, values, from = OWNER) {
      const form = await this.form(part, from);
      const current = Object.fromEntries(form.fields.map(field => [field.key, field.value]));
      const response = await fetch(`http://127.0.0.1:${this.port}/form/save`, { method: 'POST', headers: { 'x-init-data': this.signed(from) }, body: JSON.stringify({ part, values: { ...current, ...values } }) });
      return { form, status: response.status, error: response.status === 400 ? (await response.json()).error : '' };
    },
    codexCalls() {
      const file = join(dataDir, 'codex', 'calls.jsonl');
      return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    },
    // Stored directly, as a finished setup before searches had their own schedule left them (the admin's interval and
    // night pause were everybody's), plus the IS24 login that goes with them.
    seed(values = {}) {
      const store = new Store(join(dataDir, 'agent.db'));
      const settings = { chatId: String(OWNER), accountEmail: 'alex@example.com', searchUrl: SEARCH_URL, preferences: 'No swap', 'persona.anrede': 'FEMALE', 'persona.vorname': 'Alex', 'persona.nachname': 'Doe',
        'persona.telefon': '', 'persona.strasse': '', 'persona.hausnummer': '', 'persona.plz': '', 'persona.ort': '', 'persona.about': '', 'persona.sendProfile': false, ...values };
      for (const [key, value] of Object.entries({ pollIntervalMs: POLL_MS, quietHours: '', ...settings })) store.saveSetting(key, value);
      store.close();
      writeFileSync(join(dataDir, 'is24-session.json'), JSON.stringify({ access_token: 'seeded-token', refresh_token: 'refresh', expiresAt: Date.now() + 3_600_000, email: settings.accountEmail, id_token: jwt({ ssoId: 'sso-1' }) }));
    },
    // An unset first run: only what a test cannot choose in the chat without waiting (the first search's poll
    // speed, no night pause).
    seedFirstRun() {
      const store = new Store(join(dataDir, 'agent.db'));
      store.saveSetting('searchDefaults', { intervalMs: POLL_MS, quietHours: '' });
      store.close();
    },
    // Starts the real agent. Resolves once it runs; its output is kept for the pairing code and failure messages.
    async start() {
      const free = createServer();
      await new Promise(resolve => free.listen(0, '127.0.0.1', resolve));
      this.port = free.address().port;
      await new Promise(resolve => free.close(resolve));
      this.agent = spawn(process.execPath, ['--preload', join(ROOT, 'test/support/intercept.js'), join(ROOT, 'src/cli.js'), 'start'], { cwd: dataDir,
        env: { PATH: process.env.PATH, HOME: dataDir, TELEGRAM_BOT_TOKEN: TOKEN, DEPANATOR_DATA_DIR: dataDir, DEPANATOR_PUBLIC_URL: 'https://agent.example', DEPANATOR_PORT: String(this.port), DEPANATOR_CODEX_BIN: FAKE_CODEX, E2E_WORLD_URL: `http://127.0.0.1:${server.address().port}` } });
      const collect = chunk => { this.agentLog += chunk; };
      this.agent.stdout.on('data', collect);
      this.agent.stderr.on('data', collect);
      this.exited = new Promise(resolve => this.agent.once('exit', resolve));
      await until(`the agent to start\n${this.agentLog}`, () => this.agentLog.includes('Agent running'));
    },
    async kill() { this.agent?.kill('SIGKILL'); await this.exited; },
  };

  const routes = {
    'api.telegram.org'(req, res, body, path) {
      const method = path.replace(`/bot${TOKEN}/`, '');
      if (method === 'getUpdates') {
        const send = () => json(res, { ok: true, result: world.updates.splice(0) });
        return world.updates.length ? send() : setTimeout(send, 20);
      }
      const call = { method, body, result: true };
      if (method === 'getMe') call.result = { id: 1, first_name: 'E2E', username: 'e2e_bot' };
      if (method === 'getWebhookInfo') call.result = { url: '' };
      if (method === 'sendMessage') call.result = { message_id: world.nextMessage++ };
      world.telegram.push(call);
      json(res, { ok: true, result: call.result });
    },
    'api.mobile.immobilienscout24.de'(req, res, body, path, url) {
      const contact = /^\/expose\/(\d+)\/contact$/.exec(path);
      const shown = /^\/expose\/(\d+)$/.exec(path);
      if (path === '/search/list') {
        world.searches++;
        world.searchUrls.push(url.search);
        if (world.respond.search) return answer(res, world.respond.search);
        return json(res, { resultListItems: world.listings.toReversed().map(searchItem), numberOfPages: 1 });
      }
      if (contact) {
        world.contacts.push({ id: contact[1], form: body['expose.contactForm'], authorization: req.headers.authorization });
        if (world.respond.contact) return answer(res, world.respond.contact);
        return json(res, {});
      }
      if (shown) world.reads[shown[1]] = (world.reads[shown[1]] ?? 0) + 1;
      if (shown && world.respond.expose[shown[1]]) return answer(res, world.respond.expose[shown[1]]);
      const listing = shown && world.listings.find(item => String(item.id) === shown[1]);
      return listing ? json(res, expose(listing)) : json(res, {}, 404);
    },
    'login.immobilienscout24.de'(req, res, body, path, url) {
      if (path === '/api/v1/authn') {
        world.lastLogin = body.username;
        return body.password === 'correct' ? json(res, { status: 'SUCCESS', sessionToken: 'session' }) : json(res, {}, 401);
      }
      if (path.endsWith('/v1/authorize')) { res.writeHead(302, { Location: `immobilienscout24.de:/loginCallback?code=code&state=${url.searchParams.get('state')}` }); return res.end(); }
      if (path.endsWith('/v1/token')) return json(res, { access_token: 'connected-token', refresh_token: 'refresh', id_token: jwt({ ssoId: 'sso-1' }), expires_in: 3600 });
      if (path.endsWith('/v1/userinfo')) return json(res, { email: world.lastLogin, ...NAMES[world.lastLogin.toLowerCase()] });
      json(res, {}, 404);
    },
    'sso.immomio.com'(req, res, body, path, url) {
      if (path.endsWith('/token')) return json(res, { access_token: jwt({}), refresh_token: 'refresh', id_token: jwt({ email: 'alex@immomio.test' }), expires_in: 3600 });
      if (path.endsWith('/openid-connect/auth')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<form action="https://sso.immomio.com/login?state=${url.searchParams.get('state')}"><input name="username"><input name="password" type="password"></form>`);
      }
      res.writeHead(302, { Location: `https://tenant.immomio.com/?code=code&state=${url.searchParams.get('state')}` });
      res.end();
    },
    'gql-ps.immomio.com'(req, res, { query, variables }) {
      if (/createApplication\(/.test(query)) world.immomioApplications.push(variables);
      json(res, { data: /createApplication\(/.test(query) ? { createApplication: { id: 'application', status: 'WAITING' } }
        : /property\(/.test(query) ? { property: { id: variables.id, rented: false, captchaSettings: { applicationSubmissionActive: false }, smsVerificationRequired: false } }
          : /checkApplicationExist/.test(query) ? { checkApplicationExist: null }
            : /customQuestions/.test(query) ? { customQuestionsByProperty: { customQuestions: [], questions: [] } }
              : { user: { id: 'immomio-user', email: 'alex@immomio.test' } } });
    },
  };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://world');
    const host = req.headers['x-e2e-host'];
    let body = {};
    try { body = JSON.parse(raw); } catch { /* Forms and empty bodies are not read. */ }
    if (!routes[host]) { world.unexpected.push(`${host}${url.pathname}`); return json(res, {}, 502); }
    routes[host](req, res, body, url.pathname, url);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  chmodSync(FAKE_CODEX, 0o755);
  t.after(async () => {
    await world.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
    assert.deepEqual(world.unexpected, [], 'the agent called a service the world does not fake');
    const cut = world.telegram.flatMap(call => call.body?.reply_markup?.inline_keyboard ?? [])
      .flatMap(row => row.filter(button => width(button.text) > ROW_WIDTH / row.length).map(button => `${button.text} (${row.length} in its row)`));
    assert.deepEqual(cut, [], 'buttons too wide for a phone');
  });
  return world;
}
