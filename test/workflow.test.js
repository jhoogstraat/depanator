import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';

function fixture(overrides = {}) {
  const snapshot = { expose_id: '123', title: 'Apartment', price: 1000, rooms: 2, area: 60, description: 'A balcony.', amenities: ['Balcony'], url: 'https://www.immobilienscout24.de/expose/123' };
  const config = { searchUrl: 'search', browserProfile: '/tmp/profile', accountEmail: 'person@example.com', persona: {}, preferences: 'balcony', llm: { model: 'fixture', baseUrl: 'fixture' }, approvalTtlMs: 1000 };
  const store = new Store(':memory:', { now: () => 100 });
  const calls = { search: 0, evaluate: 0, notify: 0, send: 0 };
  const adapter = {
    search: async () => { calls.search++; return { listings: [snapshot], complete: true, pages: 1 }; },
    details: async () => snapshot,
    send: async (review, { beforeSubmit }) => { await beforeSubmit(); calls.send++; assert.equal(review.draft, 'Hello, I would like to view this apartment.'); return { outcome: 'sent', detail: 'confirmed' }; },
    ...overrides.adapter,
  };
  const workflow = new Workflow({ store, adapter, config,
    evaluate: async details => { calls.evaluate++; assert.equal(details.description, 'A balcony.'); return { decision: 'message', reasons: ['Balcony matches'], draft: 'Hello, I would like to view this apartment.' }; },
    notify: async review => { calls.notify++; assert.equal(review.status, 'awaiting_approval'); },
    ...overrides.workflow,
  });
  return { snapshot, config, store, adapter, calls, workflow };
}
function approve(f) {
  const review = f.store.list()[0];
  f.store.approve(review.id, { version: review.version, draftHash: review.draftHash, ...f.workflow.bindings() });
  return review;
}
test('offline five-step path is approval gated, durable and stable across repeated polls', async () => {
  const f = fixture();
  await f.workflow.tick();
  assert.equal(f.calls.send, 0);
  assert.equal(f.calls.evaluate, 1);
  const review = approve(f);
  await f.workflow.tick();
  await f.workflow.tick();
  assert.deepEqual(f.calls, { search: 3, evaluate: 1, notify: 1, send: 1 });
  assert.equal(f.store.get(review.id).status, 'sent');
  assert.equal(f.store.attempts(review.id).length, 1);
  await f.workflow.close();
});
test('failed notifications retry durable draft without another LLM invocation', async () => {
  let notifyCount = 0;
  const f = fixture({ workflow: { notify: async () => { if (++notifyCount === 1) throw new Error('Offline'); } } });
  await f.workflow.poll();
  assert.equal(f.store.list()[0].status, 'awaiting_approval');
  assert.equal(f.store.list()[0].notificationError, 'Offline');
  await f.workflow.poll();
  assert.equal(f.calls.evaluate, 1);
  assert.equal(notifyCount, 2);
  assert.equal(f.store.list()[0].notifiedAt, 100);
  await f.workflow.close();
});
test('LLM dismiss and user dismiss never invoke sender', async () => {
  const f = fixture({ workflow: { evaluate: async () => ({ decision: 'dismiss', reasons: ['Too small'], draft: '' }) } });
  await f.workflow.tick();
  assert.equal(f.store.list()[0].status, 'dismissed');
  assert.equal(f.calls.notify, 0);
  assert.equal(f.calls.send, 0);
  await f.workflow.close();
  const other = fixture();
  await other.workflow.poll();
  const review = approve(other);
  other.store.dismiss(review.id, { version: 1 });
  await other.workflow.sendApproved();
  assert.equal(other.calls.send, 0);
  await other.workflow.close();
});
test('material details or account/config changes fail closed', async () => {
  for (const change of ['details', 'account', 'persona']) {
    const f = fixture();
    await f.workflow.poll();
    const review = approve(f);
    if (change === 'details') f.adapter.details = async () => ({ ...f.snapshot, price: 2000 });
    if (change === 'account') f.config.accountEmail = 'other@example.com';
    if (change === 'persona') f.config.persona = { name: 'Changed' };
    await f.workflow.sendApproved();
    assert.equal(f.calls.send, 0);
    assert.equal(f.store.get(review.id).status, 'failed');
    await f.workflow.close();
  }
});
test('ambiguous remote outcomes and thrown sends never retry', async () => {
  for (const send of [async () => ({ outcome: 'unknown_outcome', detail: 'No confirmation' }), async () => { throw new Error('Browser vanished'); }, async () => undefined]) {
    let count = 0;
    const f = fixture({ adapter: { send: async (...args) => { count++; return send(...args); } } });
    await f.workflow.poll();
    const review = approve(f);
    await f.workflow.sendApproved();
    await f.workflow.tick();
    assert.equal(count, 1);
    assert.equal(f.store.get(review.id).status, 'unknown_outcome');
    await f.workflow.close();
  }
});
test('concurrent ticks share one execution and approval expires immediately before submit', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ adapter: { search: async () => { await gate; return { listings: [], complete: true, pages: 1 }; } } });
  const first = f.workflow.tick();
  const second = f.workflow.tick();
  assert.equal(first, second);
  release();
  await first;
  await f.workflow.close();
  const other = fixture({ adapter: { send: async (_review, { beforeSubmit }) => { other.store.now = () => 2000; await beforeSubmit(); throw new Error('Should never submit'); } } });
  await other.workflow.poll();
  const review = approve(other);
  await other.workflow.sendApproved();
  assert.equal(other.calls.send, 0);
  assert.equal(other.store.get(review.id).status, 'unknown_outcome');
  await other.workflow.close();
});
test('an unrelated search outage does not block an already approved send', async () => {
  const f = fixture();
  await f.workflow.poll();
  const review = approve(f);
  f.adapter.search = async () => { throw new Error('Search unavailable'); };
  await assert.rejects(f.workflow.tick(), /Search unavailable/);
  assert.equal(f.store.get(review.id).status, 'sent');
  assert.equal(f.calls.send, 1);
  assert.equal(f.workflow.status.lastError, 'Search unavailable');
  await f.workflow.close();
});
