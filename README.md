# Depanator

A Telegram-first apartment agent for ImmobilienScout24. It polls a filtered search through the IS24 app's API, reads listing details, asks ChatGPT to message or dismiss each new listing, drafts the application, and sends it once you approve (or right away for clear matches, if you turn on auto-send). Setup and approvals happen in Telegram; there is no web UI.

For container deployment on x86_64 or ARM64, see [deploy/README.md](deploy/README.md). Everything, including connecting your IS24 account, happens in Telegram. No browser is involved.

Dismiss deletes the listing's Telegram message, including every part of a split draft, when Telegram permits deletion. For reviews sent before message tracking was added, only the tapped message can be removed.

## Setup

Everything is configured by chatting with your Telegram bot. Outside the chat you only provide a bot token and a public HTTPS address of the agent, where Telegram opens the "Connect ImmoScout24" page.

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token it gives you. Use a new bot just for this.
2. Start the agent with that token:

   ```sh
   bun install --frozen-lockfile --ignore-scripts
   TELEGRAM_BOT_TOKEN='your-bot-token' DEPANATOR_PUBLIC_URL='https://your-agent.example' bun run start
   ```

   `DEPANATOR_PUBLIC_URL` must reach port 8080 of the agent over HTTPS (reverse proxy or tunnel, for example `cloudflared tunnel --url http://localhost:8080`). For the container, see [deploy/README.md](deploy/README.md).
3. The log shows a line like `Open your bot in Telegram and send:  /start 482913`. Send exactly that to your bot. Bots are public, so this one-time code is how the bot knows the chat is yours; from then on it only answers you.
4. The bot guides you through the rest, in about five minutes:
   - **ChatGPT:** it sends a link and a code; open the link on your phone, sign in, enter the code. Depanator uses your ChatGPT subscription (Codex allowance), never paid API credit.
   - **ImmoScout24:** tap **🔗 Connect ImmoScout24** and enter your IS24 email and password (and a security code, if IS24 asks). They go straight to IS24's login service, the same one the IS24 app uses, and are never stored; the agent keeps only IS24's renewable login key (`is24-session.json` in the data directory). Only your Telegram account can open the page.
   - **Search:** set your filters on immobilienscout24.de and paste the results page address. Only apartment rentals are supported; a filter that cannot be applied exactly is rejected rather than silently widening the search.
   - **What you look for**, your **salutation**, **name**, optional contact details (phone, address), and optionally what landlords should know about you (household, job, income, move-in date, pets, documents). Applications state only what you write, plus your ImmoScout24 tenant profile if you choose to attach it.
   - **How often to check**. You approve every application at first; once you trust the drafts, `/autosend` sends clear matches without asking.

The answers are stored in the data directory and survive restarts; an interrupted setup continues where it stopped. Afterwards:

The bot's menu (☰ next to the message field):

| Command | |
| --- | --- |
| `/status` | Overview: searching or paused, last check, ImmoScout24 and ChatGPT health, listing counts. Buttons: ⏸ Pause / ▶️ Resume, 📬 Waiting (show a listing again), 📨 Sent, and 🔍 Search, ⏱ interval and 🌙 Night pause to change those |
| `/pause` | Pause or resume searching. While paused, waiting drafts and approved sends still work |
| `/criteria` | What a listing must have. ChatGPT skips clear mismatches; add, remove or rewrite criteria |
| `/prompt` | Everything ChatGPT gets for each listing (writing style, criteria, your details); set your writing style |
| `/model` | Pick a ChatGPT model from your plan, then its thinking level |
| `/autosend` | Send clear matches without asking you first |
| `/connect` | Reconnect your ImmoScout24 account (also asked automatically when IS24 ends the login) |
| `/login` | Reconnect your ChatGPT subscription |

### Being early

Each check reads the first page of results, sorted newest first (the 20 newest listings), so it is a single request and short intervals stay cheap. Checks are spread by ±10% so they do not form an exact pattern. At night (22:00–07:00 German time by default; change it with 🌙 Night on `/status`) the agent does not search, since hardly anyone publishes listings then. The first check after starting, resuming, or changing the search only notes the listings already online, without reviewing or messaging them; you hear about listings published after that. With **auto-send** on, a newly published listing that clearly meets every requirement is sent in the same check, usually a minute or two after it is found; you get the listing and the sent message afterwards. Anything uncertain still waits for your tap. Listings marked 🔒 Suchen+ can only be contacted with that IS24 subscription.

