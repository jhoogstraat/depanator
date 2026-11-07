import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Telegram Mini App auth: Telegram signs initData with the bot token, so a valid signature proves which
// user's own Telegram app sent the request. Fresh for one hour. The user's ID, or '' if it proves nothing.
function verifiedUser(initData, botToken, now = Date.now()) {
  const params = new URLSearchParams(String(initData || ''));
  const hash = params.get('hash');
  if (!hash) return '';
  params.delete('hash');
  const check = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest('hex');
  if (expected.length !== hash.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return '';
  if (!(now / 1000 - Number(params.get('auth_date')) < 3600)) return '';
  try { return String(JSON.parse(params.get('user')).id ?? ''); } catch { return ''; }
}
export function verifyInitData(initData, botToken, ownerId, now = Date.now()) {
  return Boolean(ownerId) && verifiedUser(initData, botToken, now) === String(ownerId);
}

export const send = (res, status, type = 'text/plain', body = '', headers = {}) => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(body);
};
// A request's JSON body as { input }, or { status } to refuse it with: 413 above `limit` characters, 400 if not a JSON object.
export async function readJson(req, limit) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > limit) return { status: 413 }; }
  let input;
  try { input = JSON.parse(body); } catch { return { status: 400 }; }
  return input && typeof input === 'object' && !Array.isArray(input) ? { input } : { status: 400 }; // Always an object of fields.
}

// "Connect with ImmoScout24": a Telegram Mini App where the owner enters the IS24 email, password and any
// 2FA code. They go straight to session.login (IS24's own login service) and are never stored or logged.
// What differs per service: the page's name, logo and promises, the page path, and the email to prefill.
// Other apps (`apps`) are served by this one's server under their own path. forUser(id) -> that person's
// apps, which answer their signed requests; the others on the server only serve the page itself.
export const BRANDS = {
  is24: { name: 'ImmoScout24', path: 'connect', email: config => config.accountEmail,
    logo: '<div class="logo is24"><svg width="42" height="42" viewBox="0 0 42 42" fill="none" stroke="#1a1a1a" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"><path d="M7 20 21 8l14 12"/><path d="M11 17v16h20V17"/><path d="M18 33v-8h6v8"/></svg></div>',
    perks: ['Neue Inserate deiner Suche lesen', 'Die Bewerbungen senden, die du freigibst', 'Deinen Namen und deine Kontaktdaten darin verwenden'] },
  immomio: { name: 'Immomio', path: 'immomio', email: config => config.immomioEmail,
    logo: '<div class="logo immomio">im</div>',
    perks: ['Auf Immomio bewerben, wenn ein freigegebenes Inserat dorthin verlinkt', 'Deine Immomio-Nachrichten in diesem Chat lesen und beantworten', 'Nie Bewerbungen senden, die du nicht freigegeben hast'] },
};

// The connect flow. FLOW below is complete: `flow` changes only through these events, and any other
// (step, event) pair is ignored. The page shows the step it is at.
//
//   idle    ─request→ form
//   form    ─submit→  working   (email and password sent)
//   working ─ask→     code      (the service wants a 2FA code)
//   code    ─answer→  working
//   working ─fail→    form      (with the reason; try again)
//   working ─succeed→ done
//   done    ─request→ form
//   form, working, code ─close→ idle
//
// form, working and code hold the open `request` ({ done, resolve, reject }): the agent waits on done, asking
// again joins it, succeed resolves it and close rejects it.
// form: { message: why the last try failed }  code: { message: the question, answer(code) }  done: { message: the email, at }
const DONE_MS = 600_000; // How long an open page still shows done; then it is idle again.
const open = (state, { request }) => ({ step: 'form', message: '', request });
const close = () => ({ step: 'idle', message: '' });
const FLOW = {
  idle: { request: open },
  form: { submit: state => ({ ...state, step: 'working', message: 'Verbinde…' }), close },
  working: {
    ask: (state, { message, answer }) => ({ ...state, step: 'code', message, answer }),
    succeed: (state, { email }, now) => ({ step: 'done', message: email, at: now }),
    fail: (state, { message }) => ({ ...state, step: 'form', message }),
    close,
  },
  code: { answer: ({ answer, ...state }) => ({ ...state, step: 'working', message: 'Prüfe den Code…' }), close },
  done: { request: open },
};

