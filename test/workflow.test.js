import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';

function fixture(overrides = {}) {
  const snapshot = { expose_id: '123', title: 'Apartment', price: 1000, rooms: 2, area: 60, description: 'A balcony.', amenities: ['Balcony'], url: 'https://www.immobilienscout24.de/expose/123' };
  const config = { searchUrl: 'search', browserProfile: '/tmp/profile', accountEmail: 'person@example.com', persona: {}, preferences: 'balcony', llm: { model: 'fixture', baseUrl: 'fixture' } };
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
  f.store.dispatch(review.id, { type: 'approve', version: review.version, draftHash: review.draftHash, bindings: f.workflow.bindings() });
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
  assert.ok(f.store.get(review.id).claimedAt);
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
  other.workflow.dismiss(review.id, 1);
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
test('concurrent ticks share one execution and a binding change immediately before submit blocks it', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ adapter: { search: async () => { await gate; return { listings: [], complete: true, pages: 1 }; } } });
  const first = f.workflow.tick();
  const second = f.workflow.tick();
  assert.equal(first, second);
  release();
  await first;
  await f.workflow.close();
  const other = fixture({ adapter: { send: async (_review, { beforeSubmit }) => { other.config.persona = { changed: true }; await beforeSubmit(); throw new Error('Should never submit'); } } });
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
  await f.workflow.close();
});

test('shutdown during enrichment prevents evaluation, notification, and remaining batch work', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const f = fixture();
  f.adapter.search = async () => ({ listings: [f.snapshot, { ...f.snapshot, expose_id: '456' }], complete: true });
  f.adapter.details = async () => { entered(); await waiting; return f.snapshot; };
  const poll = f.workflow.poll();
  await started;
  f.workflow.stop();
  assert.equal(f.workflow.controller.signal.aborted, true);
  const stopped = assert.rejects(poll, /Workflow is closed/);
  release(); await stopped;
  assert.equal(f.calls.evaluate, 0); assert.equal(f.calls.notify, 0);
  assert.equal(f.store.list()[1].status, 'discovered');
  await f.workflow.close();
});

test('shutdown guards the final submit seam and prevents further approved submissions', async () => {
  const f = fixture();
  await f.workflow.poll();
  const review = approve(f);
  f.adapter.send = async (_review, { beforeSubmit, assertCanSubmit }) => {
    await beforeSubmit();
    f.workflow.stop();
    assertCanSubmit();
    f.calls.send++;
    return { outcome: 'sent' };
  };
  await f.workflow.sendApproved();
  assert.equal(f.calls.send, 0);
  assert.equal(f.store.get(review.id).status, 'unknown_outcome');
  await assert.rejects(f.workflow.sendApproved(), /closed/);
  await f.workflow.close();
});

test('shutdown drains an already-started send and never claims the next approval', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const f = fixture();
  f.adapter.search = async () => ({ listings: [f.snapshot, { ...f.snapshot, expose_id: '456' }], complete: true });
  f.adapter.details = async snapshot => snapshot;
  await f.workflow.poll();
  const reviews = f.store.list();
  for (const review of reviews) f.store.dispatch(review.id, { type: 'approve', version: review.version, draftHash: review.draftHash, bindings: f.workflow.bindings() });
  const ordered = f.store.list('approved');
  f.adapter.send = async (_review, { beforeSubmit, assertCanSubmit }) => {
    await beforeSubmit(); assertCanSubmit(); f.calls.send++; entered(); await waiting;
    return { outcome: 'unknown_outcome', detail: 'Transport lost after click' };
  };
  const sending = f.workflow.sendApproved();
  await started; f.workflow.stop();
  const stopped = assert.rejects(sending, /closed/);
  release(); await stopped;
  assert.equal(f.calls.send, 1);
  assert.equal(f.store.get(ordered[0].id).status, 'unknown_outcome');
  assert.equal(f.store.get(ordered[1].id).status, 'approved');
  assert.equal(f.store.get(ordered[1].id).claimedAt, undefined);
  await f.workflow.close();
});

