import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { claims, loginRequired, oauthToken, pkce } from './oauth.js';

// IS24's app login (Okta), used the way the IS24 Android app uses it: no website, so no robot check.
const BASE = 'https://login.immobilienscout24.de';
const ISSUER = `${BASE}/oauth2/aus1227au6oBg6hGH417`;
const CLIENT_ID = 'is24-android-de';
const REDIRECT_URI = 'immobilienscout24.de:/loginCallback';
const HEADERS = { 'User-Agent': 'okta-oauth2-kotlin/2.0.3 Android/34', Accept: 'application/json' };
// Supported 2FA methods, in order of preference, with the question for the owner.
const FACTORS = {
  'token:software:totp': 'Bitte gib den Code aus deiner Authenticator-App ein.',
  email: 'IS24 hat dir einen Sicherheitscode per E-Mail geschickt. Bitte gib ihn ein.',
  sms: 'IS24 hat dir einen Sicherheitscode per SMS geschickt. Bitte gib ihn ein.',
};

async function call(fetchImpl, url, body) {
  const res = await fetchImpl(url, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const error = new Error(res.status === 401 ? 'IS24 hat E-Mail oder Passwort nicht akzeptiert.' : `IS24-Anmeldung fehlgeschlagen: ${data.errorSummary || `HTTP ${res.status}`}`);
  error.status = res.status;
  throw error;
}

const token = (fetchImpl, params) => oauthToken(fetchImpl, `${ISSUER}/v1/token`, { client_id: CLIENT_ID, ...params }, { service: 'IS24', headers: HEADERS });

// Password (+ a 2FA code from askCode(question)) → Okta session → OAuth code with PKCE → tokens.
// The password is only sent to IS24's login service; nothing here stores or logs it.
async function appLogin({ email, password, askCode, fetchImpl = fetch }) {
  let state = await call(fetchImpl, `${BASE}/api/v1/authn`, { username: email, password });
  let retry = '';
  for (let steps = 0; state.status !== 'SUCCESS'; steps++) {
    if (steps > 8) throw new Error('Die IS24-Anmeldung wurde nicht abgeschlossen.');
    let href, type;
    if (state.status === 'MFA_REQUIRED') {
      const factor = Object.keys(FACTORS).map(kind => state._embedded?.factors?.find(entry => entry.factorType === kind)).find(Boolean);
      if (!factor) throw new Error('IS24 verlangt eine Zwei-Faktor-Methode, die ich noch nicht unterstütze.');
      // Email and SMS codes are sent by a first verify call without a code.
      if (factor.factorType !== 'token:software:totp') { state = await call(fetchImpl, factor._links.verify.href, { stateToken: state.stateToken }); continue; }
      [href, type] = [factor._links.verify.href, factor.factorType];
    } else if (state.status === 'MFA_CHALLENGE') [href, type] = [state._links.next.href, state._embedded.factor.factorType];
    else throw new Error(`Die IS24-Anmeldung blieb bei Schritt ${state.status} stehen.`);
    const passCode = String(await askCode(retry || FACTORS[type])).trim();
    try { state = await call(fetchImpl, href, { stateToken: state.stateToken, passCode }); retry = ''; }
    catch (error) { if (error.status !== 403) throw error; retry = 'Dieser Code hat nicht funktioniert. Bitte gib ihn noch einmal ein.'; }
  }
  const { verifier, state: expected, params } = pkce();
  const query = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', scope: 'openid profile offline_access', redirect_uri: REDIRECT_URI, sessionToken: state.sessionToken, ...params });
  const res = await fetchImpl(`${ISSUER}/v1/authorize?${query}`, { headers: HEADERS, redirect: 'manual' });
  const location = new URL(res.headers.get('location') || 'about:blank');
  const code = location.searchParams.get('code');
  if (!code || location.searchParams.get('state') !== expected) throw new Error(`Die IS24-Anmeldung lieferte keinen Code: ${location.searchParams.get('error_description') || `HTTP ${res.status}`}`);
  return token(fetchImpl, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT_URI });
}

// The account's email, and its name where IS24 has one (OpenID profile claims).
async function accountInfo(accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(`${ISSUER}/v1/userinfo`, { headers: { ...HEADERS, Authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`IS24-Kontoprüfung fehlgeschlagen: HTTP ${res.status}`);
  const name = value => typeof value === 'string' ? value.trim().slice(0, 60) : '';
  return { email: String(data.email || data.preferred_username || '').toLowerCase(), firstname: name(data.given_name), lastname: name(data.family_name) };
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
  // { firstname, lastname } as the account had them at login; empty strings where IS24 had none.
  get profile() { return this.tokens?.profile ?? {}; }
  // Returns the account email. The password is only passed through to IS24.
  async login({ email, password, askCode }) {
    const tokens = await appLogin({ email, password, askCode, fetchImpl: this.fetch });
    const { email: account, ...profile } = await accountInfo(tokens.access_token, this.fetch);
    if (!account) throw new Error('IS24 hat nicht gesagt, welches Konto das ist.');
    this.save(tokens, account, profile);
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
  save(tokens, email, profile = this.tokens?.profile) {
    this.tokens = { profile, access_token: tokens.access_token, refresh_token: tokens.refresh_token || this.tokens?.refresh_token, id_token: tokens.id_token || this.tokens?.id_token,
      expiresAt: Date.now() + (Number.isFinite(Number(tokens.expires_in ?? NaN)) ? Number(tokens.expires_in) : 3600) * 1000, email };
    writeFileSync(this.file, JSON.stringify(this.tokens), { mode: 0o600 });
  }
  clear() {
    this.tokens = null;
    rmSync(this.file, { force: true });
  }
}
