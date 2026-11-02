import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSearchUrl, buildMobileApiUrl } from './url-translator.js';
import { Feeds, outsideSearch } from './feed.js';
import { loginRequired } from './is24-auth.js';
import { applyOnImmomio, immomioClient, immomioPropertyId, immomioUrl, usesImmomio } from './immomio.js';

// Everything goes through the IS24 app's API (api.mobile.immobilienscout24.de): no website, no browser.
const ORIGIN = 'https://www.immobilienscout24.de';
const API = 'https://api.mobile.immobilienscout24.de';
const USER_AGENT = 'ImmoScout_27.12_26.2_._';
// The app version a working third-party client sends contact requests with.
const CONTACT_USER_AGENT = 'ImmoScout24_1458_34_._';
const LISTING_FACTS = ['title', 'price', 'area', 'rooms', 'address', 'description'];
// BLOCKED: rate limit or access denied, back off globally. LISTING_GONE: only this listing is affected.
function coded(error, code) {
  error.code = code;
  return error;
}
function listingUrl(id) {
  if (!/^\d{1,20}$/.test(String(id))) throw new Error('Invalid expose ID');
  return `${ORIGIN}/expose/${id}`;
}

// Throws a user-facing reason when the search URL cannot be polled exactly.
export function searchFilters(searchUrl) {
  const validation = validateSearchUrl(searchUrl);
  if (!validation.ok) throw new Error(validation.error);
  if (!['calculatedtotalrent','rentpermonth'].includes(validation.canonical.price.type)) throw new Error('Unsupported rent price type');
  return validation.canonical;
}

// "1.234,56 €", "33,13 m²", "2,5" → number.
function parseNumber(text) {
  const match = String(text ?? '').match(/-?\d[\d.,\s ]*/);
  if (!match) return null;
  let numeric = match[0].replace(/[\s ]/g, '');
  if (numeric.includes(',') && numeric.includes('.')) {
    numeric = numeric.lastIndexOf(',') > numeric.lastIndexOf('.') ? numeric.replace(/\./g, '').replace(',', '.') : numeric.replace(/,/g, '');
  } else if (numeric.includes(',')) numeric = numeric.replace(',', '.');
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(numeric)) numeric = numeric.replace(/\./g, '');
  const value = Number(numeric);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// The listing facts the review sees, from the app's expose JSON (a list of typed sections).
// A fact IS24 leaves out stays empty: the listing is still worth showing.
function readExpose(expose, priceType) {
  const sections = Array.isArray(expose?.sections) ? expose.sections : [];
  const of = type => sections.filter(section => section?.type === type);
  const top = of('TOP_ATTRIBUTES').flatMap(section => section.attributes || []);
  const listed = of('ATTRIBUTE_LIST').flatMap(section => section.attributes || []);
  const label = attribute => String(attribute?.label || '').replace(/:\s*$/, '');
  const find = (attributes, test) => attributes.find(attribute => test(label(attribute)))?.text;
  // Never substitute cold rent for a warm/total-rent search, or vice versa.
  const price = priceType === 'calculatedtotalrent'
    ? find(top, name => name === 'Warmmiete') ?? find(listed, name => name === 'Gesamtmiete')
    : find(top, name => name.startsWith('Kaltmiete')) ?? find(listed, name => name.startsWith('Kaltmiete'));
  const map = of('MAP')[0] || {};
  return {
    title: String(of('TITLE')[0]?.title || '').trim(),
    price: parseNumber(price),
    area: parseNumber(find(top, name => name === 'Wohnfläche') ?? find(listed, name => name.startsWith('Wohnfläche'))),
    rooms: parseNumber(find(top, name => name === 'Zimmer') ?? find(listed, name => name.startsWith('Zimmer'))),
    // Without a street IS24 adds "Die vollständige Adresse … erhältst du vom Anbieter." as a line; keep only the district.
    address: [map.addressLine1, map.addressLine2].filter(line => line && !/vollständige Adresse/i.test(line)).join(', '),
    description: of('TEXT_AREA').filter(section => section.text).map(section => `${section.title || ''}\n${section.text}`.trim()).join('\n\n'),
    amenities: [...new Set(listed.filter(attribute => attribute?.label).map(attribute => attribute.type === 'CHECK' ? `${label(attribute)}: ja` : attribute.text ? `${label(attribute)}: ${attribute.text}` : '').filter(Boolean))].sort(),
  };
}

