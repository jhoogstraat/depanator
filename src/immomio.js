import { createHash, randomBytes } from 'node:crypto';
import { IS24Session, loginRequired } from './is24-auth.js';

// Immomio: some landlords take applications only there and link the apply page in the IS24 description.
// Applying uses the tenant app's GraphQL API with the account's Immomio profile; no message is written.
export const IMMOMIO_APP = 'https://tenant.immomio.com';
const GRAPHQL = 'https://gql-ps.immomio.com/tenant/graphql';
// The tenant app's Keycloak login (realm and client from its public `sso` query).
const SSO = 'https://sso.immomio.com/auth/realms/immomio/protocol/openid-connect';
const CLIENT_ID = 'immomio-oidc-web';
const REDIRECT_URI = `${IMMOMIO_APP}/`;
const LINK = /(?:https?:\/\/)?tenant\.immomio\.com\/(?:[a-z]{2}\/)?(?:properties\/)?apply\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

export const immomioUrl = id => `${IMMOMIO_APP}/apply/${id}`;
// Only with a connected Immomio account; otherwise the listing gets the IS24 contact request.
export const usesImmomio = (snapshot, config) => Boolean(snapshot?.immomio && config.immomioEmail);
export const immomioDraft = (config, snapshot) => `Apply on Immomio with your profile (${config.immomioEmail}): ${snapshot.immomio.url}\nNo message is sent; the landlord sees your Immomio profile.`;

// One distinct apply link routes the listing to Immomio; none or several keep the IS24 contact request.
export function immomioPropertyId(text) {
  const ids = new Set([...String(text || '').matchAll(LINK)].map(match => match[1].toLowerCase()));
  return ids.size === 1 ? [...ids][0] : null;
}

const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
const unescape = value => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => code[0] === '#'
  ? String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : entities[code.toLowerCase()] ?? all);
const attribute = (tag, name) => { const match = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag); return match ? unescape(match[1]) : null; };
// The Keycloak page's form that asks for the email, the password or a one-time code.
export function loginForm(html) {
  for (const [, open, body] of String(html).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const inputs = [...body.matchAll(/<input\b[^>]*>/gi)].map(([tag]) => ({ name: attribute(tag, 'name'), type: (attribute(tag, 'type') || 'text').toLowerCase(), value: attribute(tag, 'value') || '' }));
    const names = new Set(inputs.map(input => input.name));
    const action = attribute(open, 'action');
    if (action && ['otp', 'password', 'username'].some(name => names.has(name))) {
      return { action, names, hidden: Object.fromEntries(inputs.filter(input => input.type === 'hidden' && input.name).map(input => [input.name, input.value])) };
    }
  }
  return null;
}

