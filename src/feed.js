import { DatabaseSync } from 'node:sqlite';
import { isQuiet } from './settings.js';

// The admin's searches, each crawled on its own schedule into one table that everybody reads (push, not rounds).
// One IS24 request per due search, however many people picked it; a search nobody searching picked costs nothing.
// Each person's rent, rooms and area are matched on what they read, and never reach IS24.
export const PAGES = 3; // A crawl stops at the first known listing, so this is only reached in a busy spell.
const EXPOSE_MS = 600_000;
const ALERT_AFTER = 3;
const MAX_BACKOFF_MS = 3_600_000;
// A search's identity: its query. A renamed search keeps its listings and everybody's place in them.
export const feedKey = filters => JSON.stringify(filters);

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

// seen_listings, as the table: one row per search and listing, the first time a crawl saw it. `existing`: a crawl
// that started a search's history (its first, or the first after nobody followed it) only notes what is online.
const SCHEMA = `CREATE TABLE IF NOT EXISTS listings (seq INTEGER PRIMARY KEY AUTOINCREMENT, search TEXT NOT NULL, expose_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL, existing INTEGER NOT NULL, listing TEXT NOT NULL, UNIQUE(search, expose_id));
CREATE TABLE IF NOT EXISTS feeds (search TEXT PRIMARY KEY, crawled_at INTEGER, baseline INTEGER NOT NULL DEFAULT 1);`;

