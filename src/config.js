import { readFileSync, mkdirSync, chmodSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function readSecret(env, name) {
  const file = env[`${name}_FILE`];
  if (file && env[name]) throw new Error(`Set only ${name} or ${name}_FILE`);
  if (!file) return env[name] || '';
  let value;
  try {
    if (statSync(file).size > 16384) throw new Error();
    value = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  } catch { throw new Error(`Cannot read ${name}_FILE`); }
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`${name}_FILE must contain one nonempty line`);
  return value;
}

export function assertReconciled(config) {
  if (config.dataDir && existsSync(resolve(config.dataDir, 'reconciliation-required'))) {
    throw new Error('Restore reconciliation required: verify IS24 history and restored reviews before removing reconciliation-required');
  }
}

// Deployment inputs only. Everything else is configured in the Telegram chat (settings.js).
export function loadRuntime(env = process.env) {
  const dataDir = resolve(env.DEPANATOR_DATA_DIR || '.depanator');
  // Public HTTPS address of this agent's port (reverse proxy or tunnel): Telegram opens the IS24 connect page there.
  const publicUrl = (env.DEPANATOR_PUBLIC_URL || '').replace(/\/+$/, '');
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('DEPANATOR_PUBLIC_URL must be HTTPS without credentials/query/fragment');
  }
  const port = Number(env.DEPANATOR_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DEPANATOR_PORT must be a port number');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  return {
    dataDir,
    publicUrl,
    port,
    llm: { codexHome: resolve(env.DEPANATOR_CODEX_HOME || join(dataDir, 'codex')) },
    telegramBotToken: readSecret(env, 'TELEGRAM_BOT_TOKEN'),
  };
}
