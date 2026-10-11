import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSecret, loadConfig, assertReconciled } from '../src/config.js';
import { boundedShutdown, main } from '../src/cli.js';

test('mounted secrets are read without mutating environment; invalid files fail without leaking values', t => {
  const directory = mkdtempSync(join(tmpdir(), 'depanator-secrets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = join(directory, 'key'); writeFileSync(key, 'private-value\n');
  for (const name of ['OPENAI_API_KEY', 'DEPANATOR_LLM_API_KEY', 'TELEGRAM_BOT_TOKEN', 'VNC_PASSWORD']) {
    const env = { [`${name}_FILE`]: key };
    assert.equal(readSecret(env, name), 'private-value');
    assert.equal(env[name], undefined);
    assert.throws(() => readSecret({ ...env, [name]: 'another-private-value' }, name), /Set only/);
  }
  const input = { accountEmail: 'me@example.com', searchUrl: 'search', persona: { vorname: 'A', nachname: 'B', email: 'me@example.com' }, preferences: 'Balcony', notification: { chatId: '42' } };
  const file = join(directory, 'config.json'); writeFileSync(file, JSON.stringify(input));
  const env = { OPENAI_API_KEY_FILE: key, TELEGRAM_BOT_TOKEN_FILE: key };
  assert.equal(loadConfig(file, { env }).telegramBotToken, 'private-value');
  writeFileSync(key, 'private-value\nextra-secret');
  assert.throws(() => readSecret(env, 'OPENAI_API_KEY'), /must contain one nonempty line/);
  assert.throws(() => readSecret({ OPENAI_API_KEY_FILE: '/missing' }, 'OPENAI_API_KEY'), /^Error: Cannot read OPENAI_API_KEY_FILE$/);
  assert.equal(loadConfig(file, { env, loginOnly: true }).telegramBotToken, '');
});

test('restore marker blocks startup before browser/account/secret-free maintenance work', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'depanator-restore-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { dataDir: directory };
  assertReconciled(config);
  writeFileSync(join(directory, 'reconciliation-required'), 'Restore requires IS24 reconciliation\n');
  assert.throws(() => assertReconciled(config), /Restore reconciliation required/);
  const file = join(directory, 'config.json');
  writeFileSync(file, JSON.stringify({ accountEmail: 'me@example.com', searchUrl: 'search', persona: { vorname: 'A', nachname: 'B', email: 'me@example.com' }, preferences: 'Balcony', llm: { backend: 'codex' }, dataDir: directory }));
  const previous = { ...process.env };
  process.env.DEPANATOR_DATA_DIR = directory;
  process.env.TELEGRAM_BOT_TOKEN = 'fake'; process.env.TELEGRAM_CHAT_ID = '42';
  delete process.env.TELEGRAM_BOT_TOKEN_FILE;
  try { await assert.rejects(main(['start', '--config', file]), /Restore reconciliation required/); }
  finally {
    for (const key of ['DEPANATOR_DATA_DIR', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_BOT_TOKEN_FILE']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test('shutdown deadline forces termination of hung work and clears on successful drain', async () => {
  let complete, terminated = 0;
  const pending = new Promise(resolve => { complete = resolve; });
  await boundedShutdown(() => pending, { timeoutMs: 10, terminate: () => { terminated++; complete(); } });
  assert.equal(terminated, 1);
  await boundedShutdown(async () => {}, { timeoutMs: 10, terminate: () => { terminated++; } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(terminated, 1);
});
