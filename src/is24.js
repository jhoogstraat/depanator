import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';
import { IS24Contactor, FORM_SELECTS } from './is24-contactor.js';
import { validateSearchUrl, buildMobileApiUrl } from './url-translator.js';

const ORIGIN = 'https://www.immobilienscout24.de';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// BLOCKED: captcha/rate limit, back off globally. LISTING_GONE: only this listing is affected.
function coded(error, code) {
  error.code = code;
  return error;
}
export function classify(error) {
  if (error.code) return error;
  if (/blocked access/.test(error.message)) return coded(error, 'BLOCKED');
  if (/no longer available/.test(error.message)) return coded(error, 'LISTING_GONE');
  return error;
}
export function listingUrl(id) {
  if (!/^\d{1,20}$/.test(String(id))) throw new Error('Invalid expose ID');
  return `${ORIGIN}/expose/${id}`;
}

// Serializable function executed inside Chromium. Only explicit signed-in account
// markers qualify; a listing/contact-form email is never an account identity.
export function readAccount() {
  const visible = el => {
    if (!el || !el.getClientRects().length) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0');
  };
  const nodes = [...document.querySelectorAll('[data-testid="account-email"], [data-testid="user-email"], [data-qa="account-email"]')].filter(visible);
  const emails = nodes.map(el => el.textContent.trim().toLowerCase());
  const accountText = [...document.querySelectorAll('header, nav, [data-testid="user-menu"], [data-testid="account-menu"]')].filter(visible).map(el => el.innerText || '').join('\n');
  for (const match of accountText.matchAll(/(?:angemeldet als|eingeloggt als|logged in as)\s*:?\s*([^\s<>]+@[^\s<>]+)/gi)) emails.push(match[1].toLowerCase());
  const unique = [...new Set(emails)];
  return unique.length === 1 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(unique[0]) ? unique[0] : null;
}

