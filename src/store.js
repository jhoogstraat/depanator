import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { conflict, newReview, transition } from './review.js';

// Append-only. Index i upgrades schema version i to i+1; never edit a shipped entry.
const MIGRATIONS = [
  // IF NOT EXISTS adopts databases created before schema versioning.
  `CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, expose_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS attempts (review_id TEXT PRIMARY KEY REFERENCES reviews(id), started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT NOT NULL, draft_hash TEXT NOT NULL, detail TEXT);`,
  // Every poll selects by status.
  'CREATE INDEX IF NOT EXISTS reviews_status ON reviews(status);',
  // Retired states: analysis in progress is now a counted attempt on `discovered`, and approvals no
  // longer expire. The attempts table duplicated each review's own submission status. Earlier
  // outcomes were reported live, so they count as reported.
  `UPDATE reviews SET status='discovered', body=json_set(body, '$.status', 'discovered') WHERE status='analyzing';
   UPDATE reviews SET status='dismissed', body=json_set(body, '$.status', 'dismissed', '$.detail', 'Approval expired') WHERE status='expired';
   UPDATE reviews SET body=json_set(body, '$.analysisAttempts', 0) WHERE json_extract(body, '$.analysisAttempts') IS NULL;
   UPDATE reviews SET body=json_set(body, '$.reportedAt', COALESCE(json_extract(body, '$.finishedAt'), 0)) WHERE status IN ('sent', 'failed', 'unknown_outcome');
   DROP TABLE attempts;`,
  // Settings made in the Telegram chat.
  'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
];
export const SCHEMA_VERSION = MIGRATIONS.length;

// Durable reviews. Every status change goes through dispatch(), which applies the review.js state
// machine atomically. Telegram delivery metadata does not change review state.
export class Store {
  constructor(path, { now = Date.now } = {}) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get();
    if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than this agent supports (${SCHEMA_VERSION}); upgrade the agent`);
    for (let next = version; next < SCHEMA_VERSION; next++) {
      this.transaction(() => { this.db.exec(MIGRATIONS[next]); this.db.exec(`PRAGMA user_version=${next + 1}`); });
    }
    // The process stopped mid-submission: IS24 may or may not have received it, so it is never retried.
    for (const review of this.list('submitting')) this.dispatch(review.id, { type: 'finish', outcome: 'unknown_outcome', detail: 'Process stopped during submission; verify account history before any further action' });
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  // Stable listing IDs: an already-known listing is ignored, even if its price changed. Returns the new reviews.
  // fresh: found by a search that had caught up with known listings, i.e. newly published (auto-send eligible).
  // existing: only note the listings (status `existing`), so they are known but never analyzed.
  discover(snapshots, { fresh = false, existing = false } = {}) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO reviews(id,expose_id,status,body) VALUES(?,?,?,?)');
    return this.transaction(() => snapshots.flatMap(snapshot => {
      const review = { ...newReview({ id: randomUUID(), snapshot, now: this.now() }), fresh, ...(existing && { status: 'existing' }) };
      return insert.run(review.id, review.exposeId, review.status, JSON.stringify(review)).changes ? [review] : [];
    }));
  }
  get(id) {
    const row = this.db.prepare('SELECT body FROM reviews WHERE id=?').get(id);
    return row ? JSON.parse(row.body) : null;
  }
  // Oldest first, optionally only one status.
  list(status) {
    const rows = status ? this.db.prepare('SELECT body FROM reviews WHERE status=? ORDER BY rowid').all(status) : this.db.prepare('SELECT body FROM reviews ORDER BY rowid').all();
    return rows.map(row => JSON.parse(row.body));
  }
  has(exposeId) { return Boolean(this.db.prepare('SELECT 1 FROM reviews WHERE expose_id=?').get(String(exposeId))); }
  settings() { return Object.fromEntries(this.db.prepare('SELECT key, value FROM settings').all().map(row => [row.key, JSON.parse(row.value)])); }
  saveSetting(key, value) { this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  deleteSetting(key) { this.db.prepare('DELETE FROM settings WHERE key=?').run(key); }
  count() { return this.db.prepare('SELECT COUNT(*) AS count FROM reviews').get().count; }
  recordTelegramMessage(id, chatId, messageId) {
    this.transaction(() => {
      const review = this.get(id) ?? conflict('Unknown review');
      const next = { ...review, telegramMessages: [...(review.telegramMessages || []), { chatId, messageId }] };
      this.db.prepare('UPDATE reviews SET body=? WHERE id=?').run(JSON.stringify(next), id);
    });
  }
  // Throws CONFLICT when the event does not apply to the review's current status.
  dispatch(id, event) {
    return this.transaction(() => {
      const review = this.get(id) ?? conflict('Unknown review');
      const next = transition(review, event, this.now());
      this.db.prepare('UPDATE reviews SET status=?, body=? WHERE id=?').run(next.status, JSON.stringify(next), id);
      return next;
    });
  }
  close() { this.db.close(); }
}
