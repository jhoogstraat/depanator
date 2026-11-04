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
import { FormApp } from './forms.js';
import { Users, userIds } from './users.js';
import { COMMANDS } from './menu.js';
import { acquireLock } from './lock.js';

const HOUSEKEEPING_MS = 60_000;
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
  let users, bot, connectApp, feeds, timer;
  let closing = false, closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(timer);
    feeds?.stop();
    users?.stop();
    closePromise = boundedShutdown(async () => {
      try {
        const results = await Promise.allSettled([bot?.close(), connectApp?.close(), users?.close()]);
        feeds?.close(); // After everyone's last read.
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
    // Searches and listing reads need no IS24 login, so the crawlers belong to nobody's account. Each search is
    // crawled on its own schedule into searches.db, and whoever picked it reads what is new right after.
    feeds = new Feeds(new IS24Adapter({ dataDir: runtime.dataDir }), { file: join(runtime.dataDir, 'searches.db'),
      searches: () => users.feedSearches(), onCrawled: key => users.crawled(key), onAlert: (key, text) => users.alert(key, text), onError: message => console.error(message) });
    users = new Users({ runtime, bot, feeds, onCatalog: () => feeds.refresh() });
    users.load();
    // Only the page itself is served to everybody; signed requests reach that person's own login (forUser).
    connectApp = new ConnectApp({ config: runtime, port: runtime.port, apps: [new ConnectApp({ config: runtime, brand: BRANDS.immomio }), new FormApp({ config: runtime })], forUser: id => users.get(id)?.connects });
    await connectApp.listen();
    await bot.verify();
    await bot.api('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
    // Liveness: "healthy until" (epoch seconds): two intervals plus ten minutes after each search's last crawl loop.
    // A crawl that hangs lets it lapse.
    const heartbeat = () => writeFileSync(join(runtime.dataDir, 'heartbeat'), String(Math.ceil(feeds.healthyUntil() / 1000)));
    heartbeat();
    if (!users.size) users.pairingCode = String(randomInt(100000, 1000000));
    bot.start().catch(error => { console.error(error.message); process.exitCode = 1; shutdown(); });
    if (users.pairingCode) console.log(`Open your bot in Telegram and send:  /start ${users.pairingCode}`);
    console.log('Agent running. Configure and approve everything in your private Telegram chat.');
    users.resume();
    feeds.refresh();
    // Housekeeping besides the crawls (outcome reports, approved sends, the morning cleanup) and the heartbeat.
    timer = setInterval(() => { if (!closing) { heartbeat(); users.round(); } }, HOUSEKEEPING_MS);
    users.round();
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