export function extractDetails({priceType = 'calculatedtotalrent'} = {}) {
  const clean = value => String(value || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
  const visible = el => {
    if (!el || !el.getClientRects().length) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0');
  };
  const body = document.body?.innerText || '';
  if (/Ich bin kein Roboter|Sicherheitsprüfung|Sicherheitsabfrage|Zugriff verweigert/i.test(body) || document.querySelector('#captcha-container')) throw new Error('IS24 blocked access (captcha or security check); manual browser action required');
  if (/nicht mehr verfügbar|nicht mehr aktiv|exposé.*deaktiviert/i.test(body)) throw new Error('Listing is no longer available');
  const text = selector => [...document.querySelectorAll(selector)].filter(visible).map(el => clean(el.innerText)).filter(Boolean);
  const descriptions = [...document.querySelectorAll('#is24-expose-description, [data-testid="expose-description"], #is24-expose-equipment, #is24-expose-location, #is24-expose-miscellaneous')].filter(visible).map(el => clean(el.textContent)).filter(Boolean);
  const mainDescription = [...document.querySelectorAll('#is24-expose-description, [data-testid="expose-description"]')].filter(visible).some(el => clean(el.textContent));
  const amenities = [];
  for (const row of document.querySelectorAll('dl')) {
    for (const dt of row.querySelectorAll('dt')) {
      const dd = dt.nextElementSibling;
      if (visible(dt) && dd?.tagName === 'DD' && visible(dd)) amenities.push(`${clean(dt.innerText)}: ${clean(dd.innerText)}`);
    }
  }
  const title = text('h1')[0];
  const description = [...new Set(descriptions)].join('\n\n');
  const number = selectors => {
    // Priority is semantic, independent of DOM order. Never substitute cold
    // rent for a configured warm/total-rent search (or vice versa).
    let raw;
    for (const selector of selectors) { raw = text(selector)[0]; if (raw) break; }
    if (!raw) throw new Error('Missing listing numeric detail');
    const match = raw.match(/-?\d[\d.,\s\u00a0]*/);
    if (!match) throw new Error('Invalid listing numeric detail');
    let numeric = match[0].replace(/[\s\u00a0]/g, '');
    if (numeric.includes(',') && numeric.includes('.')) {
      numeric = numeric.lastIndexOf(',') > numeric.lastIndexOf('.') ? numeric.replace(/\./g, '').replace(',', '.') : numeric.replace(/,/g, '');
    } else if (numeric.includes(',')) numeric = numeric.replace(',', '.');
    else if (/^\d{1,3}(?:\.\d{3})+$/.test(numeric)) numeric = numeric.replace(/\./g, '');
    const value = Number(numeric);
    if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid listing numeric detail');
    return value;
  };
  if (!['calculatedtotalrent','rentpermonth'].includes(priceType)) throw new Error('Unsupported rent price type');
  if (!title || !mainDescription || !description || !amenities.length) throw new Error('Incomplete listing details; parser needs updating');
  return {title, description, amenities: [...new Set(amenities)].sort(),
    price: number(priceType === 'calculatedtotalrent' ? ['.is24qa-gesamtmiete', '[data-testid="expose-total-rent"]'] : ['.is24qa-kaltmiete', '[data-testid="expose-cold-rent"]']),
    area: number(['.is24qa-wohnflaeche', '[data-testid="expose-area"]']),
    rooms: number(['.is24qa-zimmer', '[data-testid="expose-rooms"]']),
    address: text('.is24-expose-address, [data-testid="expose-address"]')[0] || null};
}

export async function verifyForm(page, message, persona) {
  const result = await page.evaluate(({message, persona, selects}) => {
    const form = document.querySelector('[data-testid="contact-form"]') || document.querySelector('textarea[name="message"]')?.closest('form');
    if (!form || form.querySelector('textarea[name="message"]')?.value !== message) return false;
    const fields = {vorname:'firstName', nachname:'lastName', email:'emailAddress', telefon:'phoneNumber', strasse:'street', hausnummer:'houseNumber', plz:'postcode', ort:'city', haustiere_zusatz:'petsInHousehold'};
    for (const [key,name] of Object.entries(fields)) {
      const el = form.querySelector(`input[name="${name}"]`);
      const expected = String(persona[key] ?? '');
      if (expected ? !el || el.value !== expected : el && el.value !== '') return false;
    }
    for (const [key,name] of Object.entries(selects)) {
      const el = form.querySelector(`select[name="${name}"]`);
      const expected = String(persona[key] ?? '');
      if (expected && (!el || !(el.value === expected || el.selectedOptions[0]?.textContent.trim() === expected))) return false;
      if (!expected && el && el.value) return false;
    }
    if (persona.einzug_datum) {
      const date = persona.einzug_datum.split('-').reverse().join('.');
      if (form.querySelector('input#moveInDate')?.value !== date) return false;
    }
    // Reject site-added defaults/claims that are absent from the approved persona.
    for (const input of form.querySelectorAll('input[type="checkbox"], input[type="radio"]')) if (input.checked) return false;
    return true;
  }, {message, persona, selects:FORM_SELECTS});
  if (!result) throw new Error('Exact approved message/persona cannot be verified in contact form');
}

// Throws a user-facing reason when the search URL cannot be polled exactly.
export function searchFilters(searchUrl) {
  const validation = validateSearchUrl(searchUrl);
  if (!validation.ok) throw new Error(validation.error);
  if (!['calculatedtotalrent','rentpermonth'].includes(validation.canonical.price.type)) throw new Error('Unsupported rent price type');
  return validation.canonical;
}

export class IS24Adapter {
  // config is the live settings object: a changed search URL or persona applies to the next task.
  constructor(config, deps = {}) {
    this.config = config;
    this.deps = deps;
    this.fetch = deps.fetch || globalThis.fetch;
    this.queue = Promise.resolve();
    this.browser = null;
  }
  get filters() {
    if (this.filtersFor !== this.config.searchUrl) { this.cachedFilters = searchFilters(this.config.searchUrl); this.filtersFor = this.config.searchUrl; }
    return this.cachedFilters;
  }
  serial(fn) {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  async searchPage(page, signal) {
    signal?.throwIfAborted();
    const response = await this.fetch(buildMobileApiUrl(this.filters, {page}), {method:'POST', headers:{'User-Agent':'ImmoScout_27.12_26.2_._', Accept:'application/json', 'Content-Type':'application/json'}, body:JSON.stringify({supportedResultListTypes:[],userData:{}}), signal:signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), redirect:'error'});
    if ([401, 403, 429].includes(response.status)) throw coded(new Error(`IS24 blocked access to search (HTTP ${response.status})`), 'BLOCKED');
    if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) throw new Error(`Search unavailable (HTTP ${response.status}); resolve blocks manually`);
    const data = await response.json();
    if (!Array.isArray(data.resultListItems) || !Number.isSafeInteger(data.numberOfPages) || data.numberOfPages < 0) throw new Error('Unexpected search response');
    return data;
  }
  // Results are newest first, so paging stops at the first page holding an already known listing:
  // a routine poll is one request, which keeps short intervals cheap. known(exposeId) -> boolean.
  async search({ signal, known = () => false } = {}) {
    const results = [];
    let complete = false;
    for (let page = 1; page <= this.config.maxPages; page++) {
      const data = await this.searchPage(page, signal);
      results.push(data);
      const ids = data.resultListItems.map(item => String((item.item || item).id || (item.item || item).exposeId || ''));
      if (page >= data.numberOfPages || ids.some(id => known(id))) { complete = true; break; }
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
    return {listings:[...listings.values()],complete,pages,...(complete ? {} : {warning:'Page limit reached; search coverage is partial'})};
  }
  async ensureBrowser() {
    // Self-heal a crashed or killed Chromium instead of failing every task until restart.
    if (this.browser?.connected === false) { await this.browser.close().catch(() => {}); this.browser = null; }
    if (!this.browser) {
      this.detailPage = null;
      this.browser = await (this.deps.launch || puppeteer.launch)({headless:false,userDataDir:resolve(this.config.browserProfile),defaultViewport:null,
        executablePath:this.config.browser?.executablePath || await puppeteer.executablePath(),args:this.browserArgs()});
      this.page = await this.browser.newPage();
    }
    return this.page;
  }
  // Listing text needs no images, fonts, or media: skipping them cuts page load time and bandwidth.
  // Sending keeps the unfiltered main page so the contact form renders exactly as for a person.
  async detailsPage() {
    await this.ensureBrowser();
    if (!this.detailPage || this.detailPage.isClosed()) {
      this.detailPage = await this.browser.newPage();
      await this.detailPage.setRequestInterception(true);
      this.detailPage.on('request', request => ['image', 'media', 'font'].includes(request.resourceType()) ? request.abort() : request.continue());
    }
    return this.detailPage;
  }
  browserArgs() { return this.config.browser?.disableSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []; }
  async navigate(page,url) {
    const response = await page.goto(url,{waitUntil:'networkidle2',timeout:30000});
    if (!response?.ok()) {
      const status = response?.status();
      if ([401, 403, 429].includes(status)) throw coded(new Error(`IS24 blocked access (HTTP ${status})`), 'BLOCKED');
      if ([404, 410].includes(status)) throw coded(new Error('Listing is no longer available'), 'LISTING_GONE');
      throw new Error('Listing navigation failed');
    }
    const actual = new URL(page.url());
    if (actual.origin !== ORIGIN || actual.pathname !== new URL(url).pathname) throw new Error('Unexpected listing redirect');
  }
  async readDetails(listing,page) {
    const url = listingUrl(listing.expose_id);
    await this.navigate(page,url);
    let detail;
    try { detail = await page.evaluate(extractDetails,{priceType:this.filters.price.type}); }
    catch (error) { throw classify(error); }
    if (!detail.address) throw new Error('Missing listing address');
    return {expose_id:String(listing.expose_id),title:detail.title,price:detail.price,area:detail.area,rooms:detail.rooms,address:detail.address,image_url:listing.image_url || '',url,published:listing.published,earlyAccess:listing.earlyAccess,description:detail.description,amenities:detail.amenities};
  }
  details(listing) { return this.serial(async () => this.readDetails(listing,await this.detailsPage())); }
  async assertAccount(page) {
    const account = await page.evaluate(readAccount);
    if (!account || account !== this.config.accountEmail.toLowerCase()) throw new Error('Signed-in account email cannot be verified or differs from approved account');
  }
  async authenticate(onRequired) {
    for (;;) {
      const page = await this.serial(async () => {
        const current = await this.ensureBrowser();
        const response = await current.goto(ORIGIN + '/', { waitUntil: 'networkidle2', timeout: 30000 });
        if (!response?.ok() || new URL(current.url()).origin !== ORIGIN) throw new Error('Cannot verify IS24 session; retry when the site is reachable');
        return current;
      });
      try { await this.assertAccount(page); return; }
      catch { await onRequired(); await this.login(); }
    }
  }
  send(review,{beforeSubmit, assertCanSubmit} = {}) {
    return this.serial(async () => {
      let attempted = false;
      try {
        if (typeof beforeSubmit !== 'function') throw new Error('Persistent approval check required');
        const page = await this.ensureBrowser();
        const fresh = await this.readDetails(review.snapshot,page);
        if (digest(fresh) !== digest(review.snapshot)) throw new Error('Listing changed since approval');
        await this.assertAccount(page);
        const contactor = this.deps.contactor || new IS24Contactor({page,persona:this.config.persona,screenshotDir:join(this.config.dataDir,'screenshots')});
        const result = await contactor.apply(review.exposeId || review.snapshot.expose_id,review.draft,{
          beforeSubmit: async current => {
            const currentUrl = new URL(current.url());
            if (currentUrl.origin !== ORIGIN || currentUrl.pathname !== new URL(listingUrl(review.snapshot.expose_id)).pathname) throw new Error('Unexpected contact page destination');
            const finalDetails = await current.evaluate(extractDetails,{priceType:this.filters.price.type});
            const finalSnapshot = {...fresh,title:finalDetails.title,price:finalDetails.price,area:finalDetails.area,rooms:finalDetails.rooms,address:finalDetails.address,description:finalDetails.description,amenities:finalDetails.amenities};
            if (digest(finalSnapshot) !== digest(review.snapshot)) throw new Error('Listing changed before submission');
            await this.assertAccount(current);
            await verifyForm(current,review.draft,this.config.persona);
            if (await beforeSubmit() === false) throw new Error('Approval no longer valid');
          },
          onSubmitAttempt: () => {
            if (this.loginCancelled) throw new Error('Shutdown cancelled submission');
            assertCanSubmit?.();
            attempted = true;
          },
        });
        return {outcome:result.success ? 'sent' : attempted ? 'unknown_outcome' : 'failed',detail:result.detail || result.reason};
      } catch (err) { return {outcome:attempted ? 'unknown_outcome' : 'failed',detail:err.message}; }
    });
  }
  // The dropdown labels of a real contact form (salutation, income, ...), read from the newest listing.
  formOptions() {
    return this.serial(async () => {
      const [listing] = (await this.searchPage(1)).resultListItems;
      if (!listing) throw new Error('Your search has no listings to read the contact form from yet');
      const page = await this.ensureBrowser();
      return (this.deps.contactor || new IS24Contactor({page})).readFormOptions(String((listing.item || listing).id));
    });
  }
  login() {
    return this.serial(async () => {
      if (this.loginCancelled) throw new Error('Login cancelled');
      if (this.browser) { await this.browser.close(); this.browser = null; }
      if (this.loginCancelled) throw new Error('Login cancelled');
      const launch = this.deps.spawn || spawn;
      const child = launch(this.config.browser?.executablePath || await puppeteer.executablePath(),[...this.browserArgs(), `--user-data-dir=${resolve(this.config.browserProfile)}`, '--no-first-run', ORIGIN],{stdio:'ignore'});
      this.loginChild = child;
      try {
        await new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',(code) => code === 0 ? resolve() : reject(new Error(`Browser exited (${code})`))); });
      } finally { this.loginChild = null; }
    });
  }
  cancelLogin() { this.loginCancelled = true; this.loginChild?.kill('SIGTERM'); }
  close() { return this.serial(async () => { if (this.browser) await this.browser.close(); this.browser=null; }); }
}
