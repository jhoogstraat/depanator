import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.js';
import { IS24Adapter } from './is24.js';

export async function prepareSetup(ask, { fetchImpl = fetch } = {}) {
  const accountEmail = (await ask('IS24 account email: ')).toLowerCase();
  const config = {
    searchUrl: await ask('Filtered IS24 search URL: '), accountEmail,
    persona: { vorname: await ask('First name: '), nachname: await ask('Last name: '), email: accountEmail },
    preferences: await ask('Apartment preferences / hard requirements: '),
    viewerUrl: await ask('Authenticated viewer HTTPS URL (optional): ', false, true),
    autoLogin: true,
  };
  const apiKey = await ask('LLM API key (hidden): ', true);
  const token = await ask('Telegram bot token (hidden): ', true);
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid Telegram bot token format');
  async function telegram(method) {
    let response;
    try { response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error('Cannot connect to Telegram'); }
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error('Telegram rejected the request; check the bot token');
    return data.result;
  }
  if ((await telegram('getWebhookInfo')).url) throw new Error('This bot has a webhook; use a dedicated bot without a webhook');
  await ask('Send /start to your bot in a private chat, then press Enter: ', false, true);
  const chats = new Set((await telegram('getUpdates')).flatMap(update => {
    const message = update.message;
    return message?.chat?.type === 'private' && message.from?.id === message.chat.id ? [String(message.chat.id)] : [];
  }));
  let chatId;
  if (chats.size === 1) {
    const discovered = [...chats][0];
    const accepted = await ask(`Use discovered private Telegram chat ${discovered}? Verify it is yours [y/N]: `, false, true);
    if (accepted.toLowerCase() === 'y') chatId = discovered;
  }
  chatId ||= await ask('Your private numeric Telegram chat ID: ');
  const password = randomBytes(6).toString('hex').slice(0, 8);
  const env = { OPENAI_API_KEY: apiKey, TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId, VNC_PASSWORD: password };
  for (const value of Object.values(env)) if (/[\r\n\0]/.test(value)) throw new Error('Credentials must be single-line values');
  // Reuse the runtime's validation before writing anything to the operator's directory.
  const temporary = mkdtempSync(join(tmpdir(), 'depanator-setup-'));
  try {
    const filename = join(temporary, 'config.json');
    writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
    const validated = loadConfig(filename, { env });
    new IS24Adapter(validated);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return { config, env };
}

async function main() {
  const directory = '/config';
  const names = ['config.json', 'secrets.env', 'depanator.container'];
  if (names.some(name => existsSync(join(directory, name)))) throw new Error('Setup files already exist. Edit them directly; setup never overwrites credentials or configuration.');
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!hidden) process.stdout.write(chunk, encoding); callback(); } });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  async function ask(label, secret = false, optional = false) {
    for (;;) {
      const result = terminal.question(label);
      hidden = secret;
      let value;
      try { value = (await result).trim(); }
      finally { hidden = false; if (secret) process.stdout.write('\n'); }
      if (value || optional) return value;
      console.log('A value is required.');
    }
  }
  try {
    const { config, env } = await prepareSetup(ask);
    const image = process.env.DEPANATOR_IMAGE || 'ghcr.io/jhoogstraat/depanator:latest';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/.test(image)) throw new Error('Invalid container image name');
    const unit = readFileSync(new URL('../deploy/depanator.container', import.meta.url), 'utf8').replace('ghcr.io/jhoogstraat/depanator:latest', image);
    const written = [];
    try {
      for (const [name, contents] of [['config.json', JSON.stringify(config, null, 2) + '\n'], ['secrets.env', Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n'], ['depanator.container', unit]]) {
        const path = join(directory, name);
        writeFileSync(path, contents, { mode: 0o600, flag: 'wx' });
        written.push(path);
      }
    } catch (error) { for (const path of written) rmSync(path); throw error; }
    console.log(`Configuration saved. Viewer password: ${env.VNC_PASSWORD}`);
    console.log(`Login viewer: ${config.viewerUrl || 'configure your authenticated HTTPS viewer route to 127.0.0.1:6080'}`);
  } finally { terminal.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
