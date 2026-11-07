import { IS24Session } from './is24-auth.js';
import { claims, loginRequired, oauthToken, pkce } from './oauth.js';

// Immomio: some landlords take applications only there and link the apply page in the IS24 description.
// Everything goes through the tenant app's GraphQL API with the account's Immomio profile; the operations below are
// the ones tenant.immomio.com itself sends (read from its web app).
const IMMOMIO_APP = 'https://tenant.immomio.com';
const GRAPHQL = 'https://gql-ps.immomio.com/tenant/graphql';
// The tenant app's Keycloak login (realm and client from its public `sso` query).
const SSO = 'https://sso.immomio.com/auth/realms/immomio/protocol/openid-connect';
const CLIENT_ID = 'immomio-oidc-web';
const REDIRECT_URI = `${IMMOMIO_APP}/`;
// The app's apply routes: apply/:id, properties/apply/:id, optionally under a language. The id is the property's
// public ID; the app asks `property(id)` for it, which may answer with another (internal) ID.
const LINK = /(?:https?:\/\/)?tenant\.immomio\.com\/(?:[a-z]{2}\/)?(?:properties\/)?apply\/([A-Za-z0-9][A-Za-z0-9_-]{2,63})(?![A-Za-z0-9_-])/gi;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const immomioUrl = id => `${IMMOMIO_APP}/apply/${encodeURIComponent(id)}`;
// Only with a connected Immomio account; otherwise the listing gets the IS24 contact request.
export const usesImmomio = (snapshot, config) => Boolean(snapshot?.immomio && config.immomioEmail);

// One distinct apply link routes the listing to Immomio; none or several keep the IS24 contact request.
export function immomioPropertyId(text) {
  const ids = new Map();
  for (const [, id] of String(text || '').matchAll(LINK)) ids.set(id.toLowerCase(), UUID.test(id) ? id.toLowerCase() : id);
  return ids.size === 1 ? [...ids.values()][0] : null;
}

const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
const unescape = value => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => code[0] === '#'
  ? String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : entities[code.toLowerCase()] ?? all);
const attribute = (tag, name) => { const match = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag); return match ? unescape(match[1]) : null; };
// The Keycloak page's form that asks for the email, the password or a one-time code.
function loginForm(html) {
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

const token = (fetchImpl, params) => oauthToken(fetchImpl, `${SSO}/token`, { client_id: CLIENT_ID, ...params }, { service: 'Immomio' });

// Email and password (+ a one-time code from askCode(question)) on Keycloak's login form → OAuth code with PKCE → tokens.
// ponytail: scrapes Keycloak's standard login form; a custom theme or extra required step fails with a clear message.
async function keycloakLogin({ email, password, askCode, fetchImpl = fetch }) {
  const cookies = new Map();
  const remember = res => { for (const cookie of res.headers.getSetCookie?.() ?? []) { const [pair] = cookie.split(';'); const at = pair.indexOf('='); if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1)); } };
  const request = async (url, init = {}) => {
    const res = await fetchImpl(url, { ...init, redirect: 'manual', headers: { Accept: 'text/html', ...init.headers, Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } });
    remember(res);
    return res;
  };
  const { verifier, state, params } = pkce();
  let res = await request(`${SSO}/auth?${new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', scope: 'openid offline_access', redirect_uri: REDIRECT_URI, login_hint: email, ...params })}`);
  let passwordSent = false, retry = '';
  for (let steps = 0; steps < 10; steps++) {
    const location = res.headers.get('location');
    if (location) {
      const url = new URL(location, SSO);
      if (url.href.startsWith(REDIRECT_URI)) {
        const code = url.searchParams.get('code');
        if (!code || url.searchParams.get('state') !== state) throw new Error(`Die Immomio-Anmeldung lieferte keinen Code: ${url.searchParams.get('error_description') || url.searchParams.get('error') || 'unbekannter Fehler'}`);
        return token(fetchImpl, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT_URI });
      }
      if (url.origin !== new URL(SSO).origin) throw new Error('Die Immomio-Anmeldung führte auf eine unerwartete Seite');
      res = await request(url.href);
      continue;
    }
    if (!res.ok) throw new Error(`Immomio-Anmeldung fehlgeschlagen (HTTP ${res.status})`);
    const form = loginForm(await res.text());
    if (!form || new URL(form.action, SSO).origin !== new URL(SSO).origin) throw new Error('Immomio verlangt einen Anmeldeschritt, den ich nicht kann. Melde dich einmal auf tenant.immomio.com an und versuch es dann erneut.');
    const fields = {};
    if (form.names.has('otp')) {
      fields.otp = String(await askCode(retry || 'Immomio verlangt einen Sicherheitscode. Bitte gib ihn ein.')).trim();
      retry = 'Der Code hat nicht funktioniert. Bitte gib ihn noch einmal ein.';
    } else if (form.names.has('password')) {
      // The password form again means the first try was rejected.
      if (passwordSent) throw new Error('Immomio hat E-Mail oder Passwort nicht akzeptiert.');
      Object.assign(fields, { username: email, password });
      passwordSent = true;
    } else fields.username = email;
    res = await request(new URL(form.action, SSO).href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...form.hidden, ...fields }) });
  }
  throw new Error('Die Immomio-Anmeldung wurde nicht abgeschlossen');
}

