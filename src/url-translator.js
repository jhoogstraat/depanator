// IS24 web search URL → mobile API URL, for apartment rentals only.
// Fails closed: any parameter, value or path it cannot translate exactly is rejected,
// because a dropped filter silently widens the search.

const MOBILE_API_BASE = 'https://api.mobile.immobilienscout24.de/search/list';

// Type slugs that are apartment rentals (value = new-build only). Swap flats (wohnung-mieten-tausch)
// have no mobile API filter, so they are rejected rather than widened to all rentals.
const RENT_TYPE_SLUGS = {
  'wohnung-mieten': false,
  'neubauwohnung-mieten': true,
};

// SEO paths that imply equipment / apartment-type filters (adapted from Fredy).
const SEO_PATH_FILTERS = {
  'wohnung-mit-balkon-mieten': { equipment: ['balcony'] },
  'wohnung-mit-garten-mieten': { equipment: ['garden'] },
  'souterrainwohnung-mieten': { apartmentTypes: ['halfbasement'] },
  'erdgeschosswohnung-mieten': { apartmentTypes: ['groundfloor'] },
  'hochparterrewohnung-mieten': { apartmentTypes: ['raisedgroundfloor'] },
  'etagenwohnung-mieten': { apartmentTypes: ['apartment'] },
  'loft-mieten': { apartmentTypes: ['loft'] },
  'maisonette-mieten': { apartmentTypes: ['maisonette'] },
  'terrassenwohnung-mieten': { apartmentTypes: ['terracedflat'] },
  'penthouse-mieten': { apartmentTypes: ['penthouse'] },
  'dachgeschosswohnung-mieten': { apartmentTypes: ['roofstorey'] },
  'wohnung-mit-garage-mieten': { equipment: ['parking'] },
  'wohnung-mit-einbaukueche-mieten': { equipment: ['builtinKitchen'] },
  'wohnung-mit-keller-mieten': { equipment: ['cellar'] },
  'barrierefreie-wohnung-mieten': { equipment: ['handicappedaccessible'] },
};
const SEO_MAX_WARMRENT_PATH = /^wohnung-bis-(\d+)-euro-warm$/;

const SAFE_IGNORED_PARAM = /^(enteredfrom|utm_.*|referrer|referrerurl|from|viewmode|sorting|pagenumber|pagesize)$/i;

// Passed through verbatim. Removed (2026-06-22) after the mobile API answered 412:
// has-pictures, ageofconstruction, barrier-free, pets-allowed, energy-efficiency.
const DIRECT_PARAMS = new Set([
  'exclusioncriteria', 'energyefficiencyclasses', 'petsallowedtypes', 'floor', 'haspromotion',
  'constructionyear', 'fulltext', 'osmtags', 'minimuminternetspeed', 'exclusiveonis24',
  'comingsoon', 'paywall', 'buildingtypes', 'ground',
]);

// Heating types the mobile API accepts; the others answer 412.
const HEATING_TYPES = new Set(['central', 'selfcontainedcentral', 'stove']);

// Web equipment value → mobile value. fridge/cooker/petsallowed/internet are
// silently ignored by the mobile API, so they are rejected as unknown.
const EQUIPMENT = {
  handicappedaccessible: 'handicappedaccessible', barrierfree: 'handicappedaccessible',
  onlywithbarrierfree: 'handicappedaccessible', 'barrier-free': 'handicappedaccessible',
  balcony: 'balcony', onlywithbalcony: 'balcony',
  garden: 'garden', onlywithgarden: 'garden',
  builtinkitchen: 'builtinKitchen', 'built-in-kitchen': 'builtinKitchen', kitchen: 'builtinKitchen', onlywithkitchen: 'builtinKitchen',
  elevator: 'lift', lift: 'lift', onlywithelevator: 'lift',
  parking: 'parking', onlywithparking: 'parking',
  guesttoilet: 'guesttoilet', 'guest-toilet': 'guesttoilet', onlywithguesttoilet: 'guesttoilet',
  cellar: 'cellar', onlywithbasement: 'cellar',
};

