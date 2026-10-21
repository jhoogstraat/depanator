import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOnImmomio, immomioPropertyId, keycloakLogin, ImmomioSession, loginForm } from '../src/immomio.js';
import { IS24Adapter } from '../src/is24.js';
import { configHashFor } from '../src/review.js';

const id = 'a2235409-96c7-40d1-bce1-5527e53525e3';
const other = 'b2235409-96c7-40d1-bce1-5527e53525e3';
const searchUrl = 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten';

test('one distinct Immomio apply link routes a listing; none or several do not', () => {
  assert.equal(immomioPropertyId(`Bitte bewerben: https://tenant.immomio.com/apply/${id} oder tenant.immomio.com/de/apply/${id.toUpperCase()}`), id);
  assert.equal(immomioPropertyId(`https://tenant.immomio.com/apply/${id} https://tenant.immomio.com/apply/${other}`), null);
  assert.equal(immomioPropertyId(`https://tenant.immomio.com.evil.test/apply/${id}`), null);
  assert.equal(immomioPropertyId('Kontakt über IS24'), null);
});

test('an unset Immomio account keeps every existing approval binding', () => {
  const config = { searchUrl, accountEmail: 'me@example.com', persona: { vorname: 'Me' } };
  assert.equal(configHashFor({ ...config, immomioEmail: '' }), configHashFor(config));
  assert.notEqual(configHashFor({ ...config, immomioEmail: 'me@example.com' }), configHashFor(config));
});

// A Keycloak login: email/password form, then a one-time code, then the redirect with the code.
const jwt = claims => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const SSO = 'https://sso.immomio.com/auth/realms/immomio';
const page = body => ({ ok: true, status: 200, headers: { get: () => null, getSetCookie: () => [] }, text: async () => body });
function keycloak({ password = 'secret', code = '123456', tokenError = null } = {}) {
  const seen = [];
  let state;
  const fetch = async (url, init = {}) => {
    const target = new URL(url);
    const body = new URLSearchParams(init.body || '');
    seen.push([init.method || 'GET', target.pathname, Object.fromEntries(body), init.headers?.Cookie]);
    if (target.pathname.endsWith('/openid-connect/auth')) {
      state = target.searchParams.get('state');
      return { ...page(`<form id="kc-form-login" action="${SSO}/login-actions/authenticate?session_code=a&amp;execution=b"><input type="hidden" name="credentialId" value=""><input name="username"><input name="password" type="password"></form>`),
        headers: { get: () => null, getSetCookie: () => ['AUTH_SESSION_ID=abc; Path=/auth/realms/immomio/; Secure'] } };
    }
    if (target.pathname.endsWith('/token')) {
      if (tokenError) return { ok: false, status: 400, json: async () => ({ error: tokenError }) };
      return { ok: true, status: 200, json: async () => ({ access_token: jwt({}), refresh_token: 'r1', id_token: jwt({ email: 'Me@Example.com' }), expires_in: 300 }) };
    }
    if (body.has('password')) return body.get('password') === password ? page(`<form action="${SSO}/login-actions/authenticate?execution=otp"><input name="otp"></form>`) : page(`<form action="${SSO}/login-actions/authenticate?x=1"><input name="username"><input name="password"></form>`);
    if (body.has('otp')) return body.get('otp') === code
      ? { ok: false, status: 302, headers: { get: name => name === 'location' ? `https://tenant.immomio.com/?state=${state}&code=C1` : null, getSetCookie: () => [] } }
      : page(`<form action="${SSO}/login-actions/authenticate?execution=otp"><input name="otp"></form>`);
    throw new Error(`unexpected ${url}`);
  };
  return { fetch, seen };
}

