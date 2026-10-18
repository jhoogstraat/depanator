import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appLogin, IS24Session } from '../src/is24-auth.js';

test('app login: password, emailed 2FA code with one retry, PKCE code exchange', async () => {
  const calls = [];
  let challenge, state;
  const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, headers: new Headers() });
  const fetchImpl = async (url, request = {}) => {
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    calls.push(url.split('?')[0].replace('https://login.immobilienscout24.de', ''));
    if (url.endsWith('/api/v1/authn')) return json({ status: 'MFA_REQUIRED', stateToken: 's1', _embedded: { factors: [{ factorType: 'push' }, { factorType: 'email', _links: { verify: { href: 'https://login.immobilienscout24.de/verify' } } }] } });
    if (url.endsWith('/verify') && !body.passCode) return json({ status: 'MFA_CHALLENGE', stateToken: 's2', _embedded: { factor: { factorType: 'email' } }, _links: { next: { href: 'https://login.immobilienscout24.de/verify' } } });
    if (url.endsWith('/verify')) return body.passCode === '123456' ? json({ status: 'SUCCESS', sessionToken: 'session' }) : json({ errorSummary: 'Invalid Passcode' }, 403);
    if (url.includes('/v1/authorize')) {
      const query = new URL(url).searchParams;
      assert.equal(query.get('sessionToken'), 'session');
      [challenge, state] = [query.get('code_challenge'), query.get('state')];
      return { ok: false, status: 302, headers: new Headers({ location: `immobilienscout24.de:/loginCallback?code=c0de&state=${state}` }) };
    }
    if (url.endsWith('/v1/token')) {
      assert.equal(body.get('code'), 'c0de');
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), challenge, 'PKCE verifier matches');
      return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const questions = [];
  const codes = ['000000', '123456'];
  const tokens = await appLogin({ email: 'me@example.com', password: 'pw', askCode: async question => { questions.push(question); return codes.shift(); }, fetchImpl });
  assert.equal(tokens.refresh_token, 'refresh');
  assert.deepEqual(questions, ['IS24 sent a security code to your email. Please enter it.', 'That code did not work. Please enter it again.']);
  assert.equal(calls.filter(call => call === '/verify').length, 3);
});

test('app login reports a wrong password plainly', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ errorSummary: 'Authentication failed' }) });
  await assert.rejects(appLogin({ email: 'me@example.com', password: 'wrong', askCode: async () => '', fetchImpl }), /did not accept the email or password/);
});

test('session: private token file, renewal once at a time, a revoked renewal key asks to connect again', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'depanator-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'is24-session.json');
  let renewals = 0, revoked = false;
  const fetchImpl = async () => {
    renewals++;
    await new Promise(resolve => setImmediate(resolve));
    return revoked ? { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) } : { ok: true, status: 200, json: async () => ({ access_token: `access${renewals}`, refresh_token: `refresh${renewals}`, expires_in: 3600 }) };
  };
  const session = new IS24Session(file, fetchImpl);
  assert.equal(session.connected, false);
  session.save({ access_token: 'old', refresh_token: 'refresh0', id_token: `x.${Buffer.from(JSON.stringify({ ssoId: 'sso-1' })).toString('base64url')}.y`, expires_in: 0 }, 'me@example.com');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(session.ssoId, 'sso-1');
  assert.deepEqual(await Promise.all([session.accessToken(), session.accessToken()]), ['access1', 'access1'], 'parallel callers share one renewal');
  assert.equal(renewals, 1);
  const reloaded = new IS24Session(file, fetchImpl);
  assert.deepEqual([reloaded.email, reloaded.ssoId, JSON.parse(readFileSync(file)).refresh_token], ['me@example.com', 'sso-1', 'refresh1'], 'survives a restart; the rotated key is kept');
  reloaded.tokens.expiresAt = 0;
  revoked = true;
  await assert.rejects(reloaded.accessToken(), error => error.code === 'LOGIN_REQUIRED');
  assert.equal(reloaded.connected, false);
  assert.equal(new IS24Session(file).connected, false, 'the revoked session is gone from disk');
});
