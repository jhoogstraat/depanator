import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hash, bindingFor, configHashFor } from '../src/store.js';

const snapshot = { expose_id: '123', title: 'Apartment', price: 1000, description: 'Balcony', amenities: ['Balcony'] };
const bindings = { accountBinding: 'account', configHash: 'config' };
function reviewed(store) {
  const review = store.discover(snapshot);
  store.beginAnalysis(review.id);
  return store.saveAnalysis(review.id, snapshot, { decision: 'message', reasons: ['Fits'], draft: 'Hello\nI am interested.' }, { ...bindings, expiresAt: store.now() + 100 });
}
test('stable identity, exact approval, conditional single send and dismiss', () => {
  const store = new Store(':memory:', { now: () => 10 });
  const review = reviewed(store);
  assert.equal(store.discover({ ...snapshot, price: 2000 }), null);
  assert.throws(() => store.approve(review.id, { version: 2, draftHash: review.draftHash, ...bindings }), /stale/);
  assert.throws(() => store.approve(review.id, { version: 1, draftHash: hash('changed'), ...bindings }), /stale/);
  assert.throws(() => store.approve(review.id, { version: 1, draftHash: review.draftHash, ...bindings, accountBinding: 'other' }), /stale/);
  store.approve(review.id, { version: 1, draftHash: review.draftHash, ...bindings });
  assert.throws(() => store.approve(review.id, { version: 1, draftHash: review.draftHash, ...bindings }), /stale/);
  const claimed = store.claimSend(review.id, bindings);
  assert.equal(claimed.draft, review.draft);
  assert.equal(store.claimSend(review.id, bindings), null);
  assert.throws(() => store.dismiss(review.id, { version: 1 }), /cannot/);
  assert.equal(store.validateSubmission(review.id, { version: 1, draftHash: review.draftHash, snapshotHash: review.snapshotHash, ...bindings }), true);
  store.finishSend(review.id, { outcome: 'sent', detail: 'confirmed' });
  assert.equal(store.attempts(review.id).length, 1);
  assert.equal(store.get(review.id).status, 'sent');
  store.close();
});
test('restart retries interrupted analysis but quarantines possible submission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'depanator-store-'));
  const path = join(dir, 'state.sqlite');
  let store = new Store(path, { now: () => 10 });
  const review = reviewed(store);
  store.approve(review.id, { version: 1, draftHash: review.draftHash, ...bindings });
  store.claimSend(review.id, bindings);
  const interrupted = store.discover({ ...snapshot, expose_id: '456' });
  store.beginAnalysis(interrupted.id);
  store.close();
  store = new Store(path, { now: () => 20 });
  assert.equal(store.get(review.id).status, 'unknown_outcome');
  assert.equal(store.attempts(review.id)[0].outcome, 'unknown_outcome');
  assert.equal(store.claimSend(review.id, bindings), null);
  assert.equal(store.get(interrupted.id).status, 'discovered');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
test('expiry and changed binding invalidate approval; tampered draft cannot claim', () => {
  let now = 10;
  const store = new Store(':memory:', { now: () => now });
  const review = reviewed(store);
  store.approve(review.id, { version: 1, draftHash: review.draftHash, ...bindings });
  now = 111;
  assert.equal(store.claimSend(review.id, bindings), null);
  assert.equal(store.get(review.id).status, 'expired');
  now = 10;
  const next = store.discover({ ...snapshot, expose_id: '222' });
  store.beginAnalysis(next.id);
  const r = store.saveAnalysis(next.id, { ...snapshot, expose_id: '222' }, { decision: 'message', reasons: [], draft: 'Original' }, { ...bindings, expiresAt: 100 });
  store.approve(r.id, { version: 1, draftHash: r.draftHash, ...bindings });
  const changed = { ...store.get(r.id), draft: 'Injected' };
  store.write(changed, 'approved');
  assert.equal(store.claimSend(r.id, bindings), null);
  assert.equal(store.get(r.id).status, 'failed');
  store.close();
});
test('hash canonicalizes objects; only meaningful settings affect config binding', () => {
  assert.equal(hash({ b: 2, a: 1 }), hash({ a: 1, b: 2 }));
  const config = { searchUrl: 'search', browserProfile: '/tmp/profile', accountEmail: 'person@example.com', persona: { name: 'Person' }, preferences: 'balcony', llm: { model: 'model', baseUrl: 'https://api.example.com' }, approvalTtlMs: 100 };
  assert.equal(configHashFor(config), configHashFor({ ...config, llmApiKey: 'secret', port: 3 }));
  assert.notEqual(configHashFor(config), configHashFor({ ...config, persona: { name: 'Other' } }));
  assert.notEqual(bindingFor(config), bindingFor({ ...config, browserProfile: '/tmp/other' }));
});
