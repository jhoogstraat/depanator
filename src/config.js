import { readFileSync, mkdirSync, chmodSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

function integer(value, fallback, min, max, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return result;
}

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

export function loadConfig(filename = 'config.json', { env = process.env, loginOnly = false } = {}) {
  const path = resolve(filename);
  const input = JSON.parse(readFileSync(path, 'utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be a JSON object');
  const accountEmail = String(input.accountEmail || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(accountEmail)) throw new Error('Set accountEmail to the IS24 account you will log into');
  const dataDir = resolve(dirname(path), env.DEPANATOR_DATA_DIR || input.dataDir || '.depanator');
  const browserProfile = resolve(dirname(path), env.DEPANATOR_BROWSER_PROFILE || input.browserProfile || `${dataDir}/browser`);
  const config = {
    searchUrl: String(input.searchUrl || ''),
    accountEmail,
    dataDir,
    browserProfile,
    autoLogin: env.DEPANATOR_AUTO_LOGIN === '1' || input.autoLogin === true,
    viewerUrl: String(input.viewerUrl || ''),
    browser: {
      executablePath: env.DEPANATOR_BROWSER_EXECUTABLE || input.browser?.executablePath || null,
      disableSandbox: env.DEPANATOR_BROWSER_NO_SANDBOX === '1' || input.browser?.disableSandbox === true,
    },
    persona: input.persona || {},
    preferences: input.preferences || '',
    maxPages: integer(input.maxPages, 5, 1, 100, 'maxPages'),
    pollIntervalMs: integer(input.pollIntervalMs, 600_000, 30_000, 86_400_000, 'pollIntervalMs'),
    llm: {
      backend: input.llm?.backend || 'api',
      baseUrl: input.llm?.baseUrl || 'https://api.openai.com/v1',
      model: input.llm?.model || (input.llm?.backend === 'codex' ? 'gpt-6-luna' : 'gpt-4.1-mini'),
      codexHome: resolve(dirname(path), input.llm?.codexHome || `${dataDir}/codex`),
    },
    llmApiKey: loginOnly || input.llm?.backend === 'codex' ? '' : readSecret(env, 'DEPANATOR_LLM_API_KEY') || readSecret(env, 'OPENAI_API_KEY'),
    notification: { type: 'telegram', chatId: String(env.TELEGRAM_CHAT_ID || input.notification?.chatId || '') },
    telegramBotToken: loginOnly ? '' : readSecret(env, 'TELEGRAM_BOT_TOKEN'),
  };
  if (!['api', 'codex'].includes(config.llm.backend)) throw new Error('llm.backend must be api or codex');
  if (typeof config.llm.model !== 'string' || !config.llm.model.trim() || (config.llm.backend === 'codex' && !/^[a-zA-Z0-9._-]+$/.test(config.llm.model))) throw new Error('llm.model must be a model name');
  const base = new URL(config.llm.baseUrl);
  if (config.viewerUrl) {
    const viewer = new URL(config.viewerUrl);
    if (viewer.protocol !== 'https:' || viewer.username || viewer.password || viewer.search || viewer.hash) throw new Error('viewerUrl must be HTTPS without credentials/query/fragment');
  }
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) {
    throw new Error('llm.baseUrl must use HTTPS, or HTTP on localhost, without credentials/query/fragment');
  }
  if (!loginOnly) {
    if (!config.searchUrl) throw new Error('Set searchUrl to your filtered IS24 results URL');
    if (typeof config.preferences !== 'string' || !config.preferences.trim()) throw new Error('Set preferences to describe which listings to message or dismiss');
    if (!config.persona || typeof config.persona !== 'object' || Array.isArray(config.persona)) throw new Error('persona must be an object');
    for (const field of ['vorname', 'nachname', 'email']) {
      if (typeof config.persona[field] !== 'string' || !config.persona[field].trim()) throw new Error(`Set persona.${field} to your verified contact details`);
    }
    if (String(config.persona.email).trim().toLowerCase() !== accountEmail) throw new Error('persona.email must match accountEmail');
    if (config.llm.backend === 'api' && !config.llmApiKey) throw new Error('Set OPENAI_API_KEY or DEPANATOR_LLM_API_KEY in the environment');
    if (!config.telegramBotToken || !/^[1-9]\d*$/.test(config.notification.chatId)) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to your private Telegram chat (positive numeric ID)');
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  return config;
}
