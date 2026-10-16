import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { createEvaluator } from '../src/llm.js';
import { Telegram } from '../src/telegram.js';

const fullDraft = `Guten Tag,\n${'Ich interessiere mich für die Wohnung. 🏠 '.repeat(110)}\nMit freundlichen Grüßen\nAlex`;
function callback(data, user = '42', versionChange = false) {
  return { update_id: 1, callback_query: { id: 'callback', data: versionChange ? data.replace(':1:', ':2:') : data, from: { id: user }, message: { chat: { id: '42', type: 'private' } } } };
}
function setup(directory, options = {}) {
  const config = { searchUrl: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?price=-1500', browserProfile: join(directory, 'browser'), accountEmail: 'alex@example.com', persona: { vorname: 'Alex' }, preferences: 'A balcony', llm: { model: 'offline', baseUrl: 'https://llm.invalid/v1' }, llmApiKey: 'never-exposed-secret', telegramBotToken: 'offline-token', notification: { type: 'telegram', chatId: '42' }, dataDir: directory };
  const summaries = [{ expose_id: '111', title: 'Sunny' }, { expose_id: '222', title: 'Basement' }];
  const snapshots = summaries.map(summary => ({ ...summary, price: 1200, area: 60, rooms: 2, address: 'Berlin', url: `https://www.immobilienscout24.de/expose/${summary.expose_id}`, image_url: '', description: summary.expose_id === '111' ? 'Sunny apartment with balcony.' : 'Dark basement, no balcony.', amenities: summary.expose_id === '111' ? ['Balcony'] : [] }));
  const calls = { llm: [], telegram: [], sends: [] };
  const store = new Store(join(directory, 'state.sqlite'), { now: () => 100 });
  const evaluate = createEvaluator(config, { fetchImpl: async (url, request) => {
    assert.equal(url, 'https://llm.invalid/v1/chat/completions');
    const body = JSON.parse(request.body);
    const data = JSON.parse(body.messages[1].content);
    calls.llm.push(data);
    assert.deepEqual(data.listing, snapshots.find(item => item.expose_id === data.listing.expose_id));
    assert.equal(JSON.stringify(body).includes(config.llmApiKey), false);
    const result = data.listing.expose_id === '111' ? { decision: 'message', reasons: ['Balcony matches preferences'], draft: fullDraft } : { decision: 'dismiss', reasons: ['Missing balcony'], draft: '' };
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }) };
  } });
  const adapter = {
    search: async () => ({ listings: summaries, complete: true, pages: 1 }),
    details: async summary => snapshots.find(snapshot => snapshot.expose_id === summary.expose_id),
    send: async (review, { beforeSubmit }) => {
      await beforeSubmit();
      calls.sends.push({ exposeId: review.exposeId, draft: review.draft, accountBinding: review.accountBinding });
      return { outcome: 'sent', detail: 'Fixture confirmation' };
    },
    close: async () => {},
    ...options.adapter,
  };
  let telegram;
  const workflow = new Workflow({ store, adapter, evaluate, notify: review => telegram.notify(review), config });
  telegram = new Telegram({ config, store, workflow, fetchImpl: async (url, request) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(request.body);
    calls.telegram.push({ method, body });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: calls.telegram.length } }) };
  } });
  return { config, calls, store, workflow, telegram, snapshots };
}

test('all real modules: scrape/enrich/evaluate/notify/signed approval/send once through Telegram', async t => {
  assert.ok(fullDraft.length > 3500 && fullDraft.length <= 5000);
  const directory = mkdtempSync(join(tmpdir(), 'depanator-e2e-'));
  const f = setup(directory);
  t.after(async () => { await f.telegram.close(); await f.workflow.close(); rmSync(directory, { recursive: true, force: true }); });
  await f.workflow.tick();
  assert.equal(f.calls.llm.length, 2);
  assert.equal(f.calls.sends.length, 0);
  const reviews = f.store.list();
  const review = reviews.find(item => item.exposeId === '111');
  assert.equal(review.status, 'awaiting_approval');
  assert.equal(review.draft, fullDraft);
  assert.equal(reviews.find(item => item.exposeId === '222').status, 'dismissed');
  assert.equal(JSON.stringify(reviews).includes(f.config.llmApiKey), false);
  const notifications = f.calls.telegram.filter(call => call.method === 'sendMessage').map(call => call.body);
  const buttons = notifications.findIndex(message => message.reply_markup);
  assert.equal(buttons, notifications.length - 1, 'buttons follow every part of the draft');
  const assembled = notifications.flatMap(message => (message.entities || []).filter(entity => entity.type === 'blockquote').map(entity => message.text.slice(entity.offset, entity.offset + entity.length))).join('');
  assert.equal(assembled, review.draft);
  assert.equal(notifications[0].text.includes(f.config.accountEmail), false);
  const approvedData = notifications[buttons].reply_markup.inline_keyboard.at(-1)[0].callback_data;
  for (const update of [callback(approvedData, 'foreign-user'), callback(approvedData, '42', true), callback(approvedData.slice(0, -1) + (approvedData.endsWith('A') ? 'B' : 'A'))]) {
    await f.telegram.handleUpdate(update);
    assert.equal(f.store.get(review.id).status, 'awaiting_approval');
    assert.equal(f.calls.sends.length, 0);
  }
  await f.telegram.handleUpdate(callback(approvedData));
  await f.workflow.queue;
  assert.deepEqual(f.calls.sends, [{ exposeId: '111', draft: fullDraft, accountBinding: review.accountBinding }]);
  assert.equal(f.store.get(review.id).status, 'sent');
  await f.telegram.handleUpdate(callback(approvedData));
  await f.workflow.tick();
  assert.equal(f.calls.sends.length, 1);
  assert.equal(f.calls.llm.length, 2);
  assert.equal(f.store.get(review.id).status, 'sent');
});

test('persisted uncertain submission survives restart; old Telegram actions cannot requeue', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'depanator-restart-e2e-'));
  let f = setup(directory);
  t.after(async () => { await f.telegram.close(); await f.workflow.close(); rmSync(directory, { recursive: true, force: true }); });
  await f.workflow.poll();
  const review = f.store.list().find(item => item.exposeId === '111');
  const signed = f.telegram.callback(review, 'a');
  f.store.dispatch(review.id, { type: 'approve', version: review.version, draftHash: review.draftHash, bindings: f.workflow.bindings() });
  assert.equal(f.store.dispatch(review.id, { type: 'claim', bindings: f.workflow.bindings() }).status, 'submitting');
  // Simulate a process exit after the durable claim, when the remote result is unknowable.
  await f.telegram.close();
  await f.workflow.close();
  f = setup(directory);
  assert.equal(f.store.get(review.id).status, 'unknown_outcome');
  await f.telegram.handleUpdate(callback(signed));
  await f.workflow.tick();
  await f.workflow.queue;
  assert.equal(f.calls.sends.length, 0);
  assert.equal(f.calls.llm.length, 0);
  assert.equal(f.store.get(review.id).status, 'unknown_outcome');
});
