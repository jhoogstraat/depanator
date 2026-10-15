# Depanator

A local, Telegram-first apartment agent for ImmobilienScout24. It polls a filtered website search URL, extracts listing details, asks an LLM to message or dismiss new listings, drafts applications, and sends only after your explicit approval. There is no web UI.

For container deployment on x86_64 or ARM64, see the [image interface and configuration wizard](deploy/README.md). You choose the runtime, service manager, storage, networking, and remote access controls. The browser viewer is for account login and maintenance; reviews remain entirely in Telegram.

Tap **✏️ Edit** and reply with what to change (for example "shorter" or "mention I can move in on 1 March"); the agent revises the draft and sends it as a new version, which invalidates the old buttons. Facts you state in an edit are treated as verified.

The agent heals itself before asking for help. Search outages and IS24 blocks trigger exponential backoff (up to an hour) and a browser restart; sends pause while IS24 blocks access. LLM outages pause analysis without using up a listing's retries. Telegram alerts you only when a component fails three times in a row, when it recovers, or when a listing is given up after five failed analyses.

Telegram reviews include a linked title, rent/size/room facts, matching reasons, expandable description and amenities, the complete quoted draft, sender account, expiry, and **Approve & send / Edit / Dismiss** buttons. Native Telegram entities preserve literal listing and draft text without interpreting embedded markup. Long messages are split without truncating the draft; controls appear after every part has been delivered.

## Setup

Requires Bun 1.4.3 or newer and a desktop session for the bundled Chromium browser.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run browser:install
bun run init
```

Edit `config.json`: supply your IS24 results URL, account email, verified persona facts, and matching preferences. The example uses Berlin and placeholder identity values; replace them. Only apartment rentals are supported. Unsupported or lossy filters cause an explicit error instead of widening the search. `maxPages` bounds coverage; the terminal reports when that limit is reached.

Create a dedicated bot with [BotFather](https://t.me/BotFather), then send `/start` to it in a private chat. Obtain your positive numeric private chat ID from the bot's [getUpdates response](https://core.telegram.org/bots/api#getupdates), before starting the agent. Use a dedicated bot without an existing webhook or another update-polling process. Group chats are not supported.

Set these environment variables locally; do not commit tokens:

```sh
export OPENAI_API_KEY='your-api-key'
export TELEGRAM_BOT_TOKEN='your-bot-token'
export TELEGRAM_CHAT_ID='your-private-numeric-chat-id'
bun run login
```

Log into the configured account manually in the opened Chromium window, then close the browser. Login uses a dedicated profile, not your system browser. Start the agent:

```sh
bun run start
```

Keep the process running. It polls immediately and then every ten minutes by default. Telegram buttons work while the process is running. Each approval authorizes one exact draft for one listing/account; changed, expired, duplicate, or foreign approvals are rejected. A separate terminal can inspect persistent history:

```sh
bun run status
```

Commands accept `--config path`, for example `bun run start --config apartment.json`. The default data/profile directory is `.depanator/`. Config and data are git-ignored. Runtime keys can use `DEPANATOR_LLM_API_KEY` instead of `OPENAI_API_KEY`; `llm.baseUrl` supports a compatible Chat Completions endpoint with strict JSON-schema output. The default is OpenAI, using [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat). Listing snapshots, preferences, and persona facts are sent to that configured LLM; approval details and drafts are sent to your Telegram bot.

### ChatGPT subscription

The wizard offers `api` or `codex`. For existing configuration, replace the entire `llm` object with `{"backend":"codex"}` and run `bun run llm-login` (accepts `--config path`). The bundled official Codex CLI prints a link and one-time code. Open the link on your phone, sign into ChatGPT, and enter the code. Enable device-code login in ChatGPT security settings if required. This uses your plan's Codex allowance, not unlimited access or API credit. See [OpenAI's authentication guide](https://developers.openai.com/codex/auth/).

No API key is required in Codex mode; failures never fall back to API billing. Authentication persists under `codex` in the data directory; `llm.codexHome` can override that location. Keep it private and persist it. The default model is `gpt-6-luna`; override `llm.model` with a model available to your plan. Unavailable models or expired login leave listings unsent; rerun `llm-login` when needed.

Each review uses an ephemeral, tool-free Codex invocation, a private empty working directory, a restricted environment, and the same JSON schema and draft validation as API mode. No shell, file-edit, browser, web-search, MCP, app, or delegation tools are exposed. The CLI is pinned, and an offline integration test verifies its request contains zero tools. Subscription login is separate from IS24 login; the optional viewer URL is only your operator-configured IS24 browser link.

Puppeteer's browser installer runs explicitly under Bun rather than through a Node lifecycle script. Existing config, Chromium profiles, and SQLite databases need no conversion. Bun's [Node compatibility](https://bun.sh/docs/runtime/nodejs-compat) includes the `node:sqlite` API used here; direct execution with Node 24+ remains a fallback, for example `node src/cli.js start`. Keep one agent process running per data directory.

## Submission and recovery

Stable listing IDs prevent reanalysis and repeat applications after price changes. SQLite stores decisions, exact drafts, approvals, and single submission attempts. Approval expires after 24 hours by default. The sender rechecks the details, signed-in email, form contents, and approval immediately before its single submit action. Captcha solving and automatic resubmission are disabled.

Failed or uncertain submissions never automatically retry. If confirmation is ambiguous or the process stops during submission, inspect your IS24 messages manually before further action. No requeue command is provided. SIGTERM stops starting new work immediately and allows at most 30 seconds to drain before exit 1; interrupted submissions remain uncertain. For private mounted secrets and the mandatory restore reconciliation marker, see the [operational contract](deploy/README.md#mounted-secrets-stopping-and-restores). The application cannot detect historical database rollback; the deployment restore hook must install the marker before resuming. If a hard stop leaves `agent.lock`, confirm no agent or login process is running before removing that file and restarting; normal shutdown removes it. Interrupted or failed analysis retries up to five times per listing, then stops as `analysis_failed`; interrupted submissions remain quarantined. Review statuses and their allowed transitions are defined in `TRANSITIONS` in `src/store.js`. The database schema is versioned; an older agent refuses a newer database.

Present-day IS24 selectors, account indicators, and API compatibility have **not been tested against a live account**. They fail closed when complete details, account identity, or exact form values cannot be verified. A valid runtime account and keys are needed for live operation; offline tests cannot establish live-site compatibility.

## Verification and source

```sh
bun run test
bun run check
```

Tests cover the complete Telegram approval workflow with simulated external services, durable restart behavior, invalid approvals, exact drafts, filter preservation, and actual bundled-Chromium DOM fixtures. Tests do not send real applications or Telegram messages.

The scraper/contactor originate from Homelander commit `b0e7283b540d853311854d5111bffc0254d5ea85`. Its MIT license and local modifications are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The original source analysis is in [docs/homelander-agent-analysis.md](docs/homelander-agent-analysis.md).
