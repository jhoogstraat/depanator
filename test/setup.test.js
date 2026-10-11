import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSetup, writeSetup } from '../src/setup.js';
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IS24Adapter } from '../src/is24.js';
import { Workflow } from '../src/workflow.js';

const searchUrl = 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten';
const inputs = ['me@example.com', searchUrl, 'First', 'Last', 'No swap apartments', 'https://apartments.example.com/vnc.html', 'fake-api-key', '123:fake-token', '', 'y'];
function wizard(values = inputs, updates = [{ message: { chat: { id: 42, type: 'private' }, from: { id: 42 } } }]) {
  const answers = [...values];
  return prepareSetup(async () => answers.shift(), { fetchImpl: async url => ({ ok: true, json: async () => ({ ok: true, result: url.endsWith('getWebhookInfo') ? { url: '' } : updates }) }) });
}

test('setup validates runtime config, discovers private chat, generates viewer password, rejects unsafe inputs', async () => {
  const result = await wizard();
  assert.equal(result.config.autoLogin, true);
  assert.equal(result.config.persona.email, result.config.accountEmail);
  assert.equal(result.env.TELEGRAM_CHAT_ID, '42');
  assert.match(result.env.VNC_PASSWORD, /^[a-f0-9]{8}$/);
  assert.equal(JSON.stringify(result.config).includes('fake-api-key'), false);
  const unsafe = [...inputs]; unsafe[6] = 'key\nINJECTED=1';
  await assert.rejects(wizard(unsafe), /single-line/);
  const widened = [...inputs]; widened[1] += '?furnished=true';
  await assert.rejects(wizard(widened));
  const insecure = [...inputs]; insecure[5] = 'http://apartments.example.com';
  await assert.rejects(wizard(insecure), /HTTPS/);
  await assert.rejects(wizard([...inputs.slice(0, 9), '-42'], []), /private Telegram chat/);
});

test('authentication waits for manual login, verifies identity again, and propagates site failure', async () => {
  const adapter = new IS24Adapter({ searchUrl, maxPages: 5, accountEmail: 'me@example.com' });
  let authenticated = false, prompts = 0, logins = 0;
  const page = { goto: async () => ({ ok: () => true }), url: () => 'https://www.immobilienscout24.de/', evaluate: async () => authenticated ? 'me@example.com' : null };
  adapter.ensureBrowser = async () => page;
  adapter.login = async () => { logins++; authenticated = true; };
  await adapter.authenticate(async () => { prompts++; });
  assert.equal(prompts, 1); assert.equal(logins, 1);
  await adapter.authenticate(async () => { throw new Error('Unexpected prompt'); });
  page.goto = async () => { throw new Error('offline'); };
  await assert.rejects(adapter.authenticate(async () => { prompts++; }), /offline/);
  assert.equal(prompts, 1);
});

test('manual login cancellation cannot spawn a browser after shutdown', async () => {
  let spawned = false;
  const adapter = new IS24Adapter({ searchUrl, maxPages: 5 }, { spawn: () => { spawned = true; } });
  adapter.browser = { close: async () => { adapter.cancelLogin(); } };
  await assert.rejects(adapter.login(), /cancelled/);
  assert.equal(spawned, false);
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

test('wizard output uses only the selected directory, protects secrets, and never overwrites existing config', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'depanator-output-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = await wizard();
  writeSetup(directory, result);
  assert.deepEqual(readdirSync(directory).sort(), ['config.json', 'secrets.env']);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')), result.config);
  assert.equal(statSync(join(directory, 'secrets.env')).mode & 0o777, 0o600);
  const before = readFileSync(join(directory, 'config.json'), 'utf8');
  assert.throws(() => writeSetup(directory, { ...result, config: { changed: true } }), /EEXIST/);
  assert.equal(readFileSync(join(directory, 'config.json'), 'utf8'), before);
});
