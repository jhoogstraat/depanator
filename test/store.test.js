import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../src/store.js';
import { transition, authorizes, hash, bindingFor, configHashFor, MAX_ANALYSIS_ATTEMPTS } from '../src/review.js';

const snapshot = { expose_id: '123', title: 'Apartment', price: 1000, description: 'Balcony', amenities: ['Balcony'] };
const bindings = { accountBinding: 'account', configHash: 'config' };
const message = { decision: 'message', reasons: ['Fits'], draft: 'Hello\nI am interested.' };
function reviewed(store, listing = snapshot) {
  const [review] = store.discover([listing]);
  store.dispatch(review.id, { type: 'start' });
  return store.dispatch(review.id, { type: 'analyzed', snapshot: listing, result: message, bindings });
}
function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'depanator-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state.sqlite');
}
const approve = (store, review, overrides = {}) => store.dispatch(review.id, { type: 'approve', version: review.version, draftHash: review.draftHash, bindings, ...overrides });

test('stable identity, exact approval, single claim, and dismiss', () => {
  const store = new Store(':memory:', { now: () => 10 });
  const review = reviewed(store);
  assert.deepEqual(store.discover([{ ...snapshot, price: 2000 }]), []);
  assert.throws(() => approve(store, review, { version: 2 }), /newer draft/);
  assert.throws(() => approve(store, review, { draftHash: hash('changed') }), /newer draft/);
  assert.throws(() => approve(store, review, { bindings: { ...bindings, accountBinding: 'other' } }), /Settings changed/);
  approve(store, review);
  assert.throws(() => approve(store, review), /already handled \(approved\)/);
  const claimed = store.dispatch(review.id, { type: 'claim', bindings });
  assert.equal(claimed.status, 'submitting');
  assert.equal(claimed.draft, review.draft);
  assert.throws(() => store.dispatch(review.id, { type: 'claim', bindings }), { code: 'CONFLICT' });
  assert.throws(() => store.dispatch(review.id, { type: 'dismiss', version: 1 }), /already handled/);
  assert.equal(authorizes(store.get(review.id), claimed, bindings), true);
  assert.equal(authorizes(store.get(review.id), claimed, { ...bindings, configHash: 'changed' }), false);
  assert.equal(store.dispatch(review.id, { type: 'finish', outcome: 'sent', detail: 'confirmed' }).reportedAt, null);
  assert.equal(store.dispatch(review.id, { type: 'reported' }).status, 'sent');
  store.close();
});

test('terminal states accept no event', () => {
  for (const status of ['sent', 'failed', 'unknown_outcome', 'dismissed', 'analysis_failed']) {
    for (const type of ['start', 'fail', 'analyzed', 'delivered', 'revise', 'approve', 'dismiss', 'claim', 'finish']) {
      assert.throws(() => transition({ status, version: 1 }, { type, version: 1 }, 0), { code: 'CONFLICT' });
    }
  }
});

test('restart retries interrupted analysis but quarantines a possible submission', t => {
  const path = tempDb(t);
  let store = new Store(path, { now: () => 10 });
  const review = reviewed(store);
  approve(store, review);
  store.dispatch(review.id, { type: 'claim', bindings });
  const [interrupted] = store.discover([{ ...snapshot, expose_id: '456' }]);
  store.dispatch(interrupted.id, { type: 'start' });
  store.close();
  store = new Store(path, { now: () => 20 });
  assert.equal(store.get(review.id).status, 'unknown_outcome');
  assert.equal(store.get(interrupted.id).status, 'discovered');
  assert.equal(store.get(interrupted.id).analysisAttempts, 1, 'a crash uses up the attempt');
  store.close();
});

