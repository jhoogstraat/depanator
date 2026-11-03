// One IS24 search per distinct query on the admin's list, however many people picked it. Searches run only when
// someone's check asks for them, so one that nobody active picked costs nothing. Each person's rent, rooms and
// area are matched here, on the shared results, and never reach IS24.
const PAGES = 3; // A poll stops at the first known listing, so this is only reached in a busy spell.
const EXPOSE_MS = 600_000;

// Why a listing is outside the person's search, or ''. A fact the listing does not state is not a miss.
// Limits are warm rent. priced: false for result-list items, whose unlabeled price may be warm or cold, so it
// only proves a rent too high (warm is never below cold). That still saves reading the listing.
export function outsideSearch(filters, listing, { priced = true } = {}) {
  const rent = priced ? filters.price : { min: null, max: filters.price.max };
  const checks = [['Rent', rent, listing.price, ' €'], ['Rooms', filters.rooms, listing.rooms, ''], ['Area', filters.livingSpace, listing.area, ' m²']];
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
    const key = JSON.stringify(filters);
    const feed = this.feeds.get(key) ?? { seen: new Set(), at: -Infinity, result: null };
    this.feeds.set(key, feed);
    if (this.now() - feed.at < this.ttlMs()) return feed.result;
    feed.at = this.now();
    // A feed's first poll is everyone's baseline (a restart, or a search just picked), and the next poll stops at
    // what this one saw, so older pages would never matter: one request is enough.
    // ponytail: `seen` is per process. Someone back from a longer night pause than the others sees only what the
    // last polls returned.
    const first = !feed.seen.size;
    feed.result = this.adapter.scan(filters, { maxPages: first ? 1 : PAGES, known: id => feed.seen.has(id) }).then(result => {
      for (const listing of result.listings) feed.seen.add(listing.expose_id);
      return { ...result, complete: first || result.complete };
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
