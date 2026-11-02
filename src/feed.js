// One IS24 search per distinct query, however many people use it. Rent, rooms and area are matched here,
// so they leave the query. Everything else stays in it: address text cannot prove a district and the
// result list has no equipment data, and a filter must never be silently dropped. People who differ only
// in rent, rooms or area share a feed; a different area or equipment filter costs one more request per check.
const PAGES = 3; // A poll stops at the first known listing, so this is only reached after a restart or a busy spell.
const EXPOSE_MS = 600_000;

export function feedFilters(filters) {
  const open = { min: null, max: null };
  return { ...filters, price: { ...open, type: 'calculatedtotalrent' }, rooms: open, livingSpace: open };
}

// Why a listing is outside the person's search, or ''. A fact the listing does not state is not a miss.
// priced: false for result-list items, whose unlabeled price may be warm or cold; details have the right one.
export function outsideSearch(filters, listing, { priced = true } = {}) {
  const checks = [['Rent', filters.price, priced ? listing.price : 0, ' €'], ['Rooms', filters.rooms, listing.rooms, ''], ['Area', filters.livingSpace, listing.area, ' m²']];
  for (const [label, { min, max }, value, unit] of checks) {
    if (!value) continue;
    if (min !== null && value < min) return `${label} ${value}${unit} is below your search minimum of ${min}${unit}`;
    if (max !== null && value > max) return `${label} ${value}${unit} is above your search maximum of ${max}${unit}`;
  }
  return '';
}

export class Feeds {
  // adapter: scan() and expose(). ttlMs() -> how long one result, or failure, serves everybody in a check round.
  constructor(adapter, { ttlMs = () => 0, now = Date.now } = {}) {
    Object.assign(this, { adapter, ttlMs, now });
    this.feeds = new Map();
    this.exposes = new Map();
  }
  search(filters) {
    const query = feedFilters(filters);
    const key = JSON.stringify(query);
    const feed = this.feeds.get(key) ?? { seen: new Set(), at: -Infinity, result: null };
    this.feeds.set(key, feed);
    if (this.now() - feed.at < this.ttlMs()) return feed.result;
    feed.at = this.now();
    // ponytail: `seen` is per process, so the first poll after a restart reads all PAGES. Someone back from a
    // longer night pause than the others sees only what the last polls returned.
    feed.result = this.adapter.scan(query, { maxPages: PAGES, known: id => feed.seen.has(id) }).then(result => {
      for (const listing of result.listings) feed.seen.add(listing.expose_id);
      return result;
    });
    return feed.result;
  }
  // Screening reads each listing once for everybody. Sending never comes here: it rechecks the live listing.
  expose(id) {
    const now = this.now();
    for (const [key, entry] of this.exposes) if (now - entry.at >= EXPOSE_MS) this.exposes.delete(key);
    const entry = this.exposes.get(id) ?? { at: now, result: this.adapter.expose(id) };
    this.exposes.set(id, entry);
    entry.result.catch(() => this.exposes.delete(id)); // A failed read is tried again by the next person.
    return entry.result;
  }
}
