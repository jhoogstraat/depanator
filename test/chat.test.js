import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Settings } from '../src/settings.js';
import { Telegram } from '../src/telegram.js';
import { Assistant } from '../src/assistant.js';

const searchUrl = 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?price=-1500';
const typed = { searchUrl, preferences: 'Balcony, no swap flats', 'persona.vorname': 'Alex', 'persona.nachname': 'Doe' };
const until = async condition => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(condition(), 'timed out'); };

function chat(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'depanator-chat-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new Store(':memory:');
  const settings = new Settings(store, { dataDir, telegramBotToken: 'secret', publicUrl: 'https://agent.example', llm: { codexHome: join(dataDir, 'codex') } });
  const sent = [];
  const events = { ready: 0, logins: 0 };
  const telegram = new Telegram({ config: settings.config, store, workflow: {}, pairingCode: '123456', onPair: chatId => settings.set('chatId', chatId),
    fetchImpl: async (url, request) => {
      sent.push({ method: url.split('/').at(-1), body: JSON.parse(request.body) });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
    } });
  telegram.assistant = new Assistant({ settings, store, send: (text, extra) => telegram.send(text, extra), onReady: () => { events.ready++; },
    codex: { loggedIn: async () => false, login: async ({ onCode }) => { await onCode({ url: 'https://auth.openai.com/codex/device', code: 'AB12-CD34' }); } },
    is24: { connect: async () => { events.logins++; settings.set('accountEmail', 'me@example.com'); return 'me@example.com'; } } });
  const message = (text, from = 42) => telegram.handleUpdate({ message: { text, chat: { id: from, type: 'private' }, from: { id: from } } });
  const tap = (data, from = 42) => telegram.handleUpdate({ callback_query: { id: 'q', data, from: { id: from }, message: { message_id: 1, chat: { id: from, type: 'private' } } } });
  const texts = () => sent.filter(call => call.method === 'sendMessage').map(call => call.body.text);
  // The callback_data of the button labelled `label` (or the n-th button) on the newest keyboard.
  const button = which => {
    const buttons = sent.findLast(call => call.body.reply_markup?.inline_keyboard?.length).body.reply_markup.inline_keyboard.flat();
    return (typeof which === 'number' ? buttons[which] : buttons.find(entry => entry.text === which)).callback_data;
  };
  return { store, settings, telegram, sent, events, message, tap, texts, button };
}

test('pairing, then a guided setup that resumes from stored answers and validates each one', async t => {
  const c = chat(t);
  await c.message('/start 000000', 777);
  assert.equal(c.settings.config.chatId, '', 'a wrong code pairs nobody');
  await c.message('/start 123456');
  assert.equal(c.settings.config.chatId, '42');
  await until(() => c.texts().some(text => text.includes('Open immobilienscout24.de')));
  assert.ok(c.texts().some(text => text.includes('AB12-CD34')), 'ChatGPT device code relayed');
  assert.ok(c.texts().some(text => text.includes('Connected to ImmoScout24 as me@example.com')), 'IS24 connected before the questions');
  await c.message('/start 123456', 777);
  assert.equal(c.settings.config.chatId, '42', 'pairing happens once');

  await c.message('https://www.immobilienscout24.de/Suche/de/berlin/berlin/haus-kaufen');
  assert.match(c.texts().at(-1), /Open immobilienscout24\.de/, 'an unsupported search is asked again');
  for (let step = 0; step < 40 && !c.settings.complete(); step++) {
    const field = c.settings.next();
    if (!field || field.key === 'is24') { await until(() => c.settings.next()?.key !== 'is24'); continue; }
    if (typed[field.key]) await c.message(typed[field.key]);
    else if (field.key === 'persona.about') await c.tap(c.button('Use IS24 Selbstauskunft'));
    else if (c.settings.choices(field.key).length) await c.tap(c.button(field.key === 'pollIntervalMs' ? 1 : 0));
    else await c.tap(c.button('Skip'));
  }
  await until(() => c.events.ready === 1);
  assert.equal(c.events.logins, 1);
  assert.deepEqual(c.settings.config.persona, { anrede: 'FEMALE', vorname: 'Alex', nachname: 'Doe', sendProfile: true, email: 'me@example.com' });
  assert.ok(!c.texts().some(text => text.includes('also include your IS24 Selbstauskunft')), 'the shortcut answers the attach question too');
  assert.deepEqual([c.settings.config.accountEmail, c.settings.config.pollIntervalMs, c.settings.config.autoSend], ['me@example.com', 120_000, false]);

  await c.message('/interval');
  const oneMinute = c.button(0);
  await c.tap(oneMinute, 777);
  assert.equal(c.settings.config.pollIntervalMs, 120_000, 'strangers cannot press buttons');
  await c.tap(oneMinute);
  assert.equal(c.settings.config.pollIntervalMs, 60_000);
  await c.tap(oneMinute.replace(/:\w{4}$/, ':xxxx'));
  assert.deepEqual([c.sent.at(-1).method, c.sent.at(-1).body.text], ['answerCallbackQuery', 'These buttons are outdated; use /settings.']);
  await c.message('https://www.immobilienscout24.de/Suche/de/berlin/berlin/haus-kaufen');
  assert.match(c.texts().at(-1), /\/settings/, 'free text after setup changes nothing');
  assert.equal(c.settings.config.searchUrl, searchUrl);
  assert.equal(new Settings(c.store, { llm: {} }).complete(), true, 'stored answers survive a restart');

  // Without a connected IS24 account, checks pause and setup asks to connect again.
  c.settings.set('accountEmail', '');
  assert.equal(c.settings.complete(), false);
  assert.equal(c.settings.next().key, 'is24');
});

