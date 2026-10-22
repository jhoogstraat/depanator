import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Telegram Mini App auth: Telegram signs initData with the bot token, so a valid signature for the
// owner's user ID proves the request comes from the owner's own Telegram app. Fresh for one hour.
export function verifyInitData(initData, botToken, ownerId, now = Date.now()) {
  const params = new URLSearchParams(String(initData || ''));
  const hash = params.get('hash');
  if (!hash || !ownerId) return false;
  params.delete('hash');
  const check = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest('hex');
  if (expected.length !== hash.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return false;
  if (!(now / 1000 - Number(params.get('auth_date')) < 3600)) return false;
  try { return String(JSON.parse(params.get('user')).id) === String(ownerId); } catch { return false; }
}

const send = (res, status, type = 'text/plain', body = '', headers = {}) => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
};

// "Connect with ImmoScout24": a Telegram Mini App where the owner enters the IS24 email, password and any
// 2FA code. They go straight to session.login (IS24's own login service) and are never stored or logged.
// Steps: form → working → (code → working) → done; a failure returns to the form with the reason.
// What differs per service: the page's name, logo and promises, the page path, and the email to prefill.
// Other apps (`apps`) are served by this one's server under their own path.
export const BRANDS = {
  is24: { name: 'ImmoScout24', path: 'connect', email: config => config.accountEmail,
    logo: '<div class="logo is24"><svg width="42" height="42" viewBox="0 0 42 42" fill="none" stroke="#1a1a1a" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"><path d="M7 20 21 8l14 12"/><path d="M11 17v16h20V17"/><path d="M18 33v-8h6v8"/></svg></div>',
    perks: ['Read new listings of your search', 'Send the applications you approve', 'Use your name and contact details in them'] },
  immomio: { name: 'Immomio', path: 'immomio', email: config => config.immomioEmail,
    logo: '<div class="logo immomio">im</div>',
    perks: ['Apply on Immomio when an approved listing links there', 'Use your Immomio profile for those applications', 'Never send applications you did not approve'] },
};
export class ConnectApp {
  constructor({ config, session, port = 8080, fetchImpl = fetch, brand = BRANDS.is24, apps = [] }) {
    Object.assign(this, { config, session, port, fetch: fetchImpl, brand, apps });
    this.route = new RegExp(`\\/${brand.path}(\\/state|\\/login|\\/code|\\/avatar)?$`);
    this.page = page(brand);
    this.pending = null;
    this.connected = null; // { email, at } of the last success, so the open page can show it.
  }
  listen() {
    const app = req => [this, ...this.apps].find(candidate => candidate.route.test(new URL(req.url, 'http://localhost').pathname)) || this;
    this.server = createServer((req, res) => app(req).handle(req, res).catch(() => { if (!res.headersSent) send(res, 500); }));
    return new Promise(resolve => this.server.listen(this.port, resolve));
  }
  close() {
    for (const app of this.apps) app.close();
    this.pending?.reject(new Error('Shutting down'));
    this.pending = null;
    return new Promise(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
  // Starts a connection request (or joins the open one). `fresh` tells whether the owner still needs the button.
  request() {
    if (this.pending) return { fresh: false, done: this.pending.done };
    let resolve, reject;
    const done = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    // step: form → working → (code → working) → done, or back to form with the reason. code: answers the open code question.
    this.pending = { done, resolve, reject, step: 'form', message: '', version: 1, waiters: new Set(), code: null };
    return { fresh: true, done };
  }
  show(pending, step, message = '') {
    Object.assign(pending, { step, message });
    pending.version++;
    for (const wake of pending.waiters) wake();
    pending.waiters.clear();
  }
  async login(pending, email, password) {
    this.show(pending, 'working', 'Connecting…');
    try {
      const account = await this.session.login({ email, password, askCode: message => new Promise(resolve => { pending.code = resolve; this.show(pending, 'code', message); }) });
      this.connected = { email: account, at: Date.now() };
      if (this.pending === pending) this.pending = null;
      this.show(pending, 'done', account);
      pending.resolve(account);
    } catch (error) {
      this.show(pending, 'form', error.message);
    } finally { pending.code = null; }
  }
  state() {
    const pending = this.pending;
    if (pending) return { step: pending.step, message: pending.message, version: pending.version };
    if (this.connected && Date.now() - this.connected.at < 600_000) return { step: 'done', message: this.connected.email, version: 0 };
    return { step: 'idle', message: '', version: 0 };
  }
  async telegram(method, body = {}) {
    const res = await this.fetch(`https://api.telegram.org/bot${this.config.telegramBotToken}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description);
    return data.result;
  }
  // The bot's name and profile photo, shown on the consent screen next to ImmoScout24.
  bot() {
    this.botInfo ??= (async () => {
      const me = await this.telegram('getMe');
      let photo = null;
      try {
        const sizes = (await this.telegram('getUserProfilePhotos', { user_id: me.id, limit: 1 })).photos[0];
        if (sizes) {
          const file = await this.telegram('getFile', { file_id: sizes[Math.min(1, sizes.length - 1)].file_id });
          const res = await this.fetch(`https://api.telegram.org/file/bot${this.config.telegramBotToken}/${file.file_path}`);
          if (res.ok) photo = Buffer.from(await res.arrayBuffer());
        }
      } catch { /* No photo: the page shows a placeholder. */ }
      return { name: me.first_name || me.username || 'Your agent', photo };
    })().catch(error => { this.botInfo = null; throw error; });
    return this.botInfo;
  }
  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // Suffix match: a reverse proxy may serve this under a path prefix. Below, every app's path reads /connect.
    const match = url.pathname.match(this.route);
    const path = match && `/connect${match[1] || ''}`;
    if (req.method === 'GET' && path === '/connect') return send(res, 200, 'text/html; charset=utf-8', this.page);
    if (req.method === 'GET' && path === '/connect/avatar') {
      const { photo } = await this.bot().catch(() => ({}));
      return photo ? send(res, 200, 'image/jpeg', photo, { 'Cache-Control': 'max-age=3600' }) : send(res, 404);
    }
    if (!path || path === '/connect') return send(res, 404);
    if (!verifyInitData(req.headers['x-init-data'], this.config.telegramBotToken, this.config.chatId)) return send(res, 403);
    if (path === '/connect/state') {
      // Long poll: answers on the next change, or after 10 seconds.
      const pending = this.pending;
      if (pending && pending.version <= Number(url.searchParams.get('after') || 0)) {
        await new Promise(resolve => { const timer = setTimeout(resolve, 10_000); pending.waiters.add(() => { clearTimeout(timer); resolve(); }); });
      }
      const name = await this.bot().then(bot => bot.name, () => 'Your agent');
      return send(res, 200, 'application/json', JSON.stringify({ ...(pending && pending !== this.pending ? { step: pending.step, message: pending.message, version: pending.version } : this.state()), bot: name, email: this.brand.email(this.config) || '' }));
    }
    if (req.method !== 'POST') return send(res, 405);
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 2048) return send(res, 413); }
    let input;
    try { input = JSON.parse(body); } catch { return send(res, 400); }
    const pending = this.pending;
    if (!pending) return send(res, 409);
    if (path === '/connect/login' && pending.step === 'form' && typeof input.email === 'string' && typeof input.password === 'string') {
      const email = input.email.trim().toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && input.password && input.password.length <= 200) this.login(pending, email, input.password);
    } else if (path === '/connect/code' && pending.step === 'code' && typeof input.code === 'string') {
      const resolve = pending.code;
      pending.code = null;
      this.show(pending, 'working', 'Checking the code…');
      resolve(input.code.trim().slice(0, 20));
    }
    return send(res, 204);
  }
}