export class Feeds {
  // adapter: scan() and expose(). file: the shared database. searches() -> [{ key, name, filters, intervalMs, quietHours, wanted }].
  // onCrawled(key) after every successful crawl, new rows or not. onAlert(key, text): a failure streak or its end.
  constructor(adapter, { file = ':memory:', searches = () => [], onCrawled = () => {}, onAlert = () => {}, onError = () => {}, now = Date.now, random = Math.random } = {}) {
    Object.assign(this, { adapter, searches, onCrawled, onAlert, onError, now, random });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(SCHEMA);
    this.exposes = new Map();
    this.timers = new Map(); // key -> { timer, intervalMs, at: when its last loop ended }
    this.health = new Map(); // key -> { failures, skip, blocked }
    this.stopped = false;
  }
  // Arms a timer for every search on the list and drops those removed; a changed interval applies right away.
  // Call again whenever the list changes. A search new to this run is crawled at once.
  refresh() {
    if (this.stopped) return;
    const searches = new Map(this.searches().map(search => [search.key, search]));
    for (const [key, entry] of this.timers) {
      if (!searches.has(key)) { clearTimeout(entry.timer); this.timers.delete(key); }
      else if (entry.intervalMs !== searches.get(key).intervalMs) { clearTimeout(entry.timer); this.arm(key, searches.get(key).intervalMs, Math.max(0, entry.at + searches.get(key).intervalMs - this.now())); }
    }
    for (const key of searches.keys()) if (!this.timers.has(key)) this.arm(key, searches.get(key).intervalMs, 0);
  }
  // ±10% jitter keeps crawls from forming an exact pattern.
  arm(key, intervalMs, delay = intervalMs * (0.9 + this.random() * 0.2)) {
    const entry = { intervalMs, at: this.timers.get(key)?.at ?? this.now(), timer: null };
    entry.timer = setTimeout(() => this.loop(key), delay);
    this.timers.set(key, entry);
  }
  async loop(key) {
    const search = this.searches().find(entry => entry.key === key);
    if (!search || this.stopped) return void this.timers.delete(key);
    await this.crawl(search).catch(error => this.onError(`${search.name}: ${error.message}`));
    if (this.stopped || !this.timers.has(key)) return;
    this.timers.get(key).at = this.now();
    this.arm(key, search.intervalMs);
  }
  // One crawl of one search, or why it did not run.
  async crawl(search) {
    const { key } = search;
    if (!search.wanted) { this.feed(key, { baseline: 1 }); return { unwanted: true }; } // Its history goes stale.
    if (isQuiet(search.quietHours, this.now())) return { quiet: true }; // The morning crawl brings the night's listings.
    const health = this.health.get(key) ?? { failures: 0, skip: 0, blocked: false };
    this.health.set(key, health);
    if (health.skip > 0) { health.skip--; return { skipped: true }; }
    const baseline = this.feedRow(key).baseline === 1;
    const known = this.db.prepare('SELECT 1 FROM listings WHERE search=? AND expose_id=?');
    let result;
    try {
      // A baseline needs only what is online now; after that, pages up to the first known listing.
      result = await this.adapter.scan(search.filters, { maxPages: baseline ? 1 : PAGES, known: id => Boolean(known.get(key, id)) });
    } catch (error) { await this.failed(search, health, error); throw error; }
    const insert = this.db.prepare('INSERT OR IGNORE INTO listings(search, expose_id, seen_at, existing, listing) VALUES(?,?,?,?,?)');
    const at = this.now();
    this.db.exec('BEGIN');
    try {
      for (const listing of result.listings.toReversed()) insert.run(key, listing.expose_id, at, baseline ? 1 : 0, JSON.stringify(listing)); // Oldest first.
      this.feed(key, { crawled_at: at, baseline: 0 });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (health.failures >= ALERT_AFTER) this.onAlert(key, `✅ IS24 search ${search.name} recovered; normal operation resumed.`);
    Object.assign(health, { failures: 0, blocked: false });
    if (!result.complete) this.onError(`${search.name}: page limit reached; search coverage is partial`);
    this.onCrawled(key);
    return result;
  }
  // The pause doubles with every failure (skip 0, 1, 3, 7... crawls), capped near one hour.
  async failed(search, health, error) {
    health.failures++;
    health.blocked = error.code === 'BLOCKED';
    health.skip = Math.min(2 ** (health.failures - 1), Math.max(1, Math.floor(MAX_BACKOFF_MS / search.intervalMs))) - 1;
    this.onError(`health_error: IS24 search ${search.name} failure ${health.failures}: ${error.message}`);
    if (health.failures === ALERT_AFTER) this.onAlert(search.key, `⚠️ IS24 search ${search.name} failed ${health.failures} times in a row.\nLast error: ${error.message}\nI keep retrying with longer pauses. If it continues, IS24 may be blocking this connection.`);
  }
  feedRow(key) { return this.db.prepare('SELECT crawled_at, baseline FROM feeds WHERE search=?').get(key) ?? { crawled_at: null, baseline: 1 }; }
  feed(key, values) {
    const row = { ...this.feedRow(key), ...values };
    this.db.prepare('INSERT INTO feeds(search, crawled_at, baseline) VALUES(?,?,?) ON CONFLICT(search) DO UPDATE SET crawled_at=excluded.crawled_at, baseline=excluded.baseline').run(key, row.crawled_at, row.baseline);
  }
  // The rows of one search after position `after`, oldest first: [{ seq, existing, listing }].
  rows(key, after = 0) {
    return this.db.prepare('SELECT seq, existing, listing FROM listings WHERE search=? AND seq>? ORDER BY seq').all(key, after)
      .map(row => ({ seq: row.seq, existing: row.existing === 1, listing: JSON.parse(row.listing) }));
  }
  // The newest position of one search (0 before its first crawl), and the `limit` newest listings up to it.
  latest(key, limit = 0) {
    const seq = this.db.prepare('SELECT MAX(seq) AS seq FROM listings WHERE search=?').get(key).seq ?? 0;
    const listings = limit ? this.db.prepare('SELECT listing FROM listings WHERE search=? ORDER BY seq DESC LIMIT ?').all(key, limit).map(row => JSON.parse(row.listing)) : [];
    return { seq, listings };
  }
  // For /status: when it last crawled, and its failure streak.
  status(key) {
    const { failures = 0, blocked = false } = this.health.get(key) ?? {};
    return { crawledAt: this.feedRow(key).crawled_at, failures, blocked };
  }
  // Until when the crawlers count as alive: a loop that hangs (a crawl that never ends) lets this lapse.
  healthyUntil() {
    const deadlines = [...this.timers.values()].map(entry => entry.at + 2 * entry.intervalMs + 600_000);
    return deadlines.length ? Math.min(...deadlines) : this.now() + 600_000;
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
  // No more crawls; reads still work until close().
  stop() {
    this.stopped = true;
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  close() { this.stop(); this.db.close(); }
}