test('settings reject a search that would widen and keep the previous value', t => {
  const c = chat(t);
  c.settings.set('searchUrl', searchUrl);
  assert.throws(() => c.settings.set('searchUrl', `${searchUrl}&pets-allowed=true`), /Unsupported IS24 search filters/);
  assert.throws(() => c.settings.set('pollIntervalMs', 1000), /pick one of the buttons/);
  assert.equal(c.settings.config.searchUrl, searchUrl);
});

test('a restart does not repeat a setup question that is still open in the chat', async t => {
  const c = chat(t);
  c.settings.set('chatId', '42');
  c.settings.set('accountEmail', 'me@example.com');
  const assistant = new Assistant({ settings: c.settings, store: c.store, send: (text, extra) => c.telegram.send(text, extra), codex: { loggedIn: async () => true } });
  await assistant.resume();
  assert.equal(c.texts().length, 0);
  await assistant.command('/setup');
  assert.match(c.texts().at(-1), /Open immobilienscout24\.de/, '/setup asks it again');
});

test('menu: status with search now and pause, criteria, model then thinking, writing style', async t => {
  const c = chat(t);
  for (const [key, value] of Object.entries({ chatId: '42', accountEmail: 'me@example.com', ...typed, 'persona.anrede': 'MALE', 'persona.telefon': '', 'persona.strasse': '', 'persona.hausnummer': '', 'persona.plz': '', 'persona.ort': '', 'persona.about': '', 'persona.sendProfile': false, pollIntervalMs: 120_000 })) c.settings.set(key, value);
  assert.equal(c.settings.complete(), true);
  const checks = [];
  Object.assign(c.telegram.assistant, {
    ready: true, workflow: { lastPollAt: null, failures: { IS24: 0, LLM: 2 }, backoff: { blocked: false } },
    check: async () => { checks.push(c.settings.config.paused); return { tracked: 0 }; },
  });
  c.telegram.assistant.codex.models = async () => [{ id: 'gpt-a', name: 'GPT-A', thinking: ['low', 'medium', 'high'], defaultThinking: 'medium' }, { id: 'gpt-b', name: 'GPT-B', thinking: ['low'], defaultThinking: 'low' }];
  const last = method => c.sent.findLast(call => call.method === method).body;

  await c.message('/status');
  assert.match(last('sendMessage').text, /🟢 Searching<\/b> every 2 min[\s\S]*ChatGPT: ⚠️ 2 failures in a row[\s\S]*Waiting for you: <b>0<\/b>/);
  assert.equal(last('sendMessage').parse_mode, 'HTML');
  await c.tap('x:pause');
  assert.equal(c.settings.config.paused, true);
  assert.match(last('editMessageText').text, /⏸ Paused/, 'the status message updates in place');
  await c.tap('x:check');
  await until(() => c.texts().at(-1) === '🔎 Done: no new listings.');
  assert.deepEqual(checks, [true], 'search now works while paused');
  await c.message('/pause');
  assert.equal(c.settings.config.paused, false, '/pause toggles');

  await c.message('/criteria');
  assert.match(last('sendMessage').text, /1\. Balcony, no swap flats/);
  await c.tap('x:ca');
  await c.message('No ground floor');
  assert.equal(c.settings.config.preferences, 'Balcony, no swap flats\nNo ground floor');
  await c.tap(c.button('🗑 1'));
  assert.equal(c.settings.config.preferences, 'No ground floor');
  assert.match(last('editMessageText').text, /1\. No ground floor/);

  await c.message('/model');
  await c.tap(c.button('GPT-A'));
  const thinking = last('editMessageText').reply_markup.inline_keyboard.flat();
  assert.deepEqual(thinking.map(button => button.text), ['low', 'medium (default)', 'high'], 'step 2 offers that model\'s levels');
  await c.tap(thinking[2].callback_data);
  assert.deepEqual([c.settings.config.llm.model, c.settings.config.llm.thinking], ['gpt-a', 'high']);
  await c.tap(thinking[1].callback_data);
  assert.equal(c.settings.config.llm.thinking, '', 'the default level is stored as the model default');

  await c.tap('k:style');
  await c.message('Formal and short.');
  assert.equal(c.settings.config.style, 'Formal and short.');
  await c.message('/prompt');
  assert.match(last('sendMessage').text, /Your writing style[\s\S]*Formal and short\.[\s\S]*No ground floor/);
  assert.doesNotMatch(last('sendMessage').text, /Built-in rules/);
  const dismissed = [];
  c.telegram.assistant.workflow.dismiss = id => { dismissed.push(id); c.store.dispatch(id, { type: 'dismiss', version: 1 }); };
  const [one, two] = c.store.discover([{ expose_id: '1', title: 'A' }, { expose_id: '2', title: 'B' }]);
  for (const review of [one, two]) c.store.dispatch(review.id, { type: 'start' }) && c.store.dispatch(review.id, { type: 'analyzed', snapshot: { expose_id: review.exposeId, title: 'A' }, result: { decision: 'message', reasons: ['Fits'], draft: 'Hallo' }, bindings: { accountBinding: 'a', configHash: 'c' } });
  await c.tap('x:waiting');
  await c.tap(c.button('🧹 Clear all 2'));
  assert.equal(dismissed.length, 0, 'clearing asks once more');
  await c.tap(c.button('🧹 Yes, clear all 2'));
  assert.deepEqual([dismissed.length, c.store.list('awaiting_approval').length], [2, 0]);
  assert.match(last('editMessageText').text, /Cleared 2 waiting listings/);
  await c.message('/help');
  assert.match(c.texts().at(-1), /menu/);
});