// The connected Immomio account, stored and renewed like the IS24 one.
export class ImmomioSession extends IS24Session {
  async login({ email, password, askCode }) {
    const tokens = await keycloakLogin({ email, password, askCode, fetchImpl: this.fetch });
    const account = String(claims(tokens.id_token || '').email || claims(tokens.access_token).email || '').toLowerCase();
    if (!account) throw new Error('Immomio hat nicht verraten, welches Konto das ist');
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
    if (res.status === 401) throw loginRequired('Immomio hat meine Anmeldung beendet; verbinde es mit /immomio neu');
    if (!res.ok || !body?.data || body.errors?.length) throw new Error(`Immomio-Anfrage fehlgeschlagen (HTTP ${res.status}${body?.errors?.[0]?.message ? `: ${String(body.errors[0].message).slice(0, 200)}` : ''})`);
    return body.data;
  };
}

// One application with the account's profile, after every check that can fail without sending anything, then the
// approved message as the first one to the landlord. The application counts as sent even if the message fails.
export async function applyOnImmomio(gql, linkId, { accountEmail, message = '', beforeSubmit, onSubmitAttempt }) {
  const manual = `bewirb dich selbst: ${immomioUrl(linkId)}`;
  const { user } = await gql('query { user { id email } }');
  if (!user?.id || String(user.email || '').toLowerCase() !== accountEmail) throw new Error('Das verbundene Immomio-Konto ist nicht das freigegebene');
  const { property } = await gql('query($id: ID!) { property(id: $id) { id rented captchaSettings { applicationSubmissionActive } smsVerificationRequired } }', { id: linkId });
  // The link may carry a public ID; the app then continues with the ID Immomio answers with, and so does this.
  const propertyId = property?.id ? String(property.id) : '';
  if (!propertyId) throw new Error(`Immomio kennt dieses Inserat nicht; ${manual}`);
  if (property.rented) throw new Error('Dieses Immomio-Inserat ist nicht mehr verfügbar');
  // ponytail: captcha/SMS listings are handed to the owner; automating them needs a browser.
  if (property.captchaSettings?.applicationSubmissionActive) throw new Error(`Immomio verlangt bei diesem Inserat ein Captcha; ${manual}`);
  if (property.smsVerificationRequired) throw new Error(`Immomio verlangt bei diesem Inserat eine SMS-Bestätigung; ${manual}`);
  const { checkApplicationExist } = await gql('query($propertyId: ID!) { checkApplicationExist(propertyId: $propertyId) { id } }', { propertyId });
  if (checkApplicationExist?.id) throw new Error('Du hast dich auf Immomio schon auf dieses Inserat beworben; nichts wurde gesendet');
  if (await beforeSubmit() === false) throw new Error('Freigabe nicht mehr gültig');
  onSubmitAttempt();
  const { createApplication } = await gql('mutation($userId: ID!, $propertyId: ID!) { createApplication(userId: $userId, propertyId: $propertyId) { id status } }', { userId: user.id, propertyId });
  if (!createApplication?.id) throw new Error('Immomio hat die Bewerbung nicht bestätigt');
  let detail = 'Immomio hat deine Bewerbung angenommen.';
  if (message.trim()) {
    try {
      const { sendMessageInNewConversation: sent } = await gql(`mutation($input: SendMessageInput!) { sendMessageInNewConversation(input: $input) { ${MESSAGE} } }`, { input: { applicationId: createApplication.id, message } });
      detail += sent?.id ? ' Deine Nachricht ging im Immomio-Messenger an den Vermieter.' : ' Immomio hat deine Nachricht nicht bestätigt; prüfe deine Immomio-Nachrichten.';
    } catch (error) { detail += ` Deine Nachricht wurde nicht gesendet (${error.message}); der Vermieter sieht nur dein Profil.`; }
  }
  try {
    const { customQuestionsByProperty: questions } = await gql('query($id: ID!) { customQuestionsByProperty(id: $id) { customQuestions { id } questions { rootQuestion { id } } } }', { id: propertyId });
    const count = (questions?.customQuestions?.length || 0) + (questions?.questions?.length || 0);
    if (count) detail += ` Der Vermieter stellt ${count === 1 ? 'eine Frage' : `${count} Fragen`}; beantworte sie auf ${immomioUrl(propertyId)}`;
  } catch { detail += ` Schau auf ${immomioUrl(propertyId)} nach Fragen des Vermieters.`; }
  return { detail };
}