test('LLM outage refunds attempts, alerts once after self-healing fails, and reports recovery', async () => {
  const alerts = [];
  let down = true;
  const f = fixture({ workflow: {
    alert: async text => { alerts.push(text); },
    evaluate: async () => { if (down) throw Object.assign(new Error('LLM is unreachable'), { code: 'LLM_UNAVAILABLE' }); return { decision: 'message', reasons: ['Fits'], draft: 'Hello, I would like to view this apartment.' }; },
  } });
  for (let poll = 0; poll < 6; poll++) await f.workflow.poll();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /LLM failed 3 times/);
  const review = f.store.list()[0];
  assert.equal(review.status, 'discovered', 'outages never exhaust the listing');
  assert.equal(review.analysisAttempts, 0);
  down = false;
  await f.workflow.poll();
  assert.equal(f.store.get(review.id).status, 'awaiting_approval');
  assert.match(alerts.at(-1), /LLM recovered/);
  await f.workflow.close();
});

test('IS24 blocks back off exponentially, pause sends, and a gone listing is not an outage', async () => {
  const alerts = [];
  const f = fixture({ workflow: { alert: async text => { alerts.push(text); } } });
  await f.workflow.poll();
  const review = approve(f);
  f.adapter.search = async () => { f.calls.search++; throw Object.assign(new Error('IS24 blocked access to search (HTTP 429)'), { code: 'BLOCKED' }); };
  const searches = () => f.calls.search;
  const before = searches();
  for (let tick = 0; tick < 7; tick++) await f.workflow.tick().catch(() => {});
  // Failures 1, 2, 3 skip 0, 1, then 3 polls: 3 searches across 7 ticks.
  assert.equal(searches() - before, 3);
  assert.equal(f.calls.send, 0, 'no submission while blocked');
  assert.equal(f.store.get(review.id).status, 'approved');
  assert.equal(alerts.length, 1);
  f.adapter.search = async () => ({ listings: [{ ...f.snapshot, expose_id: '456' }], complete: true });
  f.adapter.details = async listing => { if (listing.expose_id === '456') throw Object.assign(new Error('Listing is no longer available'), { code: 'LISTING_GONE' }); return f.snapshot; };
  await f.workflow.tick();
  assert.equal(f.calls.send, 1);
  assert.equal(f.store.get(review.id).status, 'sent');
  assert.match(alerts.at(-1), /IS24 recovered/);
  assert.equal(f.workflow.failures.IS24, 0);
  await f.workflow.close();
});

test('agent revises a draft on request; the old approval is invalidated', async () => {
  const revisions = [];
  const f = fixture({ workflow: { evaluate: async (_snapshot, { revision } = {}) => {
    if (revision) { revisions.push(revision); return { decision: 'message', reasons: ['Revised'], draft: 'Hi! I have a cat and would love to visit.' }; }
    return { decision: 'message', reasons: ['Fits'], draft: 'Hello, I would like to view this apartment.' };
  } } });
  await f.workflow.poll();
  const original = f.store.list()[0];
  const revised = await f.workflow.revise(original.id, 1, 'mention my cat');
  assert.deepEqual(revisions, [{ draft: original.draft, instructions: 'mention my cat' }]);
  assert.equal(revised.version, 2);
  assert.equal(revised.notifiedAt, 100);
  assert.equal(f.calls.notify, 2);
  assert.throws(() => f.workflow.approve(original.id, 1, original.draftHash), /newer draft/);
  await assert.rejects(f.workflow.revise(original.id, 1, 'again'), /already handled/);
  f.store.dispatch(original.id, { type: 'approve', version: 2, draftHash: revised.draftHash, bindings: f.workflow.bindings() });
  await f.workflow.close();
});

test('send outcomes are reported until delivered, including after a failed report', async () => {
  const reported = [];
  let failReport = true;
  const f = fixture({ workflow: { report: async review => { if (failReport) { failReport = false; throw new Error('Telegram down'); } reported.push(review.status); } } });
  await f.workflow.poll();
  const review = approve(f);
  await f.workflow.sendApproved();
  assert.equal(f.store.get(review.id).reportedAt, null);
  await f.workflow.tick();
  assert.deepEqual(reported, ['sent']);
  assert.equal(f.store.get(review.id).reportedAt, 100);
  await f.workflow.tick();
  assert.deepEqual(reported, ['sent'], 'reported once');
  await f.workflow.close();
});

