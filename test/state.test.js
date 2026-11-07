import test from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_AFTER, HEALTHY, Health, transition } from '../src/health.js';
import { ConnectApp } from '../src/connect.js';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { coded } from '../src/errors.js';

const blockedError = () => coded('IS24 blocked access (HTTP 429)', 'BLOCKED');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('health: a streak backs off, alerts once, counts its wait down and recovers', () => {
  const health = new Health({ advice: 'Wait.' });
  assert.equal(transition(HEALTHY, { type: 'waited' }), HEALTHY, 'nothing to wait for while healthy');
  assert.equal(health.record({ type: 'succeeded' }, 'IS24'), '');

  const alerts = Array.from({ length: ALERT_AFTER + 1 }, () => health.record({ type: 'failed', error: blockedError(), intervalMs: 60_000 }, 'IS24'));
  assert.deepEqual(alerts.map(Boolean), [false, false, true, false], 'alerted once, on the third failure in a row');
  assert.match(alerts[2], /IS24 failed 3 times in a row[^]*Wait\./);
  assert.deepEqual(health.state, { status: 'failing', failures: 4, wait: 7, blocked: true });

  health.record({ type: 'waited' });
  assert.equal(health.state.wait, 6);
  assert.match(health.record({ type: 'succeeded' }, 'IS24'), /IS24 recovered/);
  assert.equal(health.state, HEALTHY);
  const llm = new Health({});
  llm.record({ type: 'failed', error: new Error('x') }, 'LLM');
  assert.deepEqual([llm.failures, llm.backingOff], [1, false], 'no interval: a streak without backoff');
});

test('connect: form → working → code → working → done, a failure returns to the form, close rejects', async () => {
  const codes = [];
  const session = { login: async ({ askCode }) => { codes.push(await askCode('Your code?')); if (codes.at(-1) !== '123') throw new Error('Wrong code'); return 'a@b.c'; } };
  const app = new ConnectApp({ config: { telegramBotToken: 't' }, session });
  const answer = code => { const { answer } = app.flow; assert.ok(app.go({ type: 'answer' })); answer(code); };
  assert.equal(app.state().step, 'idle');

  const first = app.request();
  assert.equal(first.fresh, true);
  assert.equal(app.request().fresh, false, 'asking again joins the open request');
  assert.ok(app.go({ type: 'submit' }));
  assert.equal(app.go({ type: 'submit' }), false, 'a second submit is ignored');
  app.login('a@b.c', 'pw');
  await tick();
  assert.deepEqual([app.state().step, app.state().message], ['code', 'Your code?']);
  answer('999');
  await tick();
  assert.deepEqual([app.state().step, app.state().message], ['form', 'Wrong code'], 'back to the form with the reason');

  assert.ok(app.go({ type: 'submit' }));
  app.login('a@b.c', 'pw');
  await tick();
  answer('123');
  assert.equal(await first.done, 'a@b.c');
  assert.deepEqual([app.state().step, app.state().message], ['done', 'a@b.c']);

  const second = app.request();
  assert.equal(second.fresh, true, 'done: the next request starts over');
  await app.close();
  await assert.rejects(second.done, /Shutting down/);
  assert.equal(app.state().step, 'idle');
});

test('an approval held back by an IS24 block goes out while searching is paused', async () => {
  let blocked = true;
  const sent = [];
  const adapter = {
    details: async listing => { if (blocked) throw blockedError(); return listing; },
    send: async (review, { beforeSubmit }) => { await beforeSubmit(); sent.push(review.exposeId); return { outcome: 'sent', detail: '' }; },
    search: async () => ({ listings: [] }),
    quiet: () => false,
  };
  const store = new Store(':memory:');
  const workflow = new Workflow({ store, adapter, evaluate: async () => {}, notify: async () => {}, interval: () => 60_000,
    config: { accountEmail: 'a@b.c', persona: {}, paused: true } });
  const [review] = store.discover([{ expose_id: '1', title: 'Flat' }], { fresh: true });
  store.dispatch(review.id, { type: 'start' });
  const draft = store.dispatch(review.id, { type: 'analyzed', snapshot: review.snapshot, result: { decision: 'message', reasons: [], draft: 'Hallo' }, bindings: workflow.bindings() });
  workflow.approve(review.id, draft.version, draft.draftHash);
  await workflow.tick();
  await workflow.tick();
  assert.deepEqual([workflow.health.IS24.blocked, workflow.health.IS24.backingOff, sent], [true, true, []], 'blocked: the send waits');

  blocked = false;
  for (let ticks = 0; ticks < 10 && !sent.length; ticks++) await workflow.tick();
  assert.deepEqual(sent, ['1'], 'sent once the backoff ended, though paused');
  assert.equal(store.get(review.id).status, 'sent');
  assert.equal(workflow.health.IS24.failures, 0, 'the send showed IS24 answers again');
  await workflow.close();
});