const page = ({ name, path, logo, perks }) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<title>Connect ${name}</title><script src="https://telegram.org/js/telegram-web-app.js"></script>
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
<h1>Connect <span class="bot">your agent</span><br>with ${name}</h1>
<p class="sub">Log in once. <span class="bot">Your agent</span> stays connected.</p>
<ul>${perks.map(perk => `<li><b>✓</b>${perk}</li>`).join('')}</ul>
<form id="login" autocomplete="on"><label for="email">${name} email</label><input id="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" required>
<label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required><div id="error" hidden></div>
<button id="fallback" hidden>Connect</button></form>
<p class="fine"><span>🔒</span><span>Your password goes directly to ${name}'s login and is used only for this login. It is never stored or shown to anyone.</span></p>
</section>
<section id="code" hidden><h1>Security code</h1><p class="sub" id="codeHint"></p>
<form id="codeForm"><input id="codeInput" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" required><button id="codeFallback" hidden>Continue</button></form></section>
<section id="working" hidden><div class="spinner"></div><p class="sub" id="workingText"></p></section>
<section id="done" hidden><div class="check">✓</div><h1>Connected</h1><p class="sub" id="doneText"></p></section>
<section id="idle" hidden><h1>Nothing to connect</h1><p class="sub" id="idleText">Open this page from the button in your Telegram chat.</p></section>
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
  post('login', { email, password }); $('password').value = ''; render({ step: 'working', message: 'Connecting…' });
}
function sendCode() { if (!$('codeInput').value.trim()) return; post('code', { code: $('codeInput').value }); $('codeInput').value = ''; render({ step: 'working', message: 'Checking the code…' }); }
function render(s) {
  if (s.bot) for (const el of document.querySelectorAll('.bot')) el.textContent = s.bot;
  if (s.email && !$('email').value) $('email').value = s.email;
  const changed = s.step !== step; step = s.step;
  for (const id of ['form', 'code', 'working', 'done', 'idle']) $(id).hidden = id !== step;
  if (step === 'form') { $('error').hidden = !s.message; $('error').textContent = s.message; if (s.message) tg.HapticFeedback?.notificationOccurred('error'); button('Connect', connect); if (changed) ($('email').value ? $('password') : $('email')).focus(); }
  else if (step === 'code') { $('codeHint').textContent = s.message; button('Continue', sendCode); if (changed) $('codeInput').focus(); }
  else if (step === 'working') { $('workingText').textContent = s.message; button(''); }
  else if (step === 'done') { $('doneText').textContent = 'Signed in as ' + s.message + '. You can close this page.'; button(''); if (changed) { tg.HapticFeedback?.notificationOccurred('success'); setTimeout(() => tg.close(), 1800); } }
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
