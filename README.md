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
4. The bot guides you through the rest, in a few minutes:
   - **ChatGPT:** it sends a link and a code; open the link on your phone, sign in, enter the code. Depanator uses your ChatGPT subscription (Codex allowance), never paid API credit.
   - **ImmoScout24:** tap **🔗 Connect ImmoScout24** and enter your IS24 email and password (and a security code, if IS24 asks). They go straight to IS24's login service, the same one the IS24 app uses, and are never stored; the agent keeps only IS24's renewable login key (`is24-session.json` in the data directory). Only your Telegram account can open the page.
   - **Searches:** as the admin, tap ➕ Add and send a name and the results page address from immobilienscout24.de, for example `Berlin https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten`. Only apartment rentals are supported; a filter that cannot be applied exactly is rejected rather than silently widening the search. The first search runs every 2 minutes with a night pause from 22:00 to 07:00, each later one starts with what you last chose, and its ⚙️ button changes both. Then pick the searches you want listings from. Later, the admin adds, renames, relinks and removes searches in ⚙️ Settings → 🛠 Admin → 🔎 Manage searches.
   - **What you look for:** a form with your rent, rooms and living space (each optional; rent means warm rent) and your requirements, written as one text in your own words.
   - **About you:** a second form with your contact details for IS24's contact form (salutation, name, phone, street and house number, postcode, city; the name is filled in from your IS24 account), a free text about yourself for ChatGPT (household, job, income, move-in date, pets, documents), and whether to attach your IS24 Selbstauskunft. Applications state only what you write, plus the Selbstauskunft if you attach it.

The answers are stored in the data directory and survive restarts; an interrupted setup continues where it stopped. Afterwards:

The bot's menu (☰ next to the message field):

| Command | |
| --- | --- |
| `/status` | Overview: searching or paused, last check, ImmoScout24 and ChatGPT health, listing counts. Buttons: ⏸ Pause / ▶️ Resume (waiting drafts and approved sends still work while paused), 📬 Waiting (show a listing again), 📨 Sent, ⚙️ Settings |
| `/settings` | Everything you can change: 🔍 Search (your 🔎 searches, and ✏️ Edit for your rent, rooms, living space and requirements; ChatGPT skips clear mismatches), 👤 About you, ✍️ Agent's style (how ChatGPT writes each part of the message, overall, greeting, introduction, main part and closing, each with instructions and example wording; and what it gets for each listing), 📤 Auto-send (switches on tap), and 🔗 reconnecting ImmoScout24 or Immomio. The admin also has 🛠 Admin. ✏️ Edit opens a form inside Telegram. Every menu has a ← button one level up, and moving through them changes the same message. |

These also work when typed, as shortcuts: `/search`, `/pause`, `/prompt`, `/autosend`, `/connect`, `/immomio`, `/login`. A typed message the bot cannot act on opens `/settings`.

Only the admin (the first person to pair) has ⚙️ Settings → 🛠 Admin: 🔎 Manage searches (add, rename, relink and remove searches, and set how often and when each one runs), 🧠 Model (the one ChatGPT model and thinking level that reads every new listing and writes and rewrites the messages, for everyone; the newest version of each model the plan offers; also `/model`), 👥 People (invite and remove people) and 🔗 ChatGPT. You approve every application at first; once you trust the drafts, auto-send in `/settings` sends clear matches without asking.

### Being early

Each search is checked on its own schedule, which everyone sees when picking searches: how often (every 2 minutes by default) and a night pause (22:00–07:00 German time by default), since hardly anyone publishes listings at night. A check reads the first page of results, sorted newest first (the 20 newest listings), and more only up to the first listing it already knows (at most 3 pages), so it is usually a single request and short intervals stay cheap. Checks are spread by ±10% so they do not form an exact pattern. What a check finds goes into `searches.db` in the data directory, and everyone who picked that search reads the new listings from there right away. When you pick a search, or resume after ⏸ Pause, the listings online at that moment count as already online, without being reviewed or messaged; you hear about listings published after that. After a gap you did not choose (the night pause, a restart, an expired IS24 login) the newest listings you have not read yet, at most 60 per search, come to you as new, and older ones count as already online. With **auto-send** on, a newly published listing that clearly meets every requirement is sent in the same check, usually a minute or two after it is found; you get the listing and the sent message afterwards. Anything uncertain still waits for your tap. Listings marked 🔒 Suchen+ can only be contacted with that IS24 subscription.

### Several people

One agent serves several people through one bot. Each person has a private chat with the bot, their own choice of searches, limits, requirements, details, IS24 and Immomio accounts, approvals and waiting list. Nobody sees anyone else's listings or messages. The bot stays private: the first person pairs with the code from the log and becomes the admin, and everyone else needs an invite link from 👥 People in `/settings`, which works once within 24 hours. Anyone else is ignored. 👥 People also removes someone; their folder stays on the server.

All of them use the admin's ChatGPT subscription and searches, and everyone shares its usage limits. Keep in mind that a subscription is meant for one person; check OpenAI's terms before sharing yours. Applications always go out from each person's own IS24 account.

Only the admin decides what IS24 is asked for: a list of named searches under 🔎 Searches, each crawled exactly as its link says. ⚙️ next to a search renames or removes it. Everyone picks from that list. A check requests each search once, however many people picked it. A search nobody searching picked is never requested; when someone picks it again, its first check only notes what is online. A search that keeps failing backs off on its own (up to about an hour), and after three failures in a row the admin and everyone who picked it hear about it. Each listing is read once for everybody, and one whose result-list price is already above someone's limit is not read for them at all. Each person's rent, rooms and living space are then matched on the agent, and ChatGPT applies their requirements. To keep IS24 traffic low, keep the list short, use whole cities, and leave out filters that do not hold for everybody; requirements can cover those.