test('Keycloak login: password, then a retried one-time code, with the login cookie; tokens via PKCE', async () => {
  const { fetch, seen } = keycloak();
  const questions = [];
  const codes = ['000000', '123456'];
  const tokens = await keycloakLogin({ email: 'me@example.com', password: 'secret', askCode: async question => { questions.push(question); return codes.shift(); }, fetchImpl: fetch });
  assert.equal(tokens.refresh_token, 'r1');
  assert.deepEqual(questions, ['Immomio asks for a security code. Please enter it.', 'That code did not work. Please enter it again.']);
  const [, login] = seen;
  assert.deepEqual(login, ['POST', '/auth/realms/immomio/login-actions/authenticate', { credentialId: '', username: 'me@example.com', password: 'secret' }, 'AUTH_SESSION_ID=abc']);
  const exchange = seen.at(-1)[2];
  assert.deepEqual([exchange.grant_type, exchange.code, exchange.client_id, exchange.code_verifier.length > 40], ['authorization_code', 'C1', 'immomio-oidc-web', true]);
  await assert.rejects(keycloakLogin({ email: 'me@example.com', password: 'wrong', askCode: async () => '', fetchImpl: keycloak().fetch }), /did not accept the email or password/);
  assert.equal(loginForm('<form action="/x"><input name="firstName"></form>'), null, 'an unknown required step is not answered');
});

test('Immomio session: stores tokens privately with the account email; an expired renewal asks to reconnect', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'immomio-')), 'session.json');
  const session = new ImmomioSession(file, keycloak().fetch);
  assert.equal(await session.login({ email: 'me@example.com', password: 'secret', askCode: async () => '123456' }), 'me@example.com');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(await session.accessToken(), jwt({}));
  const expired = new ImmomioSession(file, keycloak({ tokenError: 'invalid_grant' }).fetch);
  expired.tokens.expiresAt = 0;
  await assert.rejects(expired.accessToken(), error => error.code === 'LOGIN_REQUIRED');
  assert.equal(expired.connected, false);
});

// Answers each GraphQL operation; overrides change one answer.
function graphql(overrides = {}) {
  const calls = [];
  const answers = { user: { user: { id: 'u1', email: 'me@immomio.test' } }, property: { property: { id, rented: false, captchaSettings: { applicationSubmissionActive: false }, smsVerificationRequired: false } },
    checkApplicationExist: { checkApplicationExist: null }, createApplication: { createApplication: { id: 'app1', status: 'WAITING_FOR_LANDLORD' } },
    customQuestionsByProperty: { customQuestionsByProperty: { customQuestions: [{ id: 'q' }], questions: [] } }, ...overrides };
  const gql = async query => {
    const op = Object.keys(answers).find(name => new RegExp(`\\b${name}\\b[ ({]`).test(query));
    calls.push(op);
    if (answers[op] instanceof Error) throw answers[op];
    return answers[op];
  };
  return { gql, calls };
}
const options = (extra = {}) => ({ accountEmail: 'me@immomio.test', beforeSubmit: async () => true, onSubmitAttempt: () => {}, ...extra });

test('Immomio: applies once after the last approval check and reports open landlord questions', async () => {
  const { gql, calls } = graphql();
  const order = [];
  const { detail } = await applyOnImmomio(gql, id, options({ beforeSubmit: async () => { order.push('approval'); return true; }, onSubmitAttempt: () => order.push('attempt') }));
  assert.deepEqual(order, ['approval', 'attempt']);
  assert.deepEqual(calls, ['user', 'property', 'checkApplicationExist', 'createApplication', 'customQuestionsByProperty']);
  assert.match(detail, /asks 1 question/);
});

test('Immomio: fails closed before any attempt', async () => {
  const property = changes => ({ property: { property: { id, rented: false, captchaSettings: { applicationSubmissionActive: false }, smsVerificationRequired: false, ...changes } } });
  for (const [overrides, error] of [
    [{ user: { user: { id: 'u1', email: 'someone@else.test' } } }, /differs/],
    [property({ rented: true }), /no longer available/],
    [property({ captchaSettings: { applicationSubmissionActive: true } }), /captcha.*apply yourself/],
    [property({ smsVerificationRequired: true }), /SMS/],
    [{ checkApplicationExist: { checkApplicationExist: { id: 'old' } } }, /already applied/],
  ]) {
    const { gql, calls } = graphql(overrides);
    let attempted = false;
    await assert.rejects(applyOnImmomio(gql, id, options({ onSubmitAttempt: () => { attempted = true; } })), error);
    assert.equal(attempted, false);
    assert.ok(!calls.includes('createApplication'));
  }
  const { gql, calls } = graphql();
  await assert.rejects(applyOnImmomio(gql, id, options({ beforeSubmit: async () => false })), /Approval/);
  assert.ok(!calls.includes('createApplication'));
});

