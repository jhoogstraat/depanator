import { createHash, randomBytes } from 'node:crypto';
import { coded } from './errors.js';

// What the IS24 and Immomio logins share: both are OAuth with PKCE, renewed with a refresh token.

export const loginRequired = (message = 'IS24 login required') => coded(message, 'LOGIN_REQUIRED');

// A JWT's claims, unverified (the token came straight from the issuer); {} if unreadable.
export const claims = jwt => { try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')); } catch { return {}; } };

// A fresh PKCE verifier with the authorize parameters that go with it: state, nonce and the code challenge.
export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  return { verifier, state, params: { state, nonce: randomBytes(16).toString('base64url'), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' } };
}

// One token request (authorization code or refresh). invalid_grant: the renewal key expired or was revoked.
export async function oauthToken(fetchImpl, url, params, { service, headers = {} }) {
  const res = await fetchImpl(url, { method: 'POST', headers: { Accept: 'application/json', ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.access_token) return data;
  const message = `${service} login failed: ${data.error_description || data.error || `HTTP ${res.status}`}`;
  throw data.error === 'invalid_grant' ? loginRequired(message) : new Error(message);
}
