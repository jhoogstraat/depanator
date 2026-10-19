import { validateSearchUrl, buildMobileApiUrl } from './url-translator.js';
import { loginRequired } from './is24-auth.js';

// Everything goes through the IS24 app's API (api.mobile.immobilienscout24.de): no website, no browser.
const ORIGIN = 'https://www.immobilienscout24.de';
const API = 'https://api.mobile.immobilienscout24.de';
const USER_AGENT = 'ImmoScout_27.12_26.2_._';
// The app version a working third-party client sends contact requests with.
const CONTACT_USER_AGENT = 'ImmoScout24_1458_34_._';
// BLOCKED: rate limit or access denied, back off globally. LISTING_GONE: only this listing is affected.
function coded(error, code) {
  error.code = code;
  return error;
}
export function listingUrl(id) {
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
export function parseNumber(text) {
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
export function readExpose(expose, priceType) {
  const sections = expose?.sections || [];
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
  const details = {
    title: String(of('TITLE')[0]?.title || '').trim(),
    price: parseNumber(price),
    area: parseNumber(find(top, name => name === 'Wohnfläche') ?? find(listed, name => name.startsWith('Wohnfläche'))),
    rooms: parseNumber(find(top, name => name === 'Zimmer') ?? find(listed, name => name.startsWith('Zimmer'))),
    address: [map.addressLine1, map.addressLine2].filter(Boolean).join(', '),
    description: of('TEXT_AREA').filter(section => section.text).map(section => `${section.title || ''}\n${section.text}`.trim()).join('\n\n'),
    amenities: [...new Set(listed.filter(attribute => attribute.label).map(attribute => attribute.type === 'CHECK' ? `${label(attribute)}: ja` : attribute.text ? `${label(attribute)}: ${attribute.text}` : '').filter(Boolean))].sort(),
  };
  for (const key of ['title', 'price', 'area', 'rooms', 'address', 'description']) if (!details[key]) throw new Error(`Listing has no ${key}; the IS24 parser needs updating`);
  return details;
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
export function contactRequest(expose, persona, message, ssoId) {
  const contact = expose?.contact || {};
  if (String(contact.premiumProfileRequiredForContacting) === 'true') return { reason: 'This landlord only accepts requests from IS24 Premium members' };
  for (const [field, state] of Object.entries(contact.contactData?.formFieldConfig || {})) {
    if (state !== 'MANDATORY') continue;
    const [asks = field.replace(/Field$/, ''), value] = FIELDS[field] || [];
    if (!value) return { reason: `This listing requires ${asks}, which I cannot fill in. Apply on IS24 yourself.` };
    if (!value(persona, message)) return { reason: `This listing requires ${asks}. Add it in /prompt → 👤 About you.` };
  }
  const address = { street: persona.strasse, houseNumber: persona.hausnummer, postcode: persona.plz, city: persona.ort };
  const form = {
    salutation: persona.anrede || 'NO_SALUTATION', firstname: persona.vorname, lastname: persona.nachname, emailAddress: persona.email,
    ...(persona.telefon && { phoneNumber: persona.telefon }), ...(Object.values(address).some(Boolean) && { address }),
    message, privacyPolicyAccepted: true, profileType: 'BASIC', sendProfile: persona.sendProfile === true,
  };
  return { body: { 'expose.contactForm': form, supportedScreens: ['registration', 'valuation'], requestCount: 1, doNotSend: false, entitlements: [], ...(ssoId && { ssoId }) } };
}

export class IS24Adapter {
  // config is the live settings object: a changed search URL or persona applies to the next task.
  constructor(config, { session, fetch = globalThis.fetch } = {}) {
    Object.assign(this, { config, session, fetch });
  }
  get filters() {
    if (this.filtersFor !== this.config.searchUrl) { this.cachedFilters = searchFilters(this.config.searchUrl); this.filtersFor = this.config.searchUrl; }
    return this.cachedFilters;
  }
  async api(path, { signal, ...request } = {}) {
    const timeout = AbortSignal.timeout(30000);
    const response = await this.fetch(`${API}${path}`, { redirect: 'error', ...request,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...request.headers }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if ([401, 403, 429].includes(response.status)) throw coded(new Error(`IS24 blocked access (HTTP ${response.status})`), 'BLOCKED');
    if ([404, 410].includes(response.status)) throw coded(new Error('Listing is no longer available'), 'LISTING_GONE');
    if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) throw new Error(`IS24 unavailable (HTTP ${response.status})`);
    return response.json();
  }
  async searchPage(page, signal) {
    signal?.throwIfAborted();
    const data = await this.api(buildMobileApiUrl(this.filters, { page }).slice(API.length), { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supportedResultListTypes: [], userData: {} }) });
    if (!Array.isArray(data.resultListItems) || !Number.isSafeInteger(data.numberOfPages) || data.numberOfPages < 0) throw new Error('Unexpected search response');
    return data;
  }
  // Results are newest first, so paging stops once a page ends with an already known listing: everything
  // older is known too. A routine poll is one request, which keeps short intervals cheap. A known item
  // elsewhere on the page (e.g. promoted to the top) does not stop paging. known(exposeId) -> boolean.
  // The first successful page after startup, resume or a search change only establishes a baseline.
  // After that, every previously unseen listing is new, including arrivals after an empty baseline.
  async search({ signal, known = () => false } = {}) {
    const searchKey = JSON.stringify([this.config.searchUrl, this.config.searchGeneration ?? 0]);
    const baseline = this.lastSearchKey !== searchKey;
    const results = [];
    let complete = false;
    for (let page = 1; page <= this.config.maxPages; page++) {
      const data = await this.searchPage(page, signal);
      results.push(data);
      const ids = data.resultListItems.map(item => String((item.item || item).id || (item.item || item).exposeId || ''));
      if (page >= data.numberOfPages || (ids.length && known(ids.at(-1)))) { complete = true; break; }
    }
    const pages = results.length;
    const listings = new Map();
    for (const data of results) for (const item of data.resultListItems) {
      const expose = item.item || item;
      const id = String(expose.id || expose.exposeId || '');
      const url = listingUrl(id);
      if (!expose.title) throw new Error('Missing listing title');
      const address = typeof expose.address === 'string' ? expose.address : expose.address?.line || '';
      // Attributes are unlabeled display strings such as "1.234 €", "54 m²", "2,5 Zi.".
      const attribute = unit => Number(String((expose.attributes || []).find(a => String(a.value).includes(unit))?.value || '').replace(/[^\d,]/g, '').replace(',', '.')) || 0;
      if (!listings.has(id)) listings.set(id,{expose_id:id,title:expose.title,price:attribute('€'),area:attribute('m²'),rooms:attribute('Zi'),address,image_url:expose.titlePicture?.full || expose.titlePicture?.preview || '',url,published:String(expose.published || ''),earlyAccess:expose.paywallListing?.active === true});
    }
    this.lastSearchKey = searchKey; // Failed/invalid searches never consume the warm-up.
    return {listings:[...listings.values()],complete,caughtUp: !baseline,pages,...(complete ? {} : {warning:'Page limit reached; search coverage is partial'})};
  }
  expose(id) { return this.api(`/expose/${new URL(listingUrl(id)).pathname.split('/').pop()}`); }
  async details(listing) {
    const detail = readExpose(await this.expose(listing.expose_id), this.filters.price.type);
    const { expose_id, image_url = '', published, earlyAccess } = listing;
    return { expose_id: String(expose_id), title: detail.title, price: detail.price, area: detail.area, rooms: detail.rooms, address: detail.address,
      image_url, url: listingUrl(expose_id), published, earlyAccess, description: detail.description, amenities: detail.amenities };
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
      const answer = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      // A server error may come after IS24 already forwarded the request.
      if (response.status >= 500) return { outcome: 'unknown_outcome', detail: `IS24 answered HTTP ${response.status}; check your IS24 messages whether it arrived` };
      return { outcome: 'failed', detail: `IS24 rejected the request (HTTP ${response.status}${answer && `: ${answer}`})` };
    } catch (error) { return { outcome: attempted ? 'unknown_outcome' : 'failed', detail: error.message }; }
  }
}
