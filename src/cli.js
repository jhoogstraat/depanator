import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadRuntime, assertReconciled } from './config.js';
import { Store } from './store.js';
import { Settings } from './settings.js';
import { Workflow } from './workflow.js';
import { IS24Adapter } from './is24.js';
import { createEvaluator } from './llm.js';
import { codexLoggedIn, loginWithCodex } from './codex.js';
import { Telegram } from './telegram.js';
import { Assistant } from './assistant.js';
import { RemoteLogin } from './remote-login.js';
import { acquireLock } from './lock.js';

const USAGE = 'Usage: bun src/cli.js [start|status]\nstart: run the agent; configure it by chatting with your Telegram bot\nstatus: print the review history';

export async function boundedShutdown(action, { timeoutMs = 30000, terminate = () => process.exit(1) } = {}) {
  const timer = setTimeout(() => {
    console.error('Shutdown deadline reached; any interrupted submission will remain uncertain');
    terminate();
  }, timeoutMs);
  try { await action(); } finally { clearTimeout(timer); }
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] || 'start';
  if (['help', '--help', '-h'].includes(command)) return console.log(USAGE);
  if (!['start', 'status'].includes(command) || args.length > 1) throw new Error(USAGE);
  const runtime = loadRuntime();
  const database = join(runtime.dataDir, 'agent.db');
  if (command === 'status') {
    if (!existsSync(database)) return console.log('No reviews yet.');
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      for (const row of db.prepare('SELECT body FROM reviews ORDER BY rowid DESC').all()) {
        const review = JSON.parse(row.body);
        console.log(`${review.status.padEnd(18)} ${review.exposeId} ${review.snapshot.title}\n  ${review.detail || review.notificationError || review.reasons.join('; ')}`);
      }
    } finally { db.close(); }
    return;
  }
  if (!runtime.telegramBotToken) throw new Error('Set TELEGRAM_BOT_TOKEN to the token of a new bot from @BotFather in Telegram');
  assertReconciled(runtime);
  const unlock = acquireLock(runtime.dataDir);
  let adapter, workflow, telegram, remote, timer;
  let closing = false, closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(timer);
    workflow?.stop();
    adapter?.cancelLogin();
    closePromise = boundedShutdown(async () => {
      try {
        const results = await Promise.allSettled([telegram?.close(), remote?.close(), workflow ? workflow.close() : adapter?.close()]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      } finally { unlock(); }
    });
    return closePromise;
  };
  const shutdown = () => { close().then(() => process.exit(process.exitCode || 0), error => { console.error(error.message); process.exit(1); }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    const store = new Store(database);
    const settings = new Settings(store, runtime);
    const config = settings.config;
    adapter = new IS24Adapter(config);
    // With a public URL, the login tab opens inside Telegram (Mini App); otherwise it is a window on this computer.
    if (config.publicUrl) { remote = new RemoteLogin({ config, port: config.port }); await remote.listen(); }
    const loginRequired = async page => {
      const intro = `🔐 IS24 login needed for ${config.accountEmail}.`;
      console.log(`${intro} Waiting for the owner to log in.`);
      // A failed stream must not count as "logged in": then only the tab check or closing it ends the wait.
      const done = remote?.attach(page).catch(error => { console.error(`Login stream: ${error.message}`); return new Promise(() => {}); });
      const message = remote
        ? telegram.send(`${intro}\n\nTap the button, log in (including any 2FA code), then tap “I'm logged in”. I continue automatically.`, { reply_markup: { inline_keyboard: [[{ text: '🔐 Log in to IS24', web_app: { url: `${config.publicUrl}/login` } }]] } })
        : telegram.send(`${intro}\n\nA browser window opened on the computer running the agent. Log in there (including any 2FA code), then close that tab. I continue automatically.`);
      await message.catch(error => console.error(error.message));
      return { done };
    };
    workflow = new Workflow({
      store, adapter, config, evaluate: createEvaluator(config),
      notify: review => telegram.notify(review),
      report: review => telegram.notifyOutcome(review),
      alert: text => { console.error(text); return telegram.send(text); },
      beforeWork: () => adapter.authenticate(loginRequired),
      onEvent(event) {
        if (event.type === 'submission') console.log(`${event.review.exposeId}: ${event.review.status} — ${event.review.detail || ''}`);
        if (event.type.endsWith('_error')) console.error(`${event.type}: ${event.detail}`);
      },
    });
    const pairingCode = config.chatId ? null : String(randomInt(100000, 1000000));
    telegram = new Telegram({ config, store, workflow, pairingCode, onPair: chatId => settings.set('chatId', chatId), onError: message => console.error(message) });
    telegram.assistant = new Assistant({
      settings, store, send: (text, extra) => telegram.send(text, extra),
      codex: { loggedIn: () => codexLoggedIn(config), login: options => loginWithCodex(config, options) },
      is24: { authenticate: () => adapter.authenticate(loginRequired), formOptions: () => adapter.formOptions() },
      onReady: () => tick(), onError: message => console.error(message),
    });
    await telegram.verify();
    // Liveness: "healthy until" (epoch seconds), renewed by every finished tick. A stalled tick lets it lapse.
    const heartbeat = () => writeFileSync(join(runtime.dataDir, 'heartbeat'), String(Math.ceil((Date.now() + 2 * config.pollIntervalMs + 600_000) / 1000)));
    const tick = () => {
      if (!settings.complete()) return heartbeat(); // Nothing to poll until the chat setup is done.
      return workflow.tick().then(result => {
        if (closing) return;
        console.log(result?.skipped ? 'Backing off IS24; poll skipped.' : `Poll complete. ${result.tracked} listings tracked.`);
        if (result?.warning) console.error(result.warning);
      }).catch(error => { console.error(`Agent: ${error.message}`); }).finally(() => { if (!closing) heartbeat(); });
    };
    // ±10% jitter keeps polls from forming an exact pattern. A changed interval applies immediately.
    const schedule = () => {
      clearTimeout(timer);
      if (!closing) timer = setTimeout(() => { tick(); schedule(); }, config.pollIntervalMs * (0.9 + Math.random() * 0.2));
    };
    settings.onChange(key => { if (key === 'pollIntervalMs') schedule(); });
    heartbeat();
    telegram.start().catch(error => { console.error(error.message); process.exitCode = 1; shutdown(); });
    if (pairingCode) console.log(`Open your bot in Telegram and send:  /start ${pairingCode}`);
    else if (!settings.complete()) telegram.assistant.continue().catch(error => console.error(error.message));
    console.log('Agent running. Configure and approve everything in your private Telegram chat.');
    schedule();
    tick();
    // Resume persisted approvals independently of a temporary search outage.
    if (settings.complete()) workflow.sendApproved().catch(error => { console.error(`Send queue: ${error.message}`); });
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
