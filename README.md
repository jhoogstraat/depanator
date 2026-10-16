# Depanator

A local, Telegram-first apartment agent for ImmobilienScout24. It polls a filtered website search URL, extracts listing details, asks ChatGPT to message or dismiss each new listing, drafts the application, and sends it once you approve (or right away for clear matches, if you turn on auto-send). Setup and approvals happen in Telegram; there is no web UI.

For container deployment on x86_64 or ARM64, see [deploy/README.md](deploy/README.md). The browser viewer is only for logging in to IS24; everything else happens in Telegram.

## Setup

Everything is configured by chatting with your Telegram bot. Outside the chat you only provide a bot token (and, for the container, a viewer password).

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token it gives you. Use a new bot just for this.
2. Start the agent with that token:

   ```sh
   bun install --frozen-lockfile --ignore-scripts
   bun run browser:install
   TELEGRAM_BOT_TOKEN='your-bot-token' bun run start
   ```

   For the container, see [deploy/README.md](deploy/README.md).
3. The log shows a line like `Open your bot in Telegram and send:  /start 482913`. Send exactly that to your bot. Bots are public, so this one-time code is how the bot knows the chat is yours; from then on it only answers you.
4. The bot guides you through the rest, in about five minutes:
   - **ChatGPT:** it sends a link and a code; open the link on your phone, sign in, enter the code. Depanator uses your ChatGPT subscription (Codex allowance), never paid API credit.
   - **Search:** set your filters on immobilienscout24.de and paste the results page address. Only apartment rentals are supported; a filter that cannot be applied exactly is rejected rather than silently widening the search.
   - **What you look for**, your **name** and optional contact details (phone, address).
   - **IS24 login:** when asked, open the browser viewer, log in to ImmobilienScout24, and close the window. The bot then reads the real contact form and offers its options (salutation, income, move-in, ...) as buttons, so your answers always match what IS24 accepts.
   - **How often to check** and whether to **auto-send** clear matches.

The answers are stored in the data directory and survive restarts; an interrupted setup continues where it stopped. Afterwards:

| Command | |
| --- | --- |
| `/settings` | See every setting and tap one to change it |
| `/interval` | How often to check for new listings (1–30 minutes; default 2) |
| `/autosend` | Send clear matches without asking you first |
| `/status` | Counts of reviewed, sent and dismissed listings |
| `/login` | Reconnect your ChatGPT subscription |

### Being early

Results are read newest first, and each check stops once a page ends with a listing it already knows, so a routine check is a single request and short intervals stay cheap. Checks are spread by ±10% so they do not form an exact pattern. The very first check reviews all current results (up to 5 pages, about 100 listings), so expect a burst of messages. With **auto-send** on, a newly published listing that clearly meets every requirement is sent in the same check, usually a minute or two after it is found; you get the listing and the sent message afterwards. Anything uncertain still waits for your tap, and so does everything the first check (or the first check after you change the search) finds, since those listings were already online. Listings marked 🔒 Suchen+ can only be contacted with that IS24 subscription.

### Reviews

Each new match arrives as one message: title, rent/size/rooms, photo, expandable details, the complete draft, and **Send / Edit / Dismiss**. Tap **✏️ Edit** and reply with what to change (for example "shorter" or "mention I can move in on 1 March"); the revised draft arrives as a new version and the old buttons stop working. Facts you state in an edit are treated as verified. Each approval authorizes one exact draft for one listing and account; every send outcome (sent, not sent, or uncertain) is reported, also after a restart. Changing your search, preferences, or contact details invalidates waiting drafts; tap ✏️ Edit on one to renew it, or Dismiss it.

The agent heals itself before asking for help. Search outages and IS24 blocks trigger exponential backoff (up to an hour) and a browser restart; sends pause while IS24 blocks access. ChatGPT outages pause analysis without using up a listing's retries. Telegram alerts you only when a component fails three times in a row, when it recovers, or when a listing is given up after five failed analyses.

Each review runs the pinned official Codex CLI ephemerally with no tools (no shell, files, browser, web search or MCP), a private empty working directory, and a restricted environment; its output is validated against a strict schema. Listing details, your preferences and contact facts go to ChatGPT; drafts and listing details go to your Telegram bot. `bun run status` prints the review history. Keep one agent per data directory (default `.depanator/`).

## Submission and recovery

Stable listing IDs prevent reanalysis and repeat applications after price changes. SQLite stores decisions, exact drafts, approvals, and single submission attempts. The sender rechecks the details, signed-in email, form contents, and approval immediately before its single submit action. Captcha solving and automatic resubmission are disabled.

If IS24 is unreachable or blocking before the form is touched, the approval stays and is sent on a later poll. Failed submissions save a screenshot under `screenshots` in the data directory (newest 20 kept; it shows your filled form, so keep it private). Failed or uncertain submissions never automatically retry. If confirmation is ambiguous or the process stops during submission, inspect your IS24 messages manually before further action. No requeue command is provided. SIGTERM stops starting new work immediately and allows at most 30 seconds to drain before exit 1; interrupted submissions remain uncertain. For private mounted secrets and the mandatory restore reconciliation marker, see the [operational contract](deploy/README.md#mounted-secrets-stopping-and-restores). The application cannot detect historical database rollback; the deployment restore hook must install the marker before resuming. If a hard stop leaves `agent.lock`, confirm no agent is running before removing that file and restarting; normal shutdown removes it. Interrupted or failed analysis retries up to five times per listing, then stops as `analysis_failed`; interrupted submissions remain quarantined. The complete review state machine (every status and the events each accepts) is `MACHINE` in `src/review.js`. The database schema is versioned; an older agent refuses a newer database.

Present-day IS24 selectors, account indicators, and API compatibility have **not been tested against a live account**. They fail closed when complete details, account identity, or exact form values cannot be verified. A real IS24 account and ChatGPT login are needed for live operation; offline tests cannot establish live-site compatibility.

## Verification and source

```sh
bun run test
bun run check
```

Tests cover the guided Telegram setup, the complete approval workflow with simulated external services, durable restart behavior, invalid approvals, exact drafts, filter preservation, and actual bundled-Chromium DOM fixtures. Tests do not send real applications or Telegram messages.

The scraper/contactor originate from Homelander commit `b0e7283b540d853311854d5111bffc0254d5ea85`. Its MIT license and local modifications are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The original source analysis is in [docs/homelander-agent-analysis.md](docs/homelander-agent-analysis.md).