// The messenger, as the tenant app's: conversations newest first with their unread count, and their messages.
const MESSAGE = 'id conversationId messageSent message sender { firstname name type } attachments { title url }';
const CONVERSATIONS = 'query($input: ConversationInput) { searchConversation(input: $input) { nodes { id subject lastMessageDate unreadMessages mainConversationPartner { firstname name } } } }';
const MESSAGES = `query($input: ConversationMessageInput) { searchConversationMessagesByConversationId(input: $input) { nodes { ${MESSAGE} } } }`;
const SEND = `mutation($input: SendMessageInput!) { sendMessage(input: $input) { ${MESSAGE} } }`;
// Immomio sends dates as ISO text or epoch milliseconds.
const time = value => typeof value === 'number' ? value : Date.parse(value) || Number(value) || 0;
const fullName = person => [person?.firstname, person?.name].filter(Boolean).join(' ').trim();
const MINE = 'PROPERTY_SEARCHER'; // The sender type of the account's own messages.
const KEEP_SEEN = 500, KEEP_THREADS = 200;
// How long the account has been quiet -> how many base intervals until the next check. Immomio has no push for the
// tenant website (it polls itself), so a quiet account is read rarely and an active one often.
const BACKOFF = [[3_600_000, 1], [86_400_000, 5], [7 * 86_400_000, 15]];
const QUIET = 30;