const expose = text => ({ sections: [
  { type: 'TOP_ATTRIBUTES', attributes: [{ label: 'Zimmer', text: '2' }, { label: 'Wohnfläche', text: '50 m²' }, { label: 'Warmmiete', text: '900 €' }] },
  { type: 'TITLE', title: 'Home' }, { type: 'MAP', addressLine1: 'Street 1', addressLine2: 'Berlin' }, { type: 'TEXT_AREA', title: 'Objektbeschreibung', text },
] });
function immomioAdapter({ immomioEmail = 'me@immomio.test', createStatus = 200 } = {}) {
  const requests = [];
  const answers = graphql().gql;
  const fetch = async (url, request = {}) => {
    requests.push(url);
    if (url.startsWith('https://gql-ps.immomio.com')) {
      const { query } = JSON.parse(request.body);
      if (/createApplication\(/.test(query) && createStatus !== 200) return { ok: false, status: createStatus, json: async () => null };
      return { ok: true, status: 200, json: async () => ({ data: await answers(query) }) };
    }
    if (request.method === 'POST') return { ok: true, status: 200, text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => expose(`Bewerbung nur über https://tenant.immomio.com/apply/${id}`) };
  };
  const config = { searchUrl, maxPages: 1, accountEmail: 'me@example.com', immomioEmail, persona: { vorname: 'Me', nachname: 'Example', email: 'me@example.com' } };
  const adapter = new IS24Adapter(config, { fetch, session: { email: 'me@example.com', accessToken: async () => 'is24' }, immomio: { email: 'me@immomio.test', accessToken: async () => 'immomio' } });
  return { adapter, requests };
}

test('a listing linking to Immomio is applied there, never contacted on IS24', async () => {
  const { adapter, requests } = immomioAdapter();
  const snapshot = await adapter.details({ expose_id: '123' });
  assert.deepEqual(snapshot.immomio, { propertyId: id, url: `https://tenant.immomio.com/apply/${id}` });
  const result = await adapter.send({ snapshot, draft: 'Apply on Immomio' }, { beforeSubmit: async () => true });
  assert.equal(result.outcome, 'sent');
  assert.ok(!requests.some(url => url.includes('/contact')), 'no IS24 contact request');
  assert.equal((await immomioAdapter({ createStatus: 502 }).adapter.send({ snapshot, draft: '' }, { beforeSubmit: async () => true })).outcome, 'unknown_outcome', 'a failed create may still have arrived');
  const unconnected = immomioAdapter({ immomioEmail: '' });
  await unconnected.adapter.send({ snapshot, draft: 'Hallo!' }, { beforeSubmit: async () => true });
  assert.ok(unconnected.requests.some(url => url.includes('/contact')), 'without an Immomio account, IS24 contact as before');
});

test('an Immomio listing arrives as one card that shows and approves the application, with nothing to write', async () => {
  const { Telegram } = await import('../src/telegram.js');
  const sent = [];
  const fetchImpl = async (url, request) => { sent.push(JSON.parse(request.body)); return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: sent.length } }) }; };
  const config = { telegramBotToken: '1:x', chatId: '42', dataDir: mkdtempSync(join(tmpdir(), 'tg-')), immomioEmail: 'me@immomio.test' };
  const telegram = new Telegram({ config, store: { recordTelegramMessage: () => {} }, fetchImpl });
  const snapshot = { expose_id: '123', title: 'Home', address: 'Berlin', price: 900, area: 50, rooms: 2, description: 'x', immomio: { propertyId: id, url: `https://tenant.immomio.com/apply/${id}` } };
  await telegram.notify({ id: '00000000-0000-0000-0000-000000000001', exposeId: '123', version: 1, snapshot, draft: 'Apply on Immomio with your profile', draftHash: 'h', snapshotHash: 's' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Apply on Immomio with your profile/);
  assert.deepEqual(sent[0].reply_markup.inline_keyboard[0].map(button => button.text), ['✅ Apply on Immomio', '✖️ Dismiss']);
});
