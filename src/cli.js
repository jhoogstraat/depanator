import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadRuntime, assertReconciled } from './config.js';
import { IS24Adapter } from './is24.js';
import { Feeds } from './feed.js';
import { Bot } from './telegram.js';
import { BRANDS, ConnectApp } from './connect.js';
import { Users, userIds } from './users.js';
import { COMMANDS } from './menu.js';
import { acquireLock } from './lock.js';

const USAGE = 'Usage: bun src/cli.js [start|status]\nstart: run the agent; configure it by chatting with your Telegram bot\nstatus: print the review history';

async function boundedShutdown(action, { timeoutMs = 30000, terminate = () => process.exit(1) } = {}) {
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
  if (command === 'status') {
    // A root database: not started since multi-user arrived, so not moved to users/ yet.
    const databases = [join(runtime.dataDir, 'agent.db'), ...userIds(runtime.dataDir).map(id => join(runtime.dataDir, 'users', id, 'agent.db'))].filter(path => existsSync(path));
    if (!databases.length) return console.log('No reviews yet.');
    for (const database of databases) {
      if (databases.length > 1) console.log(`\n${database}`);
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        for (const row of db.prepare('SELECT body FROM reviews ORDER BY rowid DESC').all()) {
          const review = JSON.parse(row.body);
          console.log(`${review.status.padEnd(18)} ${review.exposeId} ${review.snapshot.title}\n  ${review.detail || review.notificationError || review.reasons.join('; ')}`);
        }
      } finally { db.close(); }
    }
    return;
  }
  if (!runtime.telegramBotToken) throw new Error('Set TELEGRAM_BOT_TOKEN to the token of a new bot from @BotFather in Telegram');
  if (!runtime.publicUrl) throw new Error('Set DEPANATOR_PUBLIC_URL to the public HTTPS address of this agent; Telegram opens the ImmoScout24 login there');
  assertReconciled(runtime);
  const unlock = acquireLock(runtime.dataDir);
  let users, bot, connectApp, timer;
  let closing = false, closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(timer);
    users?.stop();
    closePromise = boundedShutdown(async () => {
      try {
        const results = await Promise.allSettled([bot?.close(), connectApp?.close(), users?.close()]);
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
    bot = new Bot({ config: runtime, route: update => users.route(update), onError: message => console.error(message) });
    // Searches and listing reads need no IS24 login, so the shared feeds belong to nobody's account.
    // Half an interval: everyone in a round meets in one result, and the next round (±10%) searches again.
    const feeds = new Feeds(new IS24Adapter({ dataDir: runtime.dataDir }), { ttlMs: () => users.interval() / 2 });
    // ±10% jitter keeps polls from forming an exact pattern. A changed interval applies immediately.
    const schedule = () => {
      clearTimeout(timer);
      if (!closing) timer = setTimeout(() => { round(); schedule(); }, users.interval() * (0.9 + Math.random() * 0.2));
    };
    users = new Users({ runtime, bot, feeds, onInterval: schedule });
    users.load();
    // Only the page itself is served to everybody; signed requests reach that person's own login (forUser).
    connectApp = new ConnectApp({ config: runtime, port: runtime.port, apps: [new ConnectApp({ config: runtime, brand: BRANDS.immomio })], forUser: id => users.get(id)?.connects });
    await connectApp.listen();
    await bot.verify();
    await bot.api('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
    // Liveness: "healthy until" (epoch seconds), renewed by every finished round. A stalled round lets it lapse.
    const heartbeat = () => writeFileSync(join(runtime.dataDir, 'heartbeat'), String(Math.ceil((Date.now() + 2 * users.interval() + 600_000) / 1000)));
    const round = () => users.round().finally(() => { if (!closing) heartbeat(); });
    heartbeat();
    if (!users.size) users.pairingCode = String(randomInt(100000, 1000000));
    bot.start().catch(error => { console.error(error.message); process.exitCode = 1; shutdown(); });
    if (users.pairingCode) console.log(`Open your bot in Telegram and send:  /start ${users.pairingCode}`);
    console.log('Agent running. Configure and approve everything in your private Telegram chat.');
    users.resume();
    schedule();
    round();
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
