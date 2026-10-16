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
  const viewerUrl = env.DEPANATOR_VIEWER_URL || '';
  if (viewerUrl) {
    const viewer = new URL(viewerUrl);
    if (viewer.protocol !== 'https:' || viewer.username || viewer.password || viewer.search || viewer.hash) throw new Error('DEPANATOR_VIEWER_URL must be HTTPS without credentials/query/fragment');
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  return {
    dataDir,
    browserProfile: resolve(env.DEPANATOR_BROWSER_PROFILE || join(dataDir, 'browser')),
    browser: { executablePath: env.DEPANATOR_BROWSER_EXECUTABLE || null, disableSandbox: env.DEPANATOR_BROWSER_NO_SANDBOX === '1' },
    viewerUrl,
    llm: { codexHome: resolve(env.DEPANATOR_CODEX_HOME || join(dataDir, 'codex')) },
    telegramBotToken: readSecret(env, 'TELEGRAM_BOT_TOKEN'),
  };
}
