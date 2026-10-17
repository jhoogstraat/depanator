# Container interface

Image: `ghcr.io/jhoogstraat/depanator:latest`, for Linux x86_64 and ARM64. The image includes Bun, Chromium, and a virtual display. A private package needs registry credentials; a public package supports anonymous pulls.

The operator chooses the container runtime, service manager, host paths, volume names, user mapping, published ports, domain, proxy, and authentication provider. The image does not create host services, modify system configuration, install Quadlets, or provision tunnels/DNS/access policies.

## Getting started

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and keep its token.
2. Run the image with `TELEGRAM_BOT_TOKEN`, a persistent volume at `/data`, and port 8080 published behind HTTPS (reverse proxy or tunnel). Set `DEPANATOR_PUBLIC_URL` to that HTTPS address; the IS24 login then opens inside Telegram.
3. Read the container log. It prints `Open your bot in Telegram and send:  /start <code>`. Send that to your bot; the bot then guides you through ChatGPT login, your search, contact details, the IS24 login (inside Telegram), check interval, and auto-send. All answers are stored in `/data`.

There is no configuration file. `deploy/secrets.env.example` lists every input.

## Runtime inputs

| Input | Default / purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Required. Token of a dedicated bot without a webhook |
| `DEPANATOR_PUBLIC_URL` | Public HTTPS address forwarding to port 8080; needed to log in to IS24 inside Telegram |
| `DEPANATOR_PORT` | `8080`; port of the login page |
| `DEPANATOR_DATA_DIR` | `/data`; absolute writable path for the database, settings, browser profile and ChatGPT login |
| `DEPANATOR_BROWSER_PROFILE` | `browser` under the data directory; optional independent profile path |
| `HOME` | `/data/home`; writable browser home directory |

Internal paths are image defaults, not prescribed host locations. Persist the data directory and any independently configured browser profile. These paths must be writable by the container process; the image defaults to user `bun` (UID/GID 1000), and your runtime controls permissions and user mapping. If changing the data path, also configure a writable `HOME` as appropriate. Run one instance per data directory and Telegram bot.

Commands: `start` (default), `status` (read-only history), and `health` (exit 0 while `start` is polling).

`start` checks the Telegram token and rejects a bot with a webhook before doing any work, so a misconfigured bot exits instead of silently failing. The image's `HEALTHCHECK` runs `health`: after every check the agent renews a deadline of two check intervals plus ten minutes in `heartbeat`, so a hung browser or an IS24 login nobody completes turns the container unhealthy. Docker uses it as is; Podman keeps it only for images built with `--format docker`, otherwise pass `--health-cmd '/usr/local/bin/depanator-entrypoint health'`. Restarting an unhealthy container is safe: interrupted submissions are quarantined, never resent.

## Mounted secrets, stopping, and restores

Instead of values in container environment metadata, supply `TELEGRAM_BOT_TOKEN_FILE`. It points to a readable mounted file containing a single nonempty line, optionally newline-terminated. Setting both a value and its corresponding `_FILE` path is rejected. Values are read internally, never copied into the container's configured environment. Private mounts and UID/idmap/SELinux permissions are operator responsibilities. `status` does not load secret files.

For `start`, SIGTERM/SIGINT immediately stop accepting queued work and starting further reviews/submissions. Search and LLM requests are cancelled, a pending IS24 login is cancelled, and an already-started browser operation can settle. A synchronous guard runs immediately before the browser submit command. Shutdown drains and closes browser/SQLite for **at most 30 seconds**, then exits with status **1** if still blocked. The container wrapper preserves that exit status. Configure your runtime's stop timeout above 30 seconds (for example, 40 seconds); keep its final kill safeguard for event-loop or process stalls. Successful shutdown exits 0. Hard stops retain durable submission claims; restart quarantines those as `unknown_outcome` without retrying. Unclaimed approvals can resume on normal restart.

A historical backup can predate a successful remote send; the application cannot detect that rollback or undo IS24 messages. **Your restore lifecycle must create `/data/reconciliation-required` after restoring data and before any start/resume.** The marker blocks startup, queued work, and the final submit seam. Keep it present while using `status` to inspect restored history and manually reconciling IS24 account history, stale approvals, and listings that were already contacted. Do not remove the marker merely because the restore succeeded. Remove it only after reconciliation and safe repair of restored state, then start explicitly. No automatic reconciliation or marker removal is provided. Preserve the marker during upgrades/backups until deliberately cleared. Restores must also occur with all data consumers stopped; the marker is not permission to replace a live SQLite database.

Back up the entire stopped data directory: SQLite database and any WAL/SHM files, settings, browser profile/cookies, browser home, Telegram offset, and the ChatGPT (Codex) login. Treat this backup as sensitive. No host service manager or deployment topology is assumed here.

## IS24 login

Before every check the agent verifies the signed-in IS24 account. When it is not signed in, the agent opens IS24 in a phone-sized tab of its own browser and sends a **🔐 Log in to IS24** button. The button opens a Telegram Mini App that shows that tab, forwards taps, typing and scrolling, and ends with **I'm logged in** (or when the agent sees the account signed in). The agent then rechecks your identity and resumes. The session lives in the browser profile, so this is needed only when IS24 ends the session.

The login page is served on port **8080** (`/login`). Telegram only opens Mini Apps over HTTPS, so route a public HTTPS address to that port and set `DEPANATOR_PUBLIC_URL` to it; a path prefix is fine. Every request must carry the owner's Telegram-signed Mini App data (checked against the bot token and the paired chat, valid for one hour), so nobody else can see or drive the tab even though the address is public. Nothing else is served there.

The container disables Chromium's own sandbox by default. Isolation is the operator's responsibility; `DEPANATOR_BROWSER_NO_SANDBOX=0` enables Chromium's sandbox when your runtime supports it. 

Live IS24 account compatibility has not been verified. Missing identity indicators, changed site structure, or unverifiable form values fail closed. Network/site failures remain errors and are retried by normal polling; they are not accepted as authenticated sessions.

## Publishing

[GitHub Actions](../.github/workflows/image.yml) rebuilds both architectures and publishes `latest`, commit, and version tags to GHCR on pushes to `main` or a `v*` tag, and supports manual dispatch. The workflow uses `GITHUB_TOKEN`; no separate registry secret is needed. Package visibility is independent of repository visibility.