// The account's Immomio conversations brought to Telegram: each new message from a landlord arrives in the chat, and
// a reply to it goes back to that conversation. state(): { since, seen, threads, active } in the person's store, where
// since is the newest message time already handled, seen the IDs of the messages handled at that time or after,
// threads maps a Telegram message to the conversation it shows, and active is the last activity: the newest message
// either way, also from the Immomio app, or an application or reply sent from here.
export class ImmomioInbox {
  // client(): a GraphQL client for the connected account. forward(message) -> Telegram message IDs shown for it.
  constructor({ client, connected, load, save, forward }) {
    Object.assign(this, { client, connected, load, save, forward });
  }
  state() { return { since: null, seen: [], threads: {}, active: 0, ...this.load() }; }
  // Something happened that a landlord may answer soon (an application, a reply): check often again.
  touch(at = Date.now()) { const state = this.state(); this.save({ ...state, active: Math.max(state.active, at) }); }
  // Until the next check, in multiples of base: often while the account is active, rarely once it is quiet.
  wait(base, now = Date.now()) {
    const { active } = this.state();
    const quiet = this.connected() && active ? now - active : Infinity;
    return base * (BACKOFF.find(([within]) => quiet < within)?.[1] ?? QUIET);
  }
  // The conversation a Telegram message (a forwarded message or a reply prompt) belongs to, or null.
  thread(messageId) { return this.state().threads[messageId] ?? null; }
  remember(messageIds, conversationId, subject) {
    const state = this.state();
    const threads = Object.entries({ ...state.threads, ...Object.fromEntries(messageIds.map(id => [id, { conversationId, subject }])) }).slice(-KEEP_THREADS);
    this.save({ ...state, threads: Object.fromEntries(threads) });
  }
  // New landlord messages since the last check go to Telegram, oldest first. The first check after connecting shows
  // only the messages Immomio still marks unread, so a long history does not flood the chat.
  async check() {
    if (!this.connected()) return 0;
    const gql = await this.client();
    const state = this.state();
    const { searchConversation } = await gql(CONVERSATIONS, { input: { page: 0, size: 20 } });
    const conversations = searchConversation?.nodes ?? [];
    const first = state.since === null;
    const seen = new Set(state.seen);
    const fresh = [];
    for (const conversation of conversations) {
      const unread = Number(conversation.unreadMessages) || 0;
      if (first ? !unread : !unread && time(conversation.lastMessageDate) < state.since) continue;
      const { searchConversationMessagesByConversationId: page } = await gql(MESSAGES, { input: { conversationId: conversation.id, page: 0, size: 20 } });
      const theirs = (page?.nodes ?? []).filter(message => message?.id && message.sender?.type !== MINE && !seen.has(message.id))
        .sort((a, b) => time(a.messageSent) - time(b.messageSent));
      fresh.push(...(first ? theirs.slice(-unread) : theirs.filter(message => time(message.messageSent) >= state.since)).map(message => ({ conversation, message })));
    }
    fresh.sort((a, b) => time(a.message.messageSent) - time(b.message.messageSent));
    // Only past what was shown: if one fails, it and the rest of the batch come again next time.
    let since = state.since ?? 0;
    for (const { conversation, message } of fresh) {
      const subject = String(conversation.subject || 'Immomio');
      const shown = await this.forward({ subject, from: fullName(message.sender) || fullName(conversation.mainConversationPartner) || 'Landlord', text: String(message.message || ''),
        attachments: (message.attachments || []).map(attachment => attachment?.title).filter(Boolean), conversationId: conversation.id });
      seen.add(message.id);
      since = Math.max(since, time(message.messageSent));
      // Saved after each one, so a failure later in the batch does not show this one again.
      this.save({ ...this.state(), since, seen: [...seen].slice(-KEEP_SEEN) });
      this.remember(shown, conversation.id, subject);
    }
    // Everything is shown: what is older than the newest conversation stays history. Messages at the newest time stay
    // in seen, so one arriving in the same millisecond is still shown.
    since = Math.max(since, ...conversations.map(conversation => time(conversation.lastMessageDate)));
    const latest = this.state();
    this.save({ ...latest, since, seen: [...seen].slice(-KEEP_SEEN), active: Math.max(latest.active, since) });
    return fresh.length;
  }
  async reply(conversationId, message) {
    const gql = await this.client();
    const { sendMessage } = await gql(SEND, { input: { conversationId, message } });
    if (!sendMessage?.id) throw new Error('Immomio hat die Nachricht nicht bestätigt');
    // The own message is not shown back, and it does not move the conversation past a landlord's reply.
    const state = this.state();
    this.save({ ...state, seen: [...state.seen, sendMessage.id].slice(-KEEP_SEEN), active: Date.now() });
  }
}
