import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
export function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
}
export function bindingFor(config) {
  return hash({ browserProfile: resolve(config.browserProfile), accountEmail: config.accountEmail.toLowerCase().trim() });
}
export function configHashFor(config) {
  const { searchUrl, accountEmail, browserProfile, persona, preferences, llm, approvalTtlMs, browser } = config;
  // Secrets and notification destinations do not authorize or change a message.
  return hash({ searchUrl, accountEmail, browserProfile: resolve(browserProfile), persona, preferences, llm: llm && { model: llm.model, baseUrl: llm.baseUrl, ...(llm.backend === 'codex' ? { backend: llm.backend, codexHome: llm.codexHome } : {}) }, approvalTtlMs, browser });
}
// The single source of truth for review lifecycle. Every status write is checked against it.
export const TRANSITIONS = {
  discovered: ['analyzing'],
  analyzing: ['discovered', 'awaiting_approval', 'dismissed', 'analysis_failed'],
  awaiting_approval: ['approved', 'dismissed', 'expired'],
  approved: ['submitting', 'dismissed', 'expired', 'failed'],
  submitting: ['sent', 'failed', 'unknown_outcome'],
  analysis_failed: [], dismissed: [], expired: [], failed: [], sent: [], unknown_outcome: [],
};
// ponytail: fixed cap; a long LLM outage can exhaust it. Raise or add backoff if listings get lost.
export const MAX_ANALYSIS_ATTEMPTS = 5;
// Append-only. Index i upgrades schema version i to i+1; never edit a shipped entry.
const MIGRATIONS = [
  // IF NOT EXISTS adopts databases created before schema versioning.
  `CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, expose_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS attempts (review_id TEXT PRIMARY KEY REFERENCES reviews(id), started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT NOT NULL, draft_hash TEXT NOT NULL, detail TEXT);`,
  // Every poll selects by status.
  'CREATE INDEX IF NOT EXISTS reviews_status ON reviews(status);',
];
export const SCHEMA_VERSION = MIGRATIONS.length;
// Expiry is time-based, so a stored status can be stale until the next write; readers use this.
export function displayStatus(review, now = Date.now()) {
  return ['awaiting_approval', 'approved'].includes(review.status) && review.expiresAt <= now ? 'expired' : review.status;
}
function conflict(message) {
  const error = new Error(message);
  error.code = 'CONFLICT';
  throw error;
}
export class Store {
  constructor(path, { now = Date.now } = {}) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.migrate();
    this.recover();
  }
  migrate() {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get();
    if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than this agent supports (${SCHEMA_VERSION}); upgrade the agent`);
    for (let next = version; next < SCHEMA_VERSION; next++) {
      this.transaction(() => { this.db.exec(MIGRATIONS[next]); this.db.exec(`PRAGMA user_version=${next + 1}`); });
    }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  write(review, expectedStatus) {
    if (review.status !== expectedStatus && !TRANSITIONS[expectedStatus]?.includes(review.status)) throw new Error(`Illegal review transition ${expectedStatus} -> ${review.status}`);
    const result = this.db.prepare('UPDATE reviews SET status=?, body=? WHERE id=? AND status=?').run(review.status, JSON.stringify(review), review.id, expectedStatus);
    if (!result.changes) conflict('Review state changed');
    return review;
  }
  get(id) {
    const row = this.db.prepare('SELECT body FROM reviews WHERE id=?').get(id);
    return row ? JSON.parse(row.body) : null;
  }
  list() {
    this.expire();
    return this.db.prepare('SELECT body FROM reviews ORDER BY rowid DESC').all().map(row => JSON.parse(row.body));
  }
  count() { return this.db.prepare('SELECT COUNT(*) AS count FROM reviews').get().count; }
  select(status) { return this.db.prepare('SELECT body FROM reviews WHERE status=? ORDER BY rowid').all(status).map(row => JSON.parse(row.body)); }
  discover(snapshot) {
    const exposeId = String(snapshot.expose_id ?? '');
    if (!/^\d+$/.test(exposeId)) throw new Error('Invalid expose ID');
    const review = { id: randomUUID(), exposeId, status: 'discovered', snapshot: structuredClone(snapshot), version: 1, draft: '', draftHash: null, reasons: [], accountBinding: null, configHash: null, expiresAt: null, createdAt: this.now(), notifiedAt: null };
    const result = this.db.prepare('INSERT OR IGNORE INTO reviews(id,expose_id,status,body) VALUES(?,?,?,?)').run(review.id, exposeId, review.status, JSON.stringify(review));
    return result.changes ? review : null;
  }
  pendingAnalysis() { return this.select('discovered'); }
  pendingNotifications() { this.expire(); return this.select('awaiting_approval').filter(review => review.notifiedAt == null); }
  approved() { this.expire(); return this.select('approved'); }
  beginAnalysis(id) {
    const review = this.get(id);
    if (!review || review.status !== 'discovered') return null;
    return this.write({ ...review, status: 'analyzing', analysisAttempts: (review.analysisAttempts ?? 0) + 1, detail: undefined }, 'discovered');
  }
  saveAnalysis(id, snapshot, result, bindings) {
    const review = this.get(id);
    if (!review || review.status !== 'analyzing') conflict('Review is not being analyzed');
    if (String(snapshot.expose_id) !== review.exposeId) conflict('Listing identity changed');
    if (!['message', 'dismiss'].includes(result.decision) || !Array.isArray(result.reasons) || result.reasons.some(reason => typeof reason !== 'string') || typeof result.draft !== 'string' || (result.decision === 'message' && !result.draft.trim())) throw new Error('Invalid analysis result');
    return this.write({ ...review, snapshot: structuredClone(snapshot), snapshotHash: hash(snapshot), status: result.decision === 'message' ? 'awaiting_approval' : 'dismissed', reasons: result.reasons, draft: result.draft, draftHash: hash(result.draft), ...bindings }, 'analyzing');
  }
  // refund: the failure was not the listing's fault (shutdown, outage), so the attempt does not count.
  failAnalysis(id, detail, { refund = false } = {}) {
    const review = this.get(id);
    if (review?.status !== 'analyzing') return null;
    return this.write(this.retryOrGiveUp({ ...review, analysisAttempts: review.analysisAttempts - (refund ? 1 : 0) }, detail), 'analyzing');
  }
  retryOrGiveUp(review, detail) {
    return review.analysisAttempts >= MAX_ANALYSIS_ATTEMPTS ? { ...review, status: 'analysis_failed', detail: `Gave up after ${review.analysisAttempts} attempts: ${detail}` } : { ...review, status: 'discovered', detail };
  }
  markNotified(id) {
    const review = this.get(id);
    if (review?.status === 'awaiting_approval') this.write({ ...review, notifiedAt: this.now(), notificationError: undefined }, 'awaiting_approval');
  }
  notificationFailed(id, detail) {
    const review = this.get(id);
    if (review?.status === 'awaiting_approval') this.write({ ...review, notificationError: detail }, 'awaiting_approval');
  }
  expire() {
    for (const status of ['awaiting_approval', 'approved']) for (const review of this.select(status)) {
      if (displayStatus(review, this.now()) === 'expired') this.write({ ...review, status: 'expired', detail: 'Approval expired' }, status);
    }
  }
  intact(review, bindings) {
    return review.expiresAt > this.now() && review.draftHash === hash(review.draft) && review.snapshotHash === hash(review.snapshot) && String(review.snapshot.expose_id) === review.exposeId && review.accountBinding === bindings.accountBinding && review.configHash === bindings.configHash;
  }
  approve(id, { version, draftHash, accountBinding, configHash }) {
    return this.transaction(() => {
      this.expire();
      const review = this.get(id);
      if (!review || review.status !== 'awaiting_approval' || review.version !== version || review.draftHash !== draftHash || !this.intact(review, { accountBinding, configHash })) conflict('Review is stale, expired, or has changed');
      return this.write({ ...review, status: 'approved', approvedAt: this.now() }, 'awaiting_approval');
    });
  }
  // A new version invalidates every Telegram button signed for the previous draft.
  reviseDraft(id, { version, draft, reasons, expiresAt }) {
    if (typeof draft !== 'string' || !draft.trim()) throw new Error('Invalid revised draft');
    return this.transaction(() => {
      this.expire();
      const review = this.get(id);
      if (!review || review.status !== 'awaiting_approval' || review.version !== version) conflict('Review was already handled, changed, or expired');
      return this.write({ ...review, version: version + 1, draft, draftHash: hash(draft), reasons, expiresAt, notifiedAt: null, notificationError: undefined }, 'awaiting_approval');
    });
  }
  dismiss(id, { version }) {
    return this.transaction(() => {
      const review = this.get(id);
      if (!review || !['awaiting_approval', 'approved'].includes(review.status) || review.version !== version) conflict('Review cannot be dismissed');
      return this.write({ ...review, status: 'dismissed', detail: 'Dismissed by user' }, review.status);
    });
  }
  claimSend(id, bindings) {
    return this.transaction(() => {
      const review = this.get(id);
      if (!review || review.status !== 'approved') return null;
      if (!this.intact(review, bindings)) return this.write({ ...review, status: review.expiresAt <= this.now() ? 'expired' : 'failed', detail: 'Approval binding changed' }, 'approved') && null;
      if (this.db.prepare('SELECT review_id FROM attempts WHERE review_id=?').get(id)) return null;
      this.db.prepare('INSERT INTO attempts(review_id,started_at,outcome,draft_hash) VALUES(?,?,?,?)').run(id, this.now(), 'submitting', review.draftHash);
      return this.write({ ...review, status: 'submitting' }, 'approved');
    });
  }
  validateSubmission(id, { version, draftHash, snapshotHash, ...bindings }) {
    const review = this.get(id);
    return Boolean(review && review.status === 'submitting' && review.version === version && review.draftHash === draftHash && review.snapshotHash === snapshotHash && this.intact(review, bindings));
  }
  finishSend(id, { outcome, detail = '' }) {
    if (!['sent', 'failed', 'unknown_outcome'].includes(outcome)) throw new Error('Invalid submission outcome');
    return this.transaction(() => {
      const review = this.get(id);
      if (!review || review.status !== 'submitting') conflict('Submission is not active');
      this.db.prepare('UPDATE attempts SET finished_at=?,outcome=?,detail=? WHERE review_id=?').run(this.now(), outcome, detail, id);
      return this.write({ ...review, status: outcome, detail, finishedAt: this.now() }, 'submitting');
    });
  }
  attempts(id) { return this.db.prepare('SELECT * FROM attempts WHERE review_id=?').all(id); }
  recover() {
    for (const review of this.select('analyzing')) this.write(this.retryOrGiveUp(review, 'Analysis interrupted; pending retry'), 'analyzing');
    for (const review of this.select('submitting')) this.finishSend(review.id, { outcome: 'unknown_outcome', detail: 'Process stopped during submission; verify account history before any further action' });
    this.expire();
  }
  close() { this.db.close(); }
}