// Contact fields by the name IS24's per-listing form configuration uses: [what it asks for, persona value].
// Fields without a value function have no documented format, so the agent never fills them.
const FIELDS = {
  firstnameField: ['your first name', persona => persona.vorname], lastnameField: ['your last name', persona => persona.nachname],
  emailAddressField: ['your email', persona => persona.email], phoneNumberField: ['a phone number', persona => persona.telefon],
  salutationField: ['a salutation', persona => persona.anrede], messageField: ['a message', (persona, message) => message],
  addressField: ['your full address', persona => persona.strasse && persona.hausnummer && persona.plz && persona.ort],
  moveInDateField: ['a move-in date'], petsInHouseholdField: ['pets'], numberOfPersonsField: ['the number of people'],
  employmentRelationshipField: ['employment'], incomeField: ['income'], applicationPackageCompletedField: ['application documents'],
};

// The request body, or a reason why this listing cannot be contacted with the approved data.
function contactRequest(expose, persona, message, ssoId) {
  const contact = expose?.contact || {};
  if (String(contact.premiumProfileRequiredForContacting) === 'true') return { reason: 'This landlord only accepts requests from IS24 Premium members' };
  for (const [field, state] of Object.entries(contact.contactData?.formFieldConfig || {})) {
    if (state !== 'MANDATORY') continue;
    const [asks = field.replace(/Field$/, ''), value] = FIELDS[field] || [];
    if (!value) return { reason: `This listing requires ${asks}, which I cannot fill in. Apply on IS24 yourself.` };
    if (!value(persona, message)) return { reason: `This listing requires ${asks}. Add it in /settings → 👤 About you.` };
  }
  const address = { street: persona.strasse, houseNumber: persona.hausnummer, postcode: persona.plz, city: persona.ort };
  const form = {
    salutation: persona.anrede || 'NO_SALUTATION', firstname: persona.vorname, lastname: persona.nachname, emailAddress: persona.email,
    ...(persona.telefon && { phoneNumber: persona.telefon }), ...(Object.values(address).some(Boolean) && { address }),
    message, privacyPolicyAccepted: true, profileType: 'BASIC', sendProfile: persona.sendProfile === true,
  };
  return { body: { 'expose.contactForm': form, supportedScreens: ['registration', 'valuation'], requestCount: 1, doNotSend: false, entitlements: [], ...(ssoId && { ssoId }) } };
}

const card = item => item?.item || item || {};
const cardId = expose => String(expose.id || expose.exposeId || '');

