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
import { codexLoggedIn, loginWithCodex, listCodexModels, codexAccount } from './codex.js';
import { Telegram } from './telegram.js';
import { Assistant } from './assistant.js';
import { COMMANDS } from './menu.js';
import { BRANDS, ConnectApp } from './connect.js';
import { IS24Session } from './is24-auth.js';
import { ImmomioSession } from './immomio.js';
import { acquireLock } from './lock.js';

// Why Workflow.check() did not search.
const SKIPPED = { paused: 'Paused', quiet: 'Night pause', skipped: 'Backing off IS24' };
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
  if (!runtime.publicUrl) throw new Error('Set DEPANATOR_PUBLIC_URL to the public HTTPS address of this agent; Telegram opens the ImmoScout24 login there');
  assertReconciled(runtime);
  const unlock = acquireLock(runtime.dataDir);
  let workflow, telegram, connectApp, timer;
  let closing = false, closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(timer);
    workflow?.stop();
    closePromise = boundedShutdown(async () => {
      try {
        const results = await Promise.allSettled([telegram?.close(), connectApp?.close(), workflow?.close()]);
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
    const session = new IS24Session(join(runtime.dataDir, 'is24-session.json'));
    // The account email comes from the connected IS24 session; without one, setup asks to connect.
    if (!session.connected && config.accountEmail) settings.set('accountEmail', '');
    const immomioSession = new ImmomioSession(join(runtime.dataDir, 'immomio-session.json'));
    if (!immomioSession.connected && config.immomioEmail) settings.set('immomioEmail', '');
    const adapter = new IS24Adapter(config, { session, immomio: immomioSession });
    const immomioApp = new ConnectApp({ config, session: immomioSession, brand: BRANDS.immomio });
    connectApp = new ConnectApp({ config, session, port: config.port, apps: [immomioApp] });
    await connectApp.listen();
    // Sends the connect button (once per request) and resolves with the connected email, saved as `setting`.
    const connector = (app, setting, name, path) => async intro => {
      const { fresh, done } = app.request();
      if (fresh) {
        console.log(`Waiting for the owner to connect ${name}.`);
        await telegram.send(intro, { reply_markup: { inline_keyboard: [[{ text: `🔗 Connect ${name}`, web_app: { url: `${config.publicUrl}/${path}` } }]] } }).catch(error => console.error(error.message));
      }
      const email = await done;
      if (email !== config[setting]) settings.set(setting, email);
      return email;
    };
    const connect = connector(connectApp, 'accountEmail', 'ImmoScout24', 'connect');
    // Optional: only listings that link to Immomio need it.
    const connectImmomio = connector(immomioApp, 'immomioEmail', 'Immomio', 'immomio');
    workflow = new Workflow({
      store, adapter, config, evaluate: createEvaluator(config),
      notify: review => telegram.notify(review),
      report: review => telegram.notifyOutcome(review),
      withdraw: review => telegram.withdraw(review),
      alert: text => { console.error(text); return telegram.send(text); },
      beforeWork: () => adapter.authenticate(() => connect('🔗 ImmoScout24 ended my login. Please connect your account again; checks are paused until then.')),
      onEvent(event) {
        if (event.type === 'submission') console.log(`${event.review.exposeId}: ${event.review.status} — ${event.review.detail || ''}`);
        if (event.type.endsWith('_error')) console.error(`${event.type}: ${event.detail}`);
      },
    });
    const pairingCode = config.chatId ? null : String(randomInt(100000, 1000000));
    telegram = new Telegram({ config, store, workflow, pairingCode, onPair: chatId => settings.set('chatId', chatId), onError: message => console.error(message) });
    telegram.assistant = new Assistant({
      settings, store, send: (text, extra) => telegram.send(text, extra),
      codex: { loggedIn: () => codexLoggedIn(config), login: options => loginWithCodex(config, options), models: () => listCodexModels(config), account: () => codexAccount(config) },
      is24: { connect: () => connect('🔗 Connect your ImmoScout24 account, so I can read listings and send the applications you approve.') },
      immomio: { connect: () => connectImmomio('🔗 Connect your Immomio account, so I can apply there to the listings you approve that link to Immomio.') },
      workflow, redeliver: review => telegram.notify(review, { again: true }),
      onReady: () => tick(), onError: message => console.error(message),
    });
    await telegram.verify();
    await telegram.api('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
    // Liveness: "healthy until" (epoch seconds), renewed by every finished tick. A stalled tick lets it lapse.
    const heartbeat = () => writeFileSync(join(runtime.dataDir, 'heartbeat'), String(Math.ceil((Date.now() + 2 * config.pollIntervalMs + 600_000) / 1000)));
    // Resolves with the tick's result, or { error } (logged here).
    const tick = () => {
      if (!settings.complete()) return heartbeat(); // Nothing to poll until the chat setup is done.
      return workflow.tick().then(result => {
        if (closing) return result;
        const skipped = Object.keys(SKIPPED).find(reason => result?.[reason]);
        console.log(skipped ? `${SKIPPED[skipped]}; poll skipped.` : `Poll complete. ${result.tracked} listings tracked.`);
        if (result?.warning) console.error(result.warning);
        return result;
      }).catch(error => { console.error(`Agent: ${error.message}`); return { error: error.message }; }).finally(() => { if (!closing) heartbeat(); });
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
    else if (!settings.complete()) telegram.assistant.resume().catch(error => console.error(error.message));
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