// Checkbox params that must go into equipment= (standalone booleans 412).
const EQUIPMENT_CHECKBOXES = new Set([
  'onlywithbalcony', 'onlywithgarden', 'onlywithparking', 'onlywithkitchen', 'onlywithelevator',
  'onlywithguesttoilet', 'onlywithbasement', 'onlywithbarrierfree',
  'balcony', 'garden', 'parking', 'cellar', 'elevator', 'barrier-free',
]);

function parseRange(raw, label) {
  const value = String(raw ?? '').trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) return { min: Number(value), max: Number(value) };
  const m = value.match(/^(\d+(?:\.\d+)?)?-(\d+(?:\.\d+)?)?$/);
  const min = m?.[1] ? Number(m[1]) : null;
  const max = m?.[2] ? Number(m[2]) : null;
  if (!m || (min === null && max === null) || (min !== null && max !== null && min > max)) throw new Error(`Invalid ${label} range: ${value}`);
  return { min, max };
}

function formatRange(range) {
  if (range.min === null && range.max === null) return null;
  if (range.min !== null && range.min === range.max) return String(range.min);
  return `${range.min ?? ''}-${range.max ?? ''}`;
}

// geocoordinates=lat;lon;radiusKm. null when malformed.
function parseGeoCoordinates(raw) {
  const parts = String(raw ?? '').split(';').map(p => p.trim());
  if (parts.length !== 3 || parts.some(p => p === '')) return null;
  const [lat, lon, radiusKm] = parts.map(Number);
  if (![lat, lon, radiusKm].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || radiusKm <= 0) return null;
  return { lat, lon, radiusKm };
}