### Reviews

Each new match arrives as one message: title, rent/size/rooms, photo, expandable details, the complete draft, and **Send / Edit / Dismiss**. Tap **✏️ Edit** and reply with what to change (for example "shorter" or "mention I can move in on 1 March"); the revised draft arrives as a new version and the old buttons stop working. Facts you state in an edit are treated as verified. Each approval authorizes one exact draft for one listing and account; every send outcome (sent, not sent, or uncertain) is reported, also after a restart. Changing your search or contact details invalidates waiting drafts (criteria, writing style and model only affect new drafts); tap ✏️ Edit on one to renew it, or Dismiss it.

The agent heals itself before asking for help. Search outages and IS24 blocks trigger exponential backoff (up to an hour); sends pause while IS24 blocks access. ChatGPT outages pause analysis without using up a listing's retries. Telegram alerts you only when a component fails three times in a row, when it recovers, or when a listing is given up after five failed analyses.

Each review runs the pinned official Codex CLI ephemerally with no tools (no shell, files, browsers, web search or MCP), a private empty working directory, and a restricted environment; its output is validated against a strict schema. Listing details, your preferences and contact facts go to ChatGPT; drafts and listing details go to your Telegram bot. `bun run status` prints the review history. Keep one agent per data directory (default `.depanator/`).

## Submission and recovery

Stable listing IDs prevent reanalysis and repeat applications after price changes. SQLite stores decisions, exact drafts, approvals, and single submission attempts. Immediately before its single contact request the sender rechecks the listing details, the connected account, and the approval. The request contains exactly the approved draft and your contact details. Fields a listing requires that the agent has no documented format for (move-in date, income, ...) are never guessed: such a listing fails before anything is sent, and you apply on IS24 yourself.

If IS24 is unreachable or blocking before the request, the approval stays and is sent on a later poll. A rejected request is reported as not sent; a lost answer or an IS24 server error is reported as uncertain, because the request may have arrived. Failed or uncertain submissions never automatically retry. If the outcome is uncertain or the process stops during submission, check your IS24 messages before further action. No requeue command is provided. SIGTERM stops starting new work immediately and allows at most 30 seconds to drain before exit 1; interrupted submissions remain uncertain. For private mounted secrets and the mandatory restore reconciliation marker, see the [operational contract](deploy/README.md#mounted-secrets-stopping-and-restores). The application cannot detect historical database rollback; the deployment restore hook must install the marker before resuming. If a hard stop leaves `agent.lock`, confirm no agent is running before removing that file and restarting; normal shutdown removes it. Interrupted or failed analysis retries up to five times per listing, then stops as `analysis_failed`; interrupted submissions remain quarantined. The complete review state machine (every status and the events each accepts) is `MACHINE` in `src/review.js`. The database schema is versioned; an older agent refuses a newer database.

Depanator talks to IS24 the way the IS24 Android app does: its login service (`login.immobilienscout24.de`) and its API (`api.mobile.immobilienscout24.de`). That interface is unofficial and undocumented; IS24 can change it at any time, and using it is likely against IS24's terms of use, which could put your account at risk. Connecting an account, the search and the listing format have been checked live. Sending a contact request has **not** been tested against a live listing yet: until a first real send is confirmed, check your IS24 messages after the first applications.

## Verification and source

```sh
bun run test
bun run check
```

Tests cover the guided Telegram setup, connecting IS24 (including 2FA), the complete approval workflow with simulated external services, durable restart behavior, invalid approvals, exact drafts, the IS24 listing and contact formats, and filter preservation. Tests do not contact IS24 or Telegram.

The search URL translator originates from Homelander commit `b0e7283b540d853311854d5111bffc0254d5ea85`. Its MIT license and local modifications are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The original source analysis is in [docs/homelander-agent-analysis.md](docs/homelander-agent-analysis.md).