export class IS24Adapter {
  // config is the live settings object: a changed search URL or persona applies to the next task.
  // feeds: the search shared with everyone else on this agent.
  constructor(config, { session, immomio = null, fetch = globalThis.fetch, feeds = new Feeds(this) } = {}) {
    Object.assign(this, { config, session, immomio, fetch, feeds });
  }
  get filters() {
    if (this.filtersFor !== this.config.searchUrl) { this.cachedFilters = searchFilters(this.config.searchUrl); this.filtersFor = this.config.searchUrl; }
    return this.cachedFilters;
  }
  // Responses that went wrong, stored once each in <data>/raw; see docs/raw-responses.md.
  // Never throws: failing to store one must not change what happens to the request.
  // ponytail: no retention limit; identical content is skipped and writes are rare. Prune if the directory grows.
  keep(label, problem, body) {
    if (!this.config.dataDir) return;
    try {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      const directory = join(this.config.dataDir, 'raw');
      const file = join(directory, `${label}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.json`);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), problem, body }, null, 2), { flag: 'wx', mode: 0o600 });
      console.warn(`Kept IS24 response ${file}: ${problem}`);
    } catch (error) { if (error.code !== 'EEXIST') console.error(`Could not keep IS24 response: ${error.message}`); }
  }
  async api(path, { signal, ...request } = {}) {
    const timeout = AbortSignal.timeout(30000);
    const response = await this.fetch(`${API}${path}`, { redirect: 'error', ...request,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...request.headers }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if ([404, 410].includes(response.status)) throw coded(new Error('Listing is no longer available'), 'LISTING_GONE');
    const text = await response.text().catch(() => '');
    const refuse = (problem, code) => {
      this.keep(path.split('?')[0].slice(1).replaceAll('/', '-'), problem, text);
      throw coded(new Error(problem), code);
    };
    if ([401, 403, 429].includes(response.status)) refuse(`IS24 blocked access (HTTP ${response.status})`, 'BLOCKED');
    if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) refuse(`IS24 unavailable (HTTP ${response.status})`);
    try { return JSON.parse(text); } catch { refuse('IS24 sent invalid JSON'); }
  }
  async searchPage(page, signal, filters) {
    signal?.throwIfAborted();
    const data = await this.api(buildMobileApiUrl(filters, { page }).slice(API.length), { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supportedResultListTypes: [], userData: {} }) });
    if (!Array.isArray(data?.resultListItems) || !Number.isSafeInteger(data.numberOfPages) || data.numberOfPages < 0) {
      this.keep('search-list', 'Unexpected search response', data);
      throw new Error('Unexpected search response');
    }
    return data;
  }
  // Results are newest first, so paging stops once a page ends with an already known listing: everything
  // older is known too. A routine poll is one request, which keeps short intervals cheap. A known item
  // elsewhere on the page (e.g. promoted to the top) does not stop paging. known(exposeId) -> boolean.
  async scan(filters, { signal, known = () => false, maxPages } = {}) {
    const results = [];
    let complete = false;
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.searchPage(page, signal, filters);
      results.push(data);
      const ids = data.resultListItems.map(item => cardId(card(item)));
      if (page >= data.numberOfPages || (ids.length && known(ids.at(-1)))) { complete = true; break; }
    }
    const pages = results.length;
    const listings = new Map();
    for (const data of results) for (const item of data.resultListItems) {
      const expose = card(item);
      const id = cardId(expose);
      // One unusable result must not cost the other listings on the page.
      if (!/^\d{1,20}$/.test(id)) { this.keep('search-item', 'Search result without a listing ID', item); continue; }
      const url = listingUrl(id);
      const address = typeof expose.address === 'string' ? expose.address : expose.address?.line || '';
      // Attributes are unlabeled display strings such as "1.234 €", "54 m²", "2,5 Zi.".
      const attribute = unit => parseNumber((Array.isArray(expose.attributes) ? expose.attributes : []).find(a => String(a?.value).includes(unit))?.value);
      const facts = { price: attribute('€'), area: attribute('m²'), rooms: attribute('Zi') };
      const gaps = Object.entries({ title: expose.title, address, ...facts }).filter(([, value]) => !value).map(([key]) => key);
      if (gaps.length && !known(id)) this.keep(`search-item-${id}`, `Search result without ${gaps.join(', ')}`, item);
      if (!listings.has(id)) listings.set(id,{expose_id:id,title:expose.title || `Listing ${id}`,...facts,address,image_url:expose.titlePicture?.full || expose.titlePicture?.preview || '',url,published:String(expose.published || ''),earlyAccess:expose.paywallListing?.active === true});
    }
    return { listings: [...listings.values()], complete, pages };
  }
  // The shared feed, narrowed to this person's search.
  // The first successful result after startup, resume or a search change only establishes a baseline.
  // After that, every previously unseen listing is new, including arrivals after an empty baseline.
  async search({ signal } = {}) {
    signal?.throwIfAborted();
    const searchKey = JSON.stringify([this.config.searchUrl, this.config.searchGeneration ?? 0]);
    const baseline = this.lastSearchKey !== searchKey;
    const filters = this.filters;
    // Waits for the shared search without tying it to this person's shutdown.
    let stop = () => {};
    const aborted = new Promise((_, reject) => {
      if (!signal) return;
      stop = () => signal.removeEventListener('abort', cancel);
      const cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    });
    const { listings, complete, pages } = await Promise.race([this.feeds.search(filters), aborted]).finally(() => stop());
    this.lastSearchKey = searchKey; // Failed/invalid searches never consume the warm-up.
    return {listings:listings.filter(listing => !outsideSearch(filters, listing, { priced: false })),complete,caughtUp: !baseline,pages,...(complete ? {} : {warning:'Page limit reached; search coverage is partial'})};
  }
  // Why a listing with its details is outside this person's search, or ''.
  outside(listing) { return outsideSearch(this.filters, listing); }
  expose(id) { return this.api(`/expose/${new URL(listingUrl(id)).pathname.split('/').pop()}`); }
  // shared: may reuse what another person's screening just read. Never for a send's last check.
  async details(listing, { shared = false } = {}) {
    const expose = await (shared ? this.feeds.expose(listing.expose_id) : this.expose(listing.expose_id));
    const detail = readExpose(expose, this.filters.price.type);
    const { expose_id, image_url = '', published, earlyAccess } = listing;
    const gaps = LISTING_FACTS.filter(key => !detail[key]);
    if (gaps.length) this.keep(`expose-${expose_id}`, `Listing without ${gaps.join(', ')}`, expose);
    // The search result fills gaps, except the rent: it may show the other rent type than the search asked for.
    for (const key of ['title', 'area', 'rooms', 'address']) detail[key] ||= listing[key];
    const missing = LISTING_FACTS.filter(key => !detail[key]);
    const immomio = immomioPropertyId(detail.description);
    return { expose_id: String(expose_id), title: detail.title, price: detail.price, area: detail.area, rooms: detail.rooms, address: detail.address,
      image_url, url: listingUrl(expose_id), published, earlyAccess, description: detail.description, amenities: detail.amenities,
      ...(missing.length && { missing }), ...(immomio && { immomio: { propertyId: immomio, url: immomioUrl(immomio) } }) };
  }
  // Resolves once IS24 access works; onRequired() asks the owner to connect the account and resolves after.
  async authenticate(onRequired) {
    for (;;) {
      try { await this.session.accessToken(); return; }
      catch (error) { if (error.code !== 'LOGIN_REQUIRED') throw error; await onRequired(); }
    }
  }
  // One contact request with the approved draft. Never retried: a lost answer is an unknown outcome.
  async send(review, { beforeSubmit, assertCanSubmit } = {}) {
    let attempted = false;
    try {
      if (typeof beforeSubmit !== 'function') throw new Error('Persistent approval check required');
      if (usesImmomio(review.snapshot, this.config)) {
        if (this.immomio?.email !== this.config.immomioEmail) throw new Error('The connected Immomio account differs from the approved one');
        const token = await this.immomio.accessToken().catch(() => { throw new Error(`Immomio ended my login; send /immomio to connect again, or apply yourself: ${review.snapshot.immomio.url}`); });
        const { detail } = await applyOnImmomio(immomioClient(token, this.fetch), review.snapshot.immomio.propertyId, { accountEmail: this.config.immomioEmail, beforeSubmit,
          onSubmitAttempt: () => { assertCanSubmit?.(); attempted = true; } });
        return { outcome: 'sent', detail };
      }
      if (this.session.email !== this.config.accountEmail) throw loginRequired('The connected IS24 account differs from the approved one');
      const id = review.snapshot.expose_id;
      const { body, reason } = contactRequest(await this.expose(id), this.config.persona, review.draft, this.session.ssoId);
      if (reason) return { outcome: 'failed', detail: reason };
      const token = await this.session.accessToken();
      if (await beforeSubmit() === false) throw new Error('Approval no longer valid');
      assertCanSubmit?.();
      attempted = true;
      const response = await this.fetch(`${API}/expose/${id}/contact?referrer=resultlist`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'User-Agent': CONTACT_USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      if (response.ok) return { outcome: 'sent', detail: 'IS24 accepted the request' };
      const raw = await response.text().catch(() => '');
      this.keep(`contact-${id}`, `Contact request answered HTTP ${response.status}`, raw);
      const answer = raw.replace(/\s+/g, ' ').slice(0, 200);
      // IS24 answers delivered contact requests with HTTP 500 (confirmed live in the account's messages).
      if (response.status === 500) return { outcome: 'sent', detail: 'IS24 delivered the request' };
      // Other server errors may come after IS24 already forwarded the request.
      if (response.status > 500) return { outcome: 'unknown_outcome', detail: `IS24 answered HTTP ${response.status}${answer && `: ${answer}`}; check your IS24 messages whether it arrived` };
      return { outcome: 'failed', detail: `IS24 rejected the request (HTTP ${response.status}${answer && `: ${answer}`})` };
    } catch (error) { return { outcome: attempted ? 'unknown_outcome' : 'failed', detail: error.message }; }
  }
}