function splitValues(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function parse(webUrl) {
  const input = String(webUrl || '').trim();
  if (!input) throw new Error('Invalid URL');
  const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  if (!['www.immobilienscout24.de', 'immobilienscout24.de'].includes(url.hostname)) throw new Error('URL is not an immobilienscout24.de search link');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('HTTPS without credentials, port or fragment required');
  const pathParts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const sucheIdx = pathParts.findIndex(p => p.toLowerCase() === 'suche');
  if (sucheIdx === -1) throw new Error('URL does not contain /Suche/ path');

  // Last segment = type slug; segments between /Suche/ and it = geocode,
  // optionally prefixed by 'radius' or 'shape'.
  const afterSuche = pathParts.slice(sucheIdx + 1);
  const typeSlug = afterSuche.at(-1) || '';
  const seo = Object.hasOwn(SEO_PATH_FILTERS, typeSlug) ? SEO_PATH_FILTERS[typeSlug] : null;
  const warmrent = typeSlug.match(SEO_MAX_WARMRENT_PATH);
  if (!Object.hasOwn(RENT_TYPE_SLUGS, typeSlug) && !seo && !warmrent) throw new Error(`Only apartment rental searches (wohnung-mieten) are supported, not: ${typeSlug || 'none'}`);
  let geocodeParts = afterSuche.slice(0, -1);
  const searchPrefix = geocodeParts[0];
  if (searchPrefix === 'shape') throw new Error('Map-drawn (shape) searches are not supported. Switch to a radius or district search on immobilienscout24.de and copy that URL.');
  if (searchPrefix === 'radius') geocodeParts = geocodeParts.slice(1);

  const canonical = {
    geocode: geocodeParts.length ? `/${geocodeParts.join('/')}` : '',
    center: null,
    newBuildingOnly: RENT_TYPE_SLUGS[typeSlug] === true,
    price: warmrent ? { min: null, max: Number(warmrent[1]), type: 'calculatedtotalrent' } : { min: null, max: null, type: 'calculatedtotalrent' },
    rooms: { min: null, max: null },
    livingSpace: { min: null, max: null },
    heatingTypes: [],
    equipment: [...(seo?.equipment || [])],
    apartmentTypes: seo?.apartmentTypes || [],
    directParams: [],
  };
  const rejected = [];
  const seen = new Set();

  for (const [rawKey, value] of url.searchParams) {
    const key = rawKey.toLowerCase();
    if (SAFE_IGNORED_PARAM.test(key)) continue;
    if (key === 'centerofsearchaddress') continue; // display-only
    if (seen.has(key) || !value.trim()) { rejected.push(`${rawKey}=Duplicate or empty filter`); continue; }
    seen.add(key);
    if (key === 'price') canonical.price = { ...parseRange(value, 'price'), type: canonical.price.type };
    else if (key === 'numberofrooms') canonical.rooms = parseRange(value, 'number of rooms');
    else if (key === 'livingspace') canonical.livingSpace = parseRange(value, 'living space');
    else if (key === 'pricetype') canonical.price.type = value;
    else if (key === 'heatingtypes') {
      for (const v of splitValues(value)) {
        if (HEATING_TYPES.has(v.toLowerCase())) canonical.heatingTypes.push(v.toLowerCase());
        else rejected.push(`${rawKey}=${v}`);
      }
    } else if (key === 'equipment') {
      for (const v of splitValues(value)) {
        if (EQUIPMENT[v.toLowerCase()]) canonical.equipment.push(EQUIPMENT[v.toLowerCase()]);
        else rejected.push(`${rawKey}=${v}`);
      }
    } else if (EQUIPMENT_CHECKBOXES.has(key) || key === 'newbuilding') {
      // Presence means true upstream; reject false/ambiguous forms.
      if (!['true', '1'].includes(value)) rejected.push(`${rawKey}=${value}`);
      else if (key === 'newbuilding') canonical.newBuildingOnly = true;
      else canonical.equipment.push(EQUIPMENT[key]);
    } else if (key === 'apartmenttypes') canonical.apartmentTypes = splitValues(value);
    else if (key === 'exclusioncriteria') {
      canonical.directParams.push({ key, value: splitValues(value).map(v => v.toLowerCase() === 'swapflat' ? 'swap_flat' : v).join(',') });
    } else if (DIRECT_PARAMS.has(key)) canonical.directParams.push({ key, value });
    else if (key === 'geocoordinates') {
      canonical.center = parseGeoCoordinates(value);
      if (!canonical.center) rejected.push(`${rawKey}=${value}`);
    } else rejected.push(`${rawKey}=${value}`);
  }

  if (searchPrefix === 'radius' && !canonical.center && !rejected.length) {
    throw new Error('This radius link is missing its map coordinates. Open the search on immobilienscout24.de and copy the URL from the results page again.');
  }
  if (rejected.length) throw new Error(`Unsupported IS24 search filters: ${rejected.join(', ')}`);
  canonical.heatingTypes = [...new Set(canonical.heatingTypes)];
  canonical.equipment = [...new Set(canonical.equipment)];
  return canonical;
}

/** Validate an IS24 apartment-rental search URL. Returns {ok, error, canonical}. */
export function validateSearchUrl(webUrl) {
  try {
    return { ok: true, error: null, canonical: parse(webUrl) };
  } catch (err) {
    return { ok: false, error: err.message, canonical: null };
  }
}

/** Build a mobile API list URL from a validated canonical search. */
export function buildMobileApiUrl(canonical, { page = 1 } = {}) {
  const params = new URLSearchParams();
  if (canonical.center) {
    // Radius needs geocoordinates; geocodes are ignored when both are present.
    const { lat, lon, radiusKm } = canonical.center;
    params.set('searchType', 'radius');
    params.set('geocoordinates', `${lat};${lon};${radiusKm}`);
  } else {
    if (canonical.geocode) params.set('geocodes', canonical.geocode);
    params.set('searchType', 'region');
  }
  params.set('realestatetype', 'apartmentrent');
  params.set('pricetype', canonical.price.type);
  for (const [key, range] of [['price', canonical.price], ['numberofrooms', canonical.rooms], ['livingspace', canonical.livingSpace]]) {
    const formatted = formatRange(range);
    if (formatted) params.set(key, formatted);
  }
  if (canonical.newBuildingOnly) params.set('newbuilding', 'true');
  if (canonical.heatingTypes.length) params.set('heatingtypes', canonical.heatingTypes.join(','));
  if (canonical.equipment.length) params.set('equipment', canonical.equipment.join(','));
  for (const { key, value } of canonical.directParams) params.append(key, value);
  if (canonical.apartmentTypes.length) params.append('apartmenttypes', canonical.apartmentTypes.join(','));
  params.set('sorting', '-firstactivation');
  params.set('pagenumber', String(page));
  params.set('pagesize', '20');
  return `${MOBILE_API_BASE}?${params.toString()}`;
}