export class ConnectApp {
  // bot: the Bot (telegram.js) whose name and photo the page shows.
  constructor({ config, session, bot = null, port = 8080, brand = BRANDS.is24, apps = [], forUser = () => null }) {
    Object.assign(this, { config, session, bot, port, brand, apps, forUser });
    this.route = new RegExp(`\\/${brand.path}(\\/state|\\/login|\\/code|\\/avatar)?$`);
    this.page = page(brand);
    this.flow = { step: 'idle', message: '' };
    this.version = 0; // Counts the flow's changes, so an open page's long poll answers on the next one.
    this.waiters = new Set();
  }
  listen() {
    const app = req => {
      const own = this.forUser(verifiedUser(req.headers['x-init-data'], this.config.telegramBotToken)) || [];
      return [...own, this, ...this.apps].find(candidate => candidate.route.test(new URL(req.url, 'http://localhost').pathname)) || this;
    };
    this.server = createServer((req, res) => app(req).handle(req, res).catch(() => { if (!res.headersSent) send(res, 500); }));
    return new Promise(resolve => this.server.listen(this.port, resolve));
  }
  close() {
    for (const app of this.apps) app.close();
    const { request } = this.flow;
    if (this.go({ type: 'close' })) request.reject(new Error('Der Agent wird gerade beendet.'));
    return new Promise(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
  // Applies an event to the flow and wakes every open page. False if it does not apply at this step.
  go(event) {
    const next = FLOW[this.flow.step][event.type]?.(this.flow, event, Date.now());
    if (!next) return false;
    this.flow = next;
    this.version++;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    return true;
  }
  // Starts a connection request (or joins the open one). `fresh` tells whether the owner still needs the button.
  request() {
    if (this.flow.request) return { fresh: false, done: this.flow.request.done };
    const request = {};
    request.done = new Promise((resolve, reject) => Object.assign(request, { resolve, reject }));
    this.go({ type: 'request', request });
    return { fresh: true, done: request.done };
  }
  // Runs after submit. Its events apply only while its request is still the open one (close may end it meanwhile).
  async login(email, password) {
    const { request } = this.flow;
    const go = event => this.flow.request === request && this.go(event);
    const askCode = message => new Promise((answer, refuse) => { if (!go({ type: 'ask', message, answer })) refuse(new Error('Die Anmeldung wurde abgebrochen.')); });
    try {
      const account = await this.session.login({ email, password, askCode });
      if (go({ type: 'succeed', email: account })) request.resolve(account);
    } catch (error) { go({ type: 'fail', message: error.message }); }
  }
  // What the page shows: { step, message, version }.
  state() {
    const { step, message, at } = this.flow;
    if (step === 'done' && Date.now() - at >= DONE_MS) return { step: 'idle', message: '', version: this.version };
    return { step, message, version: this.version };
  }
  // The bot's name and photo for the consent screen next to the service (Bot.profile).
  profile() { return this.bot ? this.bot.profile() : Promise.reject(new Error('No Telegram bot')); }
  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // Suffix match: a reverse proxy may serve this under a path prefix. Below, every app's path reads /connect.
    const match = url.pathname.match(this.route);
    const path = match && `/connect${match[1] || ''}`;
    if (req.method === 'GET' && path === '/connect') return send(res, 200, 'text/html; charset=utf-8', this.page);
    if (req.method === 'GET' && path === '/connect/avatar') {
      const { photo } = await this.profile().catch(() => ({}));
      return photo ? send(res, 200, 'image/jpeg', photo, { 'Cache-Control': 'max-age=3600' }) : send(res, 404);
    }
    if (!path || path === '/connect') return send(res, 404);
    if (!verifyInitData(req.headers['x-init-data'], this.config.telegramBotToken, this.config.chatId)) return send(res, 403);
    if (path === '/connect/state') {
      // Long poll while a request is open: answers on the next change, or after 10 seconds.
      if (this.flow.request && this.version <= Number(url.searchParams.get('after') || 0)) {
        await new Promise(resolve => { const timer = setTimeout(resolve, 10_000); this.waiters.add(() => { clearTimeout(timer); resolve(); }); });
      }
      const name = await this.profile().then(profile => profile.name, () => 'Dein Agent');
      return send(res, 200, 'application/json', JSON.stringify({ ...this.state(), bot: name, email: this.brand.email(this.config) || '' }));
    }
    if (req.method !== 'POST') return send(res, 405);
    const { input, status } = await readJson(req, 2048);
    if (status) return send(res, status);
    if (!this.flow.request) return send(res, 409);
    // Input that does not fit the step (a second submit, a code nobody asked for) is ignored.
    if (path === '/connect/login' && typeof input.email === 'string' && typeof input.password === 'string') {
      const email = input.email.trim().toLowerCase();
      if (email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && input.password && input.password.length <= 200 && this.go({ type: 'submit' })) this.login(email, input.password);
    } else if (path === '/connect/code' && typeof input.code === 'string' && /^\s*[\w-]{1,20}\s*$/.test(input.code)) {
      const { answer } = this.flow;
      if (this.go({ type: 'answer' })) answer(input.code.trim().slice(0, 20));
    }
    return send(res, 204);
  }
}

const page = ({ name, path, logo, perks }) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<title>${name} verbinden</title><script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:var(--tg-theme-bg-color,#fff);--text:var(--tg-theme-text-color,#111);--hint:var(--tg-theme-hint-color,#8a8a8e);--card:var(--tg-theme-secondary-bg-color,#f2f2f7);--accent:var(--tg-theme-button-color,#2481cc);--danger:var(--tg-theme-destructive-text-color,#e5484d)}
*{box-sizing:border-box}body{margin:0;font:16px/1.4 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:28px 20px calc(24px + env(safe-area-inset-bottom))}
[hidden]{display:none!important}main{max-width:420px;margin:0 auto}
.logos{display:flex;align-items:center;justify-content:center;gap:14px;margin:8px 0 22px}
.logo{width:68px;height:68px;border-radius:18px;overflow:hidden;display:grid;place-items:center;box-shadow:0 2px 10px rgba(0,0,0,.12)}
#avatar{border-radius:50%;background:var(--accent);color:#fff;font-size:34px}#avatar img{width:100%;height:100%;object-fit:cover}
.is24{background:#3ce0be}.immomio{background:#0d4f8b;color:#fff;font:700 28px/1 -apple-system,system-ui,sans-serif}.link{display:flex;gap:5px}.link i{width:6px;height:6px;border-radius:50%;background:var(--hint);opacity:.6}
h1{font-size:22px;line-height:1.25;text-align:center;margin:0 0 6px}.sub{color:var(--hint);text-align:center;margin:0 0 22px;font-size:15px}
ul{list-style:none;padding:14px 16px;margin:0 0 22px;background:var(--card);border-radius:14px}li{display:flex;gap:10px;padding:5px 0}li b{color:#2fbf71;font-weight:600}
label{display:block;font-size:13px;color:var(--hint);margin:0 0 6px 4px}
input{width:100%;font-size:17px;padding:13px 14px;border-radius:12px;border:1px solid transparent;background:var(--card);color:var(--text);margin-bottom:14px;outline:none}
input:focus{border-color:var(--accent)}#error{color:var(--danger);font-size:14px;margin:-4px 4px 14px}
.fine{font-size:13px;color:var(--hint);display:flex;gap:8px;margin-top:4px}.center{text-align:center}
.spinner{width:34px;height:34px;margin:30px auto 14px;border:3px solid var(--card);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.check{width:64px;height:64px;margin:24px auto 14px;border-radius:50%;background:#2fbf71;color:#fff;font-size:36px;display:grid;place-items:center}
#fallback{width:100%;margin-top:8px;font-size:17px;padding:14px;border:0;border-radius:12px;background:var(--accent);color:var(--tg-theme-button-text-color,#fff)}
</style></head><body><main>
<div class="logos"><div class="logo" id="avatar">🤖</div><div class="link"><i></i><i></i><i></i></div>
${logo}</div>
<section id="form" hidden>
<h1>Verbinde <span class="bot">deinen Agenten</span><br>mit ${name}</h1>
<p class="sub">Einmal anmelden. <span class="bot">Dein Agent</span> bleibt verbunden.</p>
<ul>${perks.map(perk => `<li><b>✓</b>${perk}</li>`).join('')}</ul>
<form id="login" autocomplete="on"><label for="email">${name}-E-Mail</label><input id="email" type="email" maxlength="254" autocomplete="username" inputmode="email" autocapitalize="off" required>
<label for="password">Passwort</label><input id="password" type="password" maxlength="200" autocomplete="current-password" required><div id="error" hidden></div>
<button id="fallback" hidden>Verbinden</button></form>
<p class="fine"><span>🔒</span><span>Dein Passwort geht direkt an die Anmeldung von ${name} und wird nur dafür verwendet. Es wird nie gespeichert oder jemandem gezeigt.</span></p>
</section>
<section id="code" hidden><h1>Sicherheitscode</h1><p class="sub" id="codeHint"></p>
<form id="codeForm"><input id="codeInput" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="20" pattern="[\\w\\-]{1,20}" title="Nur die Buchstaben und Ziffern des Codes" required><button id="codeFallback" hidden>Weiter</button></form></section>
<section id="working" hidden><div class="spinner"></div><p class="sub" id="workingText"></p></section>
<section id="done" hidden><div class="check">✓</div><h1>Verbunden</h1><p class="sub" id="doneText"></p></section>
<section id="idle" hidden><h1>Nichts zu verbinden</h1><p class="sub" id="idleText">Öffne diese Seite über den Button in deinem Telegram-Chat.</p></section>
</main><script>
const tg = window.Telegram.WebApp; tg.ready(); tg.expand();
const $ = id => document.getElementById(id);
const headers = { 'X-Init-Data': tg.initData, 'Content-Type': 'application/json' };
const post = (path, body) => fetch('${path}/' + path, { method: 'POST', headers, body: JSON.stringify(body) });
const main = tg.MainButton, native = Boolean(tg.initData && main);
let step = '', version = 0, submit = null;
const avatar = new Image(); avatar.onload = () => { $('avatar').textContent = ''; $('avatar').append(avatar); }; avatar.src = '${path}/avatar';
function button(text, action) {
  submit = action;
  if (!native) { $('fallback').hidden = step !== 'form'; $('codeFallback').hidden = step !== 'code'; return; }
  if (!text) return main.hide();
  main.setText(text); main.hideProgress?.(); main.enable(); main.show();
}
if (native) main.onClick(() => submit?.());
$('login').onsubmit = e => { e.preventDefault(); submit?.(); };
$('codeForm').onsubmit = e => { e.preventDefault(); submit?.(); };
function connect() {
  const email = $('email').value.trim(), password = $('password').value;
  if (!$('login').reportValidity()) return;
  post('login', { email, password }); $('password').value = ''; render({ step: 'working', message: 'Verbinde…' });
}
function sendCode() { $('codeInput').value = $('codeInput').value.trim(); if (!$('codeForm').reportValidity()) return; post('code', { code: $('codeInput').value }); $('codeInput').value = ''; render({ step: 'working', message: 'Prüfe den Code…' }); }
function render(s) {
  if (s.bot) for (const el of document.querySelectorAll('.bot')) el.textContent = s.bot;
  if (s.email && !$('email').value) $('email').value = s.email;
  const changed = s.step !== step; step = s.step;
  for (const id of ['form', 'code', 'working', 'done', 'idle']) $(id).hidden = id !== step;
  if (step === 'form') { $('error').hidden = !s.message; $('error').textContent = s.message; if (s.message) tg.HapticFeedback?.notificationOccurred('error'); button('Verbinden', connect); if (changed) ($('email').value ? $('password') : $('email')).focus(); }
  else if (step === 'code') { $('codeHint').textContent = s.message; button('Weiter', sendCode); if (changed) $('codeInput').focus(); }
  else if (step === 'working') { $('workingText').textContent = s.message; button(''); }
  else if (step === 'done') { $('doneText').textContent = 'Angemeldet als ' + s.message + '. Du kannst diese Seite schließen.'; button(''); if (changed) { tg.HapticFeedback?.notificationOccurred('success'); setTimeout(() => tg.close(), 1800); } }
  else button('');
}
async function poll() {
  for (;;) {
    let res;
    try { res = await fetch('${path}/state?after=' + version, { headers }); } catch { await new Promise(r => setTimeout(r, 2000)); continue; }
    if (res.status === 403) return render({ step: 'idle' });
    const s = await res.json(); version = s.version;
    if (!(step === 'working' && s.step === 'form' && !s.message)) render(s);
    if (s.step === 'done' || s.step === 'idle') return;
  }
}
poll();
</script></body></html>`;
