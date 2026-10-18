import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ConnectApp, verifyInitData } from '../src/connect.js';

const token = '123:secret';
function initData(user = 42, authDate = Math.floor(Date.now() / 1000), botToken = token) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'q', user: JSON.stringify({ id: user, first_name: 'Owner' }) });
  const check = [...params].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => `${key}=${value}`).join('\n');
  params.set('hash', createHmac('sha256', createHmac('sha256', 'WebAppData').update(botToken).digest()).update(check).digest('hex'));
  return params.toString();
}

test('only fresh Telegram-signed data from the owner may use the connect page', () => {
  assert.equal(verifyInitData(initData(), token, '42'), true);
  assert.equal(verifyInitData(initData(7), token, '42'), false, 'another Telegram user');
  assert.equal(verifyInitData(initData(42, 1), token, '42'), false, 'expired');
  assert.equal(verifyInitData(initData(42, undefined, '999:other'), token, '42'), false, 'signed for another bot');
  assert.equal(verifyInitData(initData().replace('Owner', 'Mallory'), token, '42'), false, 'tampered');
  assert.equal(verifyInitData('', token, '42'), false);
});

test('connect: email and password go to the session once, a 2FA code is asked, success resolves the request', async t => {
  const logins = [];
  const session = { login: async ({ email, password, askCode }) => { logins.push([email, password]); if (password === 'wrong') throw new Error('IS24 did not accept the email or password.'); logins.push(await askCode('Enter the code')); return email; } };
  const telegramApi = async () => ({ json: async () => ({ ok: true, result: { id: 1, first_name: 'Depanator' } }) });
  const app = new ConnectApp({ config: { telegramBotToken: token, chatId: '42', accountEmail: '' }, session, port: 0, fetchImpl: telegramApi });
  await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { 'X-Init-Data': initData(), 'Content-Type': 'application/json' };
  const state = async (after = 0) => (await fetch(`${base}/connect/state?after=${after}`, { headers })).json();
  const post = (path, body) => fetch(`${base}/prefix/connect/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.match(await (await fetch(`${base}/connect`)).text(), /Connect <span class="bot">/);
  assert.equal((await fetch(`${base}/connect/state`)).status, 403, 'no Telegram signature');
  assert.equal((await state()).step, 'idle', 'nothing to connect until the agent asks');

  const { done, fresh } = app.request();
  assert.equal(fresh, true);
  assert.equal(app.request().fresh, false, 'a second request joins the open one');
  assert.deepEqual(await state(), { step: 'form', message: '', version: 1, bot: 'Depanator', email: '' });
  await post('login', { email: ' Me@Example.com ', password: 'wrong' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await state()).message, 'IS24 did not accept the email or password.');
  await post('login', { email: 'me@example.com', password: 'secret' });
  await post('login', { email: 'me@example.com', password: 'again' });
  await new Promise(resolve => setImmediate(resolve));
  const asked = await state();
  assert.deepEqual([asked.step, asked.message], ['code', 'Enter the code']);
  await post('code', { code: ' 123456 ' });
  assert.equal(await done, 'me@example.com');
  assert.deepEqual(logins, [['me@example.com', 'wrong'], ['me@example.com', 'secret'], '123456'], 'one login at a time; the code is trimmed');
  assert.deepEqual([(await state()).step, (await state()).message], ['done', 'me@example.com']);
});
