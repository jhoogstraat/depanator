import { copyFileSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, assertReconciled } from './config.js';
import { Store } from './store.js';
import { Workflow } from './workflow.js';
import { IS24Adapter } from './is24.js';
import { createEvaluator } from './llm.js';
import { Telegram } from './telegram.js';
import { acquireLock } from './lock.js';

export async function boundedShutdown(action, { timeoutMs = 30000, terminate = () => process.exit(1) } = {}) {
  const timer = setTimeout(() => {
    console.error('Shutdown deadline reached; any interrupted submission will remain uncertain');
    terminate();
  }, timeoutMs);
  try { await action(); } finally { clearTimeout(timer); }
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] || 'start';
  if (command === 'setup') return (await import('./setup.js')).main(args.slice(1));
  if (['help', '--help', '-h'].includes(command)) {
    console.log('Usage: bun src/cli.js init|login|llm-login|start|status [--config path]\nsetup [--output-dir directory]: interactive config and credentials wizard\ninit: create config.json\nllm-login: ChatGPT subscription device-code login\nlogin: manual IS24 login in bundled Chromium; close it when done\nstart: poll listings and handle Telegram approvals\nstatus: inspect the durable review history');
    return;
  }
  const option = args.indexOf('--config');
  const configPath = option >= 0 ? args[option + 1] : 'config.json';
  if (!configPath || args.some((arg, index) => index > 0 && index !== option && index !== option + 1)) throw new Error('Usage: bun src/cli.js init|login|llm-login|start|status [--config path]');
  if (command === 'init') {
    copyFileSync(fileURLToPath(new URL('../config.example.json', import.meta.url)), configPath, constants.COPYFILE_EXCL);
    console.log(`Created ${configPath}. Fill your search URL, preferences, and verified persona before starting.`);
    return;
  }
  if (!['start', 'login', 'llm-login', 'status'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const config = loadConfig(configPath, { loginOnly: command !== 'start' });
  if (command === 'start') assertReconciled(config);
  if (command === 'llm-login') return (await import('./codex.js')).loginWithCodex(config);
  if (command === 'status') {
    const db = new DatabaseSync(join(config.dataDir, 'agent.db'), { readOnly: true });
    try {
      for (const row of db.prepare('SELECT body FROM reviews ORDER BY rowid DESC').all()) {
        const review = JSON.parse(row.body);
        console.log(`${review.status.padEnd(18)} ${review.exposeId} ${review.snapshot.title}\n  ${review.detail || review.notificationError || review.reasons.join('; ')}`);
      }
    } finally { db.close(); }
    return;
  }
  const unlock = acquireLock(config.dataDir);
  let adapter, workflow, telegram, interval;
  let closing = false, closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(interval);
    workflow?.stop();
    adapter?.cancelLogin();
    closePromise = boundedShutdown(async () => {
      try {
        const results = await Promise.allSettled([telegram?.close(), workflow ? workflow.close() : adapter?.close()]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      } finally { unlock(); }
    });
    return closePromise;
  };
  try {
    adapter = new IS24Adapter(config);
    if (command === 'login') {
      console.log(`Log into ${config.accountEmail} manually in the opened Chromium window, then close the browser.`);
      await adapter.login();
      await close();
      return;
    }
    const store = new Store(join(config.dataDir, 'agent.db'));
    workflow = new Workflow({
      store, adapter, config, evaluate: createEvaluator(config),
      notify: review => telegram.notify(review),
      beforeWork: async () => {
        if (!config.autoLogin) return;
        await adapter.authenticate(async () => {
          const message = `IS24 login required for ${config.accountEmail}. Open ${config.viewerUrl || 'your configured browser viewer'}, sign in, then close Chromium. The agent will resume automatically.`;
          console.log(message);
          await telegram.api('sendMessage', { chat_id: config.notification.chatId, text: message }).catch(error => console.error(error.message));
        });
      },
      onEvent(event) {
        if (event.type === 'submission') {
          console.log(`${event.review.exposeId}: ${event.review.status} — ${event.review.detail || ''}`);
          if (!closing) telegram.notifyOutcome(event.review).catch(error => { console.error(error.message); workflow.status.telegramError = error.message; });
        }
        if (event.type.endsWith('_error')) console.error(`${event.type}: ${event.detail}`);
      },
    });
    telegram = new Telegram({ config, store, bindings: () => workflow.bindings(), onApproved: () => workflow.sendApproved(), onError: message => { workflow.status.telegramError = message; console.error(message); } });
    console.log('Agent running. Reviews and approvals arrive in your private Telegram chat. Keep this terminal open.');
    const shutdown = () => { close().then(() => process.exit(process.exitCode || 0), error => { console.error(error.message); process.exit(1); }); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    telegram.start().catch(error => { console.error(error.message); process.exitCode = 1; shutdown(); });
    const tick = () => workflow.tick().then(() => {
      if (closing) return;
      console.log(`Poll complete. ${store.list().length} listings tracked.`);
      if (workflow.status.warning) console.error(workflow.status.warning);
    }).catch(error => { console.error(`Agent: ${error.message}`); });
    interval = setInterval(tick, config.pollIntervalMs);
    tick();
    // Resume persisted approvals independently of a temporary search outage.
    workflow.sendApproved().catch(error => { console.error(`Send queue: ${error.message}`); });
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
