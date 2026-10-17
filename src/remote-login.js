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

const KEYS = new Set(['Enter', 'Backspace', 'Tab']);
const send = (res, status, type = 'text/plain', body = '', headers = {}) => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
};

// Shows the agent's IS24 login tab inside Telegram: the Mini App page polls JPEG frames of the tab
// (CDP screencast) and posts taps, typing and scrolling back. Only one login tab is attached at a time.
export class RemoteLogin {
  constructor({ config, port = 8080 }) {
    this.config = config;
    this.port = port;
    this.session = null;
  }
  listen() {
    this.server = createServer((req, res) => this.handle(req, res).catch(() => { if (!res.headersSent) send(res, 500); }));
    return new Promise(resolve => this.server.listen(this.port, resolve));
  }
  close() { this.detach(); return new Promise(resolve => (this.server ? this.server.close(() => resolve()) : resolve())); }
  // Streams `page` until it closes. Resolves when the owner taps "I'm logged in".
  async attach(page) {
    this.detach();
    const cdp = await page.createCDPSession();
    let finish;
    const session = { page, cdp, frame: null, seq: 0, waiters: new Set(), finished: new Promise(resolve => { finish = resolve; }) };
    session.finish = () => { finish(); this.wake(session); };
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      session.frame = Buffer.from(data, 'base64');
      session.seq++;
      this.wake(session);
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    page.once('close', () => { if (this.session === session) this.detach(); });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 900, maxHeight: 1900 });
    this.session = session;
    return session.finished;
  }
  detach() {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.closed = true;
    session.finish();
    session.cdp.send('Page.stopScreencast').catch(() => {});
    session.cdp.detach().catch(() => {});
  }
  wake(session) { for (const wake of session.waiters) wake(); session.waiters.clear(); }
  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // Suffix match: a reverse proxy may serve this under a path prefix.
    const path = url.pathname.match(/\/login(\/frame|\/input)?$/)?.[0];
    if (req.method === 'GET' && path === '/login') return send(res, 200, 'text/html; charset=utf-8', PAGE);
    if (!path || path === '/login') return send(res, 404);
    if (!verifyInitData(req.headers['x-init-data'], this.config.telegramBotToken, this.config.chatId)) return send(res, 403);
    const session = this.session;
    if (!session) return send(res, 204, 'text/plain', '', { 'X-State': 'idle' });
    if (path === '/login/frame') {
      // Long poll: answers with the next frame, or after 10 seconds without a change.
      if (session.seq <= Number(url.searchParams.get('after') || 0) && !session.closed) {
        await new Promise(resolve => { const timer = setTimeout(resolve, 10_000); session.waiters.add(() => { clearTimeout(timer); resolve(); }); });
      }
      if (session.closed) return send(res, 204, 'text/plain', '', { 'X-State': 'done' });
      if (!session.frame) return send(res, 204, 'text/plain', '', { 'X-State': 'loading' });
      return send(res, 200, 'image/jpeg', session.frame, { 'X-Seq': String(session.seq) });
    }
    if (req.method !== 'POST') return send(res, 405);
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 2048) return send(res, 413); }
    let input;
    try { input = JSON.parse(body); } catch { return send(res, 400); }
    await this.input(session, input);
    return send(res, 204);
  }
  async input({ page, finish }, input) {
    const { width, height } = page.viewport() || { width: 412, height: 860 };
    const fraction = value => Math.min(1, Math.max(0, Number(value) || 0));
    if (input.type === 'tap') await page.touchscreen.tap(fraction(input.x) * width, fraction(input.y) * height);
    else if (input.type === 'text' && typeof input.text === 'string') await page.keyboard.type(input.text.slice(0, 500));
    else if (input.type === 'key' && KEYS.has(input.key)) await page.keyboard.press(input.key);
    else if (input.type === 'scroll') await page.mouse.wheel({ deltaY: Math.max(-2000, Math.min(2000, Number(input.dy) || 0)) });
    else if (input.type === 'back') await page.goBack({ timeout: 10_000 }).catch(() => {});
    else if (input.type === 'done') finish();
  }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>IS24 login</title><script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>body{margin:0;font:15px system-ui;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#000)}
#screen{width:100%;display:block;touch-action:none;background:#eee;min-height:50vh}#bar{position:sticky;bottom:0;display:flex;flex-wrap:wrap;gap:6px;padding:8px;background:var(--tg-theme-secondary-bg-color,#f2f2f2)}
input{flex:1 1 100%;font-size:16px;padding:8px;border:1px solid #ccc;border-radius:8px}button{flex:1;font-size:15px;padding:8px;border:0;border-radius:8px;background:var(--tg-theme-button-color,#2481cc);color:var(--tg-theme-button-text-color,#fff)}
#msg{padding:8px;text-align:center}</style></head><body>
<div id="msg">Connecting…</div><img id="screen" alt="">
<div id="bar"><input id="text" placeholder="Tap a field above, then type here" autocomplete="off" autocapitalize="off">
<button data-t>Type</button><button data-k="Backspace">⌫</button><button data-k="Enter">↵</button><button data-k="Tab">Tab</button><button data-back>Back</button><button data-done>I'm logged in</button></div>
<script>
const tg = window.Telegram.WebApp; tg.ready(); tg.expand();
const headers = { 'X-Init-Data': tg.initData, 'Content-Type': 'application/json' };
const img = document.getElementById('screen'), msg = document.getElementById('msg'), text = document.getElementById('text');
const post = body => fetch('login/input', { method: 'POST', headers, body: JSON.stringify(body) });
let seq = 0, start = null;
async function poll() {
  for (;;) {
    let res;
    try { res = await fetch('login/frame?after=' + seq, { headers }); } catch { await new Promise(r => setTimeout(r, 2000)); continue; }
    if (res.status === 403) { msg.textContent = 'Open this page from the button in your Telegram chat with the agent.'; return; }
    const state = res.headers.get('X-State');
    if (state === 'done') { msg.textContent = '✅ Thanks! I am checking the login.'; setTimeout(() => tg.close(), 1500); return; }
    if (state === 'idle') { msg.textContent = 'No IS24 login is pending right now.'; return; }
    if (res.status === 200) { seq = Number(res.headers.get('X-Seq')); img.src = URL.createObjectURL(await res.blob()); msg.textContent = 'Tap to click, swipe to scroll. Log in, then tap “I\\'m logged in”.'; }
  }
}
img.addEventListener('load', () => URL.revokeObjectURL(img.src));
img.addEventListener('pointerdown', e => { start = { x: e.clientX, y: e.clientY }; });
img.addEventListener('pointerup', e => {
  if (!start) return; const r = img.getBoundingClientRect(), dy = start.y - e.clientY;
  if (Math.abs(dy) > 12) post({ type: 'scroll', dy: dy * 2 }); else post({ type: 'tap', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  start = null;
});
document.querySelector('[data-t]').onclick = () => { if (text.value) post({ type: 'text', text: text.value }); text.value = ''; };
for (const b of document.querySelectorAll('[data-k]')) b.onclick = () => post({ type: 'key', key: b.dataset.k });
document.querySelector('[data-back]').onclick = () => post({ type: 'back' });
document.querySelector('[data-done]').onclick = () => post({ type: 'done' });
poll();
</script></body></html>`;
