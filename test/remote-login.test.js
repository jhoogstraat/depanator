import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { RemoteLogin, verifyInitData } from '../src/remote-login.js';

const token = '123:secret';
function initData(user = 42, authDate = Math.floor(Date.now() / 1000), botToken = token) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'q', user: JSON.stringify({ id: user, first_name: 'Owner' }) });
  const check = [...params].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => `${key}=${value}`).join('\n');
  params.set('hash', createHmac('sha256', createHmac('sha256', 'WebAppData').update(botToken).digest()).update(check).digest('hex'));
  return params.toString();
}

test('only fresh Telegram-signed data from the owner may drive the login tab', () => {
  assert.equal(verifyInitData(initData(), token, '42'), true);
  assert.equal(verifyInitData(initData(7), token, '42'), false, 'another Telegram user');
  assert.equal(verifyInitData(initData(42, 1), token, '42'), false, 'expired');
  assert.equal(verifyInitData(initData(42, undefined, '999:other'), token, '42'), false, 'signed for another bot');
  assert.equal(verifyInitData(initData().replace('Owner', 'Mallory'), token, '42'), false, 'tampered');
  assert.equal(verifyInitData('', token, '42'), false);
});

test('Mini App streams the tab, forwards taps and typing, and ends on "I\'m logged in"', async t => {
  const remote = new RemoteLogin({ config: { telegramBotToken: token, chatId: '42' }, port: 0 });
  await remote.listen();
  t.after(() => remote.close());
  const base = `http://127.0.0.1:${remote.server.address().port}`;
  const headers = { 'X-Init-Data': initData(), 'Content-Type': 'application/json' };
  assert.match(await (await fetch(`${base}/login`)).text(), /telegram-web-app\.js/);
  assert.equal((await fetch(`${base}/login/frame`)).status, 403, 'no Telegram signature');
  assert.equal((await fetch(`${base}/login/frame`, { headers })).headers.get('X-State'), 'idle');

  const cdp = new EventEmitter();
  cdp.send = async () => {}; cdp.detach = async () => {};
  const actions = [];
  const page = new EventEmitter();
  Object.assign(page, { createCDPSession: async () => cdp, viewport: () => ({ width: 400, height: 800 }),
    touchscreen: { tap: async (x, y) => actions.push(['tap', x, y]) }, keyboard: { type: async text => actions.push(['type', text]), press: async key => actions.push(['press', key]) } });
  const finished = remote.attach(page);
  await new Promise(resolve => setImmediate(resolve));
  const frame = fetch(`${base}/prefix/login/frame?after=0`, { headers });
  cdp.emit('Page.screencastFrame', { data: Buffer.from('jpeg-bytes').toString('base64'), sessionId: 1 });
  const response = await frame;
  assert.deepEqual([response.status, response.headers.get('X-Seq'), await response.text()], [200, '1', 'jpeg-bytes']);

  for (const body of [{ type: 'tap', x: 0.5, y: 0.25 }, { type: 'text', text: 'me@example.com' }, { type: 'key', key: 'Enter' }, { type: 'key', key: 'Delete' }, { type: 'eval', code: 'alert(1)' }]) {
    await fetch(`${base}/login/input`, { method: 'POST', headers, body: JSON.stringify(body) });
  }
  assert.deepEqual(actions, [['tap', 200, 200], ['type', 'me@example.com'], ['press', 'Enter']], 'unknown keys and actions are ignored');
  await fetch(`${base}/login/input`, { method: 'POST', headers, body: JSON.stringify({ type: 'done' }) });
  await finished;
});