### Reviews

Each new match arrives as one compact card: photo, title, rent/size/rooms, collapsed details, links, and **✨ Write message / ✖️ Dismiss**. ChatGPT writes the application only when you tap ✨ Write message; the draft arrives as a short reply under the card with **Send / Dismiss**, **📋 Copy** (copies the message to your clipboard; a message over 256 characters, too long for Telegram's copy button, comes back as a code block that copies with one tap), and two ways to change it: **✏️ Rewrite** (reply with how to rewrite it, for example "shorter", "different opening" or "mention I can move in on 1 March") or **📝 Write myself** (reply with the exact message to send). A changed draft arrives as a new version and the old buttons stop working. Facts you state in an edit are treated as verified. Each approval authorizes one exact draft for one listing and account; every send outcome (sent, not sent, or uncertain) is reported, also after a restart. Changing your contact details invalidates waiting drafts (searches, limits, requirements, writing style and the model only affect new drafts); tap ✏️ Rewrite on one to renew it, or Dismiss it.

IS24 sometimes publishes a listing with facts missing, such as the rent. It still arrives as a card, with `?` in place of what is missing, and never goes out through auto-send. If the facts appear after you approve, the approval is invalidated because the listing changed.

The agent heals itself before asking for help. Search outages and IS24 blocks trigger exponential backoff (up to an hour); sends pause while IS24 blocks access. ChatGPT outages pause analysis without using up a listing's retries. Telegram alerts you only when a component fails three times in a row, when it recovers, or when a listing is given up after five failed analyses.

Each review runs the pinned official Codex CLI ephemerally with no tools (no shell, files, browsers, web search or MCP), a private empty working directory, and a restricted environment; its output is validated against a strict schema. Listing details, your preferences and contact facts go to ChatGPT; drafts and listing details go to your Telegram bot. `bun run status` prints the review history. Keep one agent per data directory (default `.depanator/`).

### Immomio

Some landlords take applications only on Immomio and put a `tenant.immomio.com/apply/…` link in the IS24 description. Send `/immomio` and tap **🔗 Connect Immomio** to enter your Immomio email and password (and a security code, if asked). As with IS24, they go straight to Immomio's login and are never stored; the agent keeps only the renewable login key (`immomio-session.json`). Keep your Immomio profile complete: it is what the landlord sees, because an Immomio application has no message.

A listing with exactly one Immomio link then arrives with **✅ Apply on Immomio** instead of a draft to send. After you approve, the agent checks the connected account, that the listing is still open, and that you have not applied yet, then submits one application through Immomio's tenant API. Listings that ask for a captcha or SMS verification are not submitted: you get the link to apply yourself. Landlord questions are not answered for you; the outcome tells you how many are waiting on Immomio. Without a connected Immomio account, such listings get the IS24 contact request as before.

The Immomio login and API are unofficial and undocumented, and have **not** been tested against a live account: check your Immomio applications after the first ones.

## Submission and recovery

Stable listing IDs prevent reanalysis and repeat applications after price changes. SQLite stores decisions, exact drafts, approvals, and single submission attempts. Immediately before its single contact request the sender rechecks the listing details, the connected account, and the approval. The request contains exactly the approved draft and your contact details. Fields a listing requires that the agent has no documented format for (move-in date, income, ...) are never guessed: such a listing fails before anything is sent, and you apply on IS24 yourself.

If IS24 is unreachable or blocking before the request, the approval stays and is sent on a later poll. A rejected request is reported as not sent; IS24 answers delivered requests with HTTP 500, which counts as sent; a lost answer or another IS24 server error is reported as uncertain, because the request may have arrived. Failed or uncertain submissions never automatically retry. If the outcome is uncertain or the process stops during submission, check your IS24 messages before further action. No requeue command is provided. SIGTERM stops starting new work immediately and allows at most 30 seconds to drain before exit 1; interrupted submissions remain uncertain. For private mounted secrets and the mandatory restore reconciliation marker, see the [operational contract](deploy/README.md#mounted-secrets-stopping-and-restores). The application cannot detect historical database rollback; the deployment restore hook must install the marker before resuming. If a hard stop leaves `agent.lock`, confirm no agent is running before removing that file and restarting; normal shutdown removes it. Interrupted or failed analysis retries up to five times per listing, then stops as `analysis_failed`; interrupted submissions remain quarantined. The complete review state machine (every status and the events each accepts) is `MACHINE` in `src/review.js`. The database schema is versioned; an older agent refuses a newer database.

Depanator talks to IS24 the way the IS24 Android app does: its login service (`login.immobilienscout24.de`) and its API (`api.mobile.immobilienscout24.de`). That interface is unofficial and undocumented; IS24 can change it at any time, and using it is likely against IS24's terms of use, which could put your account at risk. Connecting an account, the search and the listing format have been checked live. Sending contact requests was confirmed live on 2026-10-21; IS24 answers them with HTTP 500 even when delivered.

## Verification and source

```sh
bun run test
bun run check
```

Tests run the real agent against simulated external services and cover pairing and the guided Telegram setup, connecting IS24 and Immomio, the complete approval workflow (writing, rewriting, outdated approvals, exact drafts, auto-send), the shared searches and several people on one bot, the IS24 listing and contact formats, and IS24 failures. Tests do not contact IS24 or Telegram.

The search URL translator originates from Homelander commit `b0e7283b540d853311854d5111bffc0254d5ea85`. Its MIT license and local modifications are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The original source analysis is in [docs/homelander-agent-analysis.md](docs/homelander-agent-analysis.md).