test('approvals never expire; changed binding invalidates approval; tampered draft cannot claim', () => {
  let now = 10;
  const store = new Store(':memory:', { now: () => now });
  const review = reviewed(store);
  approve(store, review);
  now = 10 ** 12;
  assert.equal(store.dispatch(review.id, { type: 'claim', bindings: { ...bindings, configHash: 'changed' } }).status, 'failed');
  const other = reviewed(store, { ...snapshot, expose_id: '222' });
  approve(store, other);
  store.db.prepare('UPDATE reviews SET body=? WHERE id=?').run(JSON.stringify({ ...store.get(other.id), draft: 'Injected' }), other.id);
  assert.equal(store.dispatch(other.id, { type: 'claim', bindings }).status, 'failed');
  store.close();
});

test('hash canonicalizes objects; only meaningful settings affect config binding', () => {
  assert.equal(hash({ b: 2, a: 1 }), hash({ a: 1, b: 2 }));
  const config = { searchUrl: 'search', browserProfile: '/tmp/profile', accountEmail: 'person@example.com', persona: { name: 'Person' }, preferences: 'balcony', llm: { model: 'model', baseUrl: 'https://api.example.com' } };
  assert.equal(configHashFor(config), configHashFor({ ...config, llmApiKey: 'secret', port: 3 }));
  assert.notEqual(configHashFor(config), configHashFor({ ...config, persona: { name: 'Other' } }));
  assert.notEqual(bindingFor(config), bindingFor({ ...config, browserProfile: '/tmp/other' }));
});

test('failing analysis gives up, systemic failures are refunded, schema is versioned', t => {
  const path = tempDb(t);
  let store = new Store(path, { now: () => 10 });
  const [flaky] = store.discover([{ ...snapshot, expose_id: '789' }]);
  store.dispatch(flaky.id, { type: 'start' });
  store.dispatch(flaky.id, { type: 'fail', detail: 'LLM down', systemic: true });
  assert.equal(store.get(flaky.id).analysisAttempts, 0);
  for (let i = 1; i < MAX_ANALYSIS_ATTEMPTS; i++) { store.dispatch(flaky.id, { type: 'start' }); store.dispatch(flaky.id, { type: 'fail', detail: 'Bad listing' }); }
  assert.equal(store.get(flaky.id).status, 'discovered');
  store.dispatch(flaky.id, { type: 'start' }); // crash mid-analysis on the last attempt
  store.close();
  store = new Store(path, { now: () => 20 });
  assert.equal(store.dispatch(flaky.id, { type: 'start' }).status, 'analysis_failed');
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  store.db.exec('PRAGMA user_version=99');
  store.close();
  assert.throws(() => new Store(path), /newer than this agent supports/);
});

test('schema 2 databases migrate retired analyzing/expired states and drop the attempts table', t => {
  const path = tempDb(t);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE reviews (id TEXT PRIMARY KEY, expose_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE attempts (review_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT NOT NULL, draft_hash TEXT NOT NULL, detail TEXT);
    CREATE INDEX reviews_status ON reviews(status); PRAGMA user_version=2;`);
  const insert = db.prepare('INSERT INTO reviews VALUES (?,?,?,?)');
  insert.run('a', '1', 'analyzing', JSON.stringify({ id: 'a', exposeId: '1', status: 'analyzing', analysisAttempts: 2 }));
  insert.run('b', '2', 'expired', JSON.stringify({ id: 'b', exposeId: '2', status: 'expired' }));
  insert.run('c', '3', 'sent', JSON.stringify({ id: 'c', exposeId: '3', status: 'sent', finishedAt: 5 }));
  db.close();
  const store = new Store(path);
  assert.deepEqual([store.get('a').status, store.get('a').analysisAttempts], ['discovered', 2]);
  assert.deepEqual([store.get('b').status, store.get('b').detail, store.get('b').analysisAttempts], ['dismissed', 'Approval expired', 0]);
  assert.equal(store.get('c').reportedAt, 5, 'outcomes from before the upgrade are not reported again');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='attempts'").get().n, 0);
  store.close();
});