async function token(fetchImpl, params) {
  const res = await fetchImpl(`${SSO}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ client_id: CLIENT_ID, ...params }) });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.access_token) return data;
  const error = new Error(`Immomio login failed: ${data.error_description || data.error || `HTTP ${res.status}`}`);
  if (data.error === 'invalid_grant') error.code = 'LOGIN_REQUIRED';
  throw error;
}

// Email and password (+ a one-time code from askCode(question)) on Keycloak's login form → OAuth code with PKCE → tokens.
// ponytail: scrapes Keycloak's standard login form; a custom theme or extra required step fails with a clear message.
export async function keycloakLogin({ email, password, askCode, fetchImpl = fetch }) {
  const cookies = new Map();
  const remember = res => { for (const cookie of res.headers.getSetCookie?.() ?? []) { const [pair] = cookie.split(';'); const at = pair.indexOf('='); if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1)); } };
  const request = async (url, init = {}) => {
    const res = await fetchImpl(url, { ...init, redirect: 'manual', headers: { Accept: 'text/html', ...init.headers, Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } });
    remember(res);
    return res;
  };
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  let res = await request(`${SSO}/auth?${new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', scope: 'openid offline_access', redirect_uri: REDIRECT_URI,
    state, nonce: randomBytes(16).toString('base64url'), login_hint: email, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`);
  let passwordSent = false, retry = '';
  for (let steps = 0; steps < 10; steps++) {
    const location = res.headers.get('location');
    if (location) {
      const url = new URL(location, SSO);
      if (url.href.startsWith(REDIRECT_URI)) {
        const code = url.searchParams.get('code');
        if (!code || url.searchParams.get('state') !== state) throw new Error(`Immomio login returned no code: ${url.searchParams.get('error_description') || url.searchParams.get('error') || 'unknown error'}`);
        return token(fetchImpl, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT_URI });
      }
      if (url.origin !== new URL(SSO).origin) throw new Error('Immomio login sent me to an unexpected page');
      res = await request(url.href);
      continue;
    }
    if (!res.ok) throw new Error(`Immomio login failed (HTTP ${res.status})`);
    const form = loginForm(await res.text());
    if (!form || new URL(form.action, SSO).origin !== new URL(SSO).origin) throw new Error('Immomio asks for a login step I cannot do. Log in once on tenant.immomio.com, then try again.');
    const fields = {};
    if (form.names.has('otp')) {
      fields.otp = String(await askCode(retry || 'Immomio asks for a security code. Please enter it.')).trim();
      retry = 'That code did not work. Please enter it again.';
    } else if (form.names.has('password')) {
      // The password form again means the first try was rejected.
      if (passwordSent) throw new Error('Immomio did not accept the email or password.');
      Object.assign(fields, { username: email, password });
      passwordSent = true;
    } else fields.username = email;
    res = await request(new URL(form.action, SSO).href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...form.hidden, ...fields }) });
  }
  throw new Error('Immomio login did not finish');
}

const claims = jwt => { try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')); } catch { return {}; } };
// The connected Immomio account, stored and renewed like the IS24 one.
export class ImmomioSession extends IS24Session {
  async login({ email, password, askCode }) {
    const tokens = await keycloakLogin({ email, password, askCode, fetchImpl: this.fetch });
    const account = String(claims(tokens.id_token || '').email || claims(tokens.access_token).email || '').toLowerCase();
    if (!account) throw new Error('Immomio did not tell which account this is');
    this.save(tokens, account);
    return account;
  }
  renew(refreshToken) { return token(this.fetch, { grant_type: 'refresh_token', refresh_token: refreshToken }); }
}

export function immomioClient(accessToken, fetchImpl = fetch) {
  return async (query, variables = {}) => {
    const res = await fetchImpl(GRAPHQL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ query, variables }) });
    const body = await res.json().catch(() => null);
    if (res.status === 401) throw loginRequired('Immomio ended my login; send /immomio to connect it again');
    if (!res.ok || !body?.data || body.errors?.length) throw new Error(`Immomio request failed (HTTP ${res.status}${body?.errors?.[0]?.message ? `: ${String(body.errors[0].message).slice(0, 200)}` : ''})`);
    return body.data;
  };
}

// One application with the account's profile, after every check that can fail without sending anything.
export async function applyOnImmomio(gql, propertyId, { accountEmail, beforeSubmit, onSubmitAttempt }) {
  const manual = `apply yourself: ${immomioUrl(propertyId)}`;
  const { user } = await gql('query { user { id email } }');
  if (!user?.id || String(user.email || '').toLowerCase() !== accountEmail) throw new Error('The connected Immomio account differs from the approved one');
  const { property } = await gql('query($id: ID!) { property(id: $id) { id rented captchaSettings { applicationSubmissionActive } smsVerificationRequired } }', { id: propertyId });
  if (property?.id !== propertyId) throw new Error('Immomio property identity cannot be verified');
  if (property.rented) throw new Error('This Immomio listing is no longer available');
  // ponytail: captcha/SMS listings are handed to the owner; automating them needs a browser.
  if (property.captchaSettings?.applicationSubmissionActive) throw new Error(`Immomio asks for a captcha on this listing; ${manual}`);
  if (property.smsVerificationRequired) throw new Error(`Immomio asks for SMS verification on this listing; ${manual}`);
  const { checkApplicationExist } = await gql('query($propertyId: ID!) { checkApplicationExist(propertyId: $propertyId) { id } }', { propertyId });
  if (checkApplicationExist?.id) throw new Error('You already applied to this listing on Immomio; nothing was sent');
  if (await beforeSubmit() === false) throw new Error('Approval no longer valid');
  onSubmitAttempt();
  const { createApplication } = await gql('mutation($userId: ID!, $propertyId: ID!) { createApplication(userId: $userId, propertyId: $propertyId) { id status } }', { userId: user.id, propertyId });
  if (!createApplication?.id) throw new Error('Immomio did not confirm the application');
  let detail = 'Immomio accepted your application.';
  try {
    const { customQuestionsByProperty: questions } = await gql('query($id: ID!) { customQuestionsByProperty(id: $id) { customQuestions { id } questions { rootQuestion { id } } } }', { id: propertyId });
    const count = (questions?.customQuestions?.length || 0) + (questions?.questions?.length || 0);
    if (count) detail += ` The landlord asks ${count} question${count === 1 ? '' : 's'}; answer them on ${immomioUrl(propertyId)}`;
  } catch { detail += ` Check ${immomioUrl(propertyId)} for landlord questions.`; }
  return { detail };
}
