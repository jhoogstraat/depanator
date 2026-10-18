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
    else if (c.settings.choices(field.key).length) await c.tap(c.button(field.key === 'pollIntervalMs' ? 1 : 0));
    else await c.tap(c.button('Skip'));
  }
  await until(() => c.events.ready === 1);
  assert.equal(c.events.logins, 1);
  assert.deepEqual(c.settings.config.persona, { anrede: 'FEMALE', vorname: 'Alex', nachname: 'Doe', email: 'me@example.com' });
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