test('a settings change strands no draft: approving explains, editing renews it', async () => {
  const f = fixture({ workflow: { evaluate: async (_snapshot, { revision } = {}) => ({ decision: 'message', reasons: ['Fits'], draft: revision ? 'Renewed draft.' : 'Hello, I would like to view this apartment.' }) } });
  await f.workflow.poll();
  const review = f.store.list()[0];
  f.config.persona = { name: 'Changed' };
  assert.throws(() => f.workflow.approve(review.id, 1, review.draftHash), /Settings changed/);
  const renewed = await f.workflow.revise(review.id, 1, 'same, please');
  assert.equal(f.store.dispatch(review.id, { type: 'approve', version: 2, draftHash: renewed.draftHash, bindings: f.workflow.bindings() }).status, 'approved');
  await f.workflow.close();
});

test('a temporary outage before the click keeps the approval; reports do not wait for IS24', async () => {
  const reported = [];
  let down = true;
  let release;
  const stuck = new Promise(resolve => { release = resolve; });
  const f = fixture({ workflow: { report: async review => { reported.push(review.status); } } });
  await f.workflow.poll();
  const review = approve(f);
  const details = f.adapter.details;
  f.adapter.details = async listing => { if (down) throw new Error('Navigation timeout'); return details(listing); };
  await f.workflow.sendApproved();
  assert.equal(f.store.get(review.id).status, 'approved', 'nothing was clicked, so the approval stays');
  assert.equal(f.calls.send, 0);
  down = false;
  await f.workflow.sendApproved();
  assert.equal(f.store.get(review.id).status, 'sent');
  f.workflow.beforeWork = () => stuck; // e.g. waiting for a manual IS24 login
  reported.length = 0;
  f.store.db.prepare("UPDATE reviews SET body=json_set(body, '$.reportedAt', json('null')) WHERE id=?").run(review.id);
  const ticking = f.workflow.tick().catch(() => {}); // Stays stuck until close.
  await f.workflow.reporting;
  assert.deepEqual(reported, ['sent']);
  release();
  await f.workflow.close();
  await ticking;
});

test('workflow waits for authentication before any action and shutdown cancels that wait', async () => {
  let unblock, actions = 0;
  const waiting = new Promise(resolve => { unblock = resolve; });
  const workflow = new Workflow({ config: {}, adapter: { cancelLogin: () => unblock(), close: async () => {} }, store: { close() {} }, beforeWork: () => waiting });
  const action = workflow.run(async () => { actions++; });
  await Promise.resolve();
  const rejection = assert.rejects(action, /closed/);
  await workflow.close(); await rejection;
  assert.equal(actions, 0);
});

test('auto-send sends confident matches in the same tick and still asks about the rest', async () => {
  const reported = [];
  const f = fixture({ workflow: {
    report: async review => { reported.push(review.approvedBy); },
    evaluate: async listing => ({ decision: 'message', reasons: ['Fits'], draft: 'Hello, I would like to view this apartment.', confident: listing.expose_id !== '456' }),
  } });
  f.adapter.details = async listing => ({ ...f.snapshot, expose_id: listing.expose_id });
  f.config.autoSend = true;
  // The first check finds listings that were online before the agent: never auto-sent, even when confident.
  f.adapter.search = async () => ({ listings: [{ ...f.snapshot, expose_id: '100' }], complete: true, caughtUp: false });
  await f.workflow.tick();
  f.adapter.search = async () => ({ listings: [f.snapshot, { ...f.snapshot, expose_id: '456' }, { ...f.snapshot, expose_id: '100' }], complete: true, caughtUp: true });
  await f.workflow.tick();
  const [baseline, confident, unsure] = f.store.list();
  assert.deepEqual([baseline.status, confident.status, confident.approvedBy, unsure.status], ['awaiting_approval', 'sent', 'auto', 'awaiting_approval']);
  assert.equal(f.calls.notify, 2, 'the baseline and the unsure match ask for approval');
  assert.deepEqual(reported, ['auto']);
  await f.workflow.close();
});
