import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

// IS24's app login (Okta), used the way the IS24 Android app uses it: no website, so no robot check.
const BASE = 'https://login.immobilienscout24.de';
const ISSUER = `${BASE}/oauth2/aus1227au6oBg6hGH417`;
const CLIENT_ID = 'is24-android-de';
const REDIRECT_URI = 'immobilienscout24.de:/loginCallback';
const HEADERS = { 'User-Agent': 'okta-oauth2-kotlin/2.0.3 Android/34', Accept: 'application/json' };
// Supported 2FA methods, in order of preference, with the question for the owner.
const FACTORS = {
  'token:software:totp': 'Please enter the code from your authenticator app.',
  email: 'IS24 sent a security code to your email. Please enter it.',
  sms: 'IS24 sent a security code by SMS. Please enter it.',
};

async function call(fetchImpl, url, body) {
  const res = await fetchImpl(url, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const error = new Error(res.status === 401 ? 'IS24 did not accept the email or password.' : `IS24 login failed: ${data.errorSummary || `HTTP ${res.status}`}`);
  error.status = res.status;
  throw error;
}

async function token(fetchImpl, params) {
  const res = await fetchImpl(`${ISSUER}/v1/token`, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CLIENT_ID, ...params }) });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.access_token) return data;
  const error = new Error(`IS24 login failed: ${data.error_description || data.error || `HTTP ${res.status}`}`);
  if (data.error === 'invalid_grant') error.code = 'LOGIN_REQUIRED'; // The renewal key expired or was revoked.
  throw error;
}

// Password (+ a 2FA code from askCode(question)) → Okta session → OAuth code with PKCE → tokens.
// The password is only sent to IS24's login service; nothing here stores or logs it.
export async function appLogin({ email, password, askCode, fetchImpl = fetch }) {
  let state = await call(fetchImpl, `${BASE}/api/v1/authn`, { username: email, password });
  let retry = '';
  for (let steps = 0; state.status !== 'SUCCESS'; steps++) {
    if (steps > 8) throw new Error('IS24 login did not finish');
    let href, type;
    if (state.status === 'MFA_REQUIRED') {
      const factor = Object.keys(FACTORS).map(kind => state._embedded?.factors?.find(entry => entry.factorType === kind)).find(Boolean);
      if (!factor) throw new Error('IS24 asks for a 2FA method I do not support yet');
      // Email and SMS codes are sent by a first verify call without a code.
      if (factor.factorType !== 'token:software:totp') { state = await call(fetchImpl, factor._links.verify.href, { stateToken: state.stateToken }); continue; }
      [href, type] = [factor._links.verify.href, factor.factorType];
    } else if (state.status === 'MFA_CHALLENGE') [href, type] = [state._links.next.href, state._embedded.factor.factorType];
    else throw new Error(`IS24 login stopped at step ${state.status}`);
    const passCode = String(await askCode(retry || FACTORS[type])).trim();
    try { state = await call(fetchImpl, href, { stateToken: state.stateToken, passCode }); retry = ''; }
    catch (error) { if (error.status !== 403) throw error; retry = 'That code did not work. Please enter it again.'; }
  }
  const verifier = randomBytes(32).toString('base64url');
  const expected = randomBytes(16).toString('base64url');
  const query = new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', scope: 'openid profile offline_access', redirect_uri: REDIRECT_URI,
    state: expected, nonce: randomBytes(16).toString('base64url'), sessionToken: state.sessionToken,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  const res = await fetchImpl(`${ISSUER}/v1/authorize?${query}`, { headers: HEADERS, redirect: 'manual' });
  const location = new URL(res.headers.get('location') || 'about:blank');
  const code = location.searchParams.get('code');
  if (!code || location.searchParams.get('state') !== expected) throw new Error(`IS24 login returned no code: ${location.searchParams.get('error_description') || `HTTP ${res.status}`}`);
  return token(fetchImpl, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT_URI });
}

export async function accountEmail(accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(`${ISSUER}/v1/userinfo`, { headers: { ...HEADERS, Authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`IS24 account check failed: HTTP ${res.status}`);
  return String(data.email || data.preferred_username || '').toLowerCase();
}

const claims = jwt => { try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')); } catch { return {}; } };
export function loginRequired(message = 'IS24 login required') {
  const error = new Error(message);
  error.code = 'LOGIN_REQUIRED';
  return error;
}

// The connected IS24 account: tokens in a private file (0600) of the data directory. Access tokens last
// hours and are renewed with the refresh token, so the owner logs in again only when IS24 revokes it.
export class IS24Session {
  constructor(file, fetchImpl = fetch) {
    this.file = file;
    this.fetch = fetchImpl;
    try { this.tokens = JSON.parse(readFileSync(file, 'utf8')); } catch { this.tokens = null; }
    this.renewing = null;
  }
  get connected() { return Boolean(this.tokens?.refresh_token); }
  get email() { return this.tokens?.email || ''; }
  get ssoId() { return claims(this.tokens?.id_token || '').ssoId || ''; }
  // Returns the account email. The password is only passed through to IS24.
  async login({ email, password, askCode }) {
    const tokens = await appLogin({ email, password, askCode, fetchImpl: this.fetch });
    const account = await accountEmail(tokens.access_token, this.fetch);
    if (!account) throw new Error('IS24 did not tell which account this is');
    this.save(tokens, account);
    return account;
  }
  async accessToken() {
    if (!this.connected) throw loginRequired();
    if (Date.now() < this.tokens.expiresAt - 60_000) return this.tokens.access_token;
    // One renewal at a time: IS24 may rotate the refresh token, so a parallel renewal would use a spent one.
    this.renewing ??= this.renew(this.tokens.refresh_token)
      .then(tokens => this.save(tokens, this.email), error => { if (error.code === 'LOGIN_REQUIRED') this.clear(); throw error; })
      .finally(() => { this.renewing = null; });
    await this.renewing;
    return this.tokens.access_token;
  }
  renew(refreshToken) { return token(this.fetch, { grant_type: 'refresh_token', refresh_token: refreshToken }); }
  save(tokens, email) {
    this.tokens = { access_token: tokens.access_token, refresh_token: tokens.refresh_token || this.tokens?.refresh_token, id_token: tokens.id_token || this.tokens?.id_token,
      expiresAt: Date.now() + (Number.isFinite(Number(tokens.expires_in ?? NaN)) ? Number(tokens.expires_in) : 3600) * 1000, email };
    writeFileSync(this.file, JSON.stringify(this.tokens), { mode: 0o600 });
  }
  clear() {
    this.tokens = null;
    rmSync(this.file, { force: true });
  }
}
