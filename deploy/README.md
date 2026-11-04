# Container interface

Image: `ghcr.io/jhoogstraat/depanator:latest`, for Linux x86_64 and ARM64. The image includes Bun and the Codex CLI; no browser. A private package needs registry credentials; a public package supports anonymous pulls.

The operator chooses the container runtime, service manager, host paths, volume names, user mapping, published ports, domain, proxy, and authentication provider. The image does not create host services, modify system configuration, install Quadlets, or provision tunnels/DNS/access policies.

## Getting started

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and keep its token.
2. Run the image with `TELEGRAM_BOT_TOKEN`, a persistent volume at `/data`, and port 8080 published behind HTTPS (reverse proxy or tunnel). Set `DEPANATOR_PUBLIC_URL` to that HTTPS address; Telegram opens the "Connect ImmoScout24" page there.
3. Read the container log. It prints `Open your bot in Telegram and send:  /start <code>`. Send that to your bot; the bot then guides you through ChatGPT login, connecting ImmoScout24 (inside Telegram), your searches, what you look for, and your details. Auto-send starts off; turn it on later in `/settings`. All answers are stored in `/data`.

There is no configuration file. `deploy/secrets.env.example` lists every input.

## Runtime inputs

| Input | Default / purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Required. Token of a dedicated bot without a webhook |
| `DEPANATOR_PUBLIC_URL` | Required. Public HTTPS address forwarding to port 8080, where Telegram opens the "Connect ImmoScout24" page |
| `DEPANATOR_PORT` | `8080`; port of the connect page |
| `DEPANATOR_DATA_DIR` | `/data`; absolute writable path for each person's database, settings and login keys (`users/<telegram id>/`) and the shared ChatGPT login (`codex/`) |
| `HOME` | `/data/home`; writable home directory |

Internal paths are image defaults, not prescribed host locations. Persist the data directory. These paths must be writable by the container process; the image defaults to user `bun` (UID/GID 1000), and your runtime controls permissions and user mapping. If changing the data path, also configure a writable `HOME` as appropriate. Run one instance per data directory and Telegram bot.

Commands: `start` (default), `status` (read-only history), and `health` (exit 0 while `start` is polling).

`start` checks the Telegram token and rejects a bot with a webhook before doing any work, so a misconfigured bot exits instead of silently failing. The image's `HEALTHCHECK` runs `health`: every minute the agent renews a deadline in `heartbeat`: two intervals plus ten minutes after each search's last check, so the container turns unhealthy when a search's checks hang. The night pause does not count as hanging. One person's unfinished IS24 connection stalls only their own checks. Docker uses it as is; Podman keeps it only for images built with `--format docker`, otherwise pass `--health-cmd '/usr/local/bin/depanator-entrypoint health'`. Restarting an unhealthy container is safe: interrupted submissions are quarantined, never resent.

## Mounted secrets, stopping, and restores

Instead of values in container environment metadata, supply `TELEGRAM_BOT_TOKEN_FILE`. It points to a readable mounted file containing a single nonempty line, optionally newline-terminated. Setting both a value and its corresponding `_FILE` path is rejected. Values are read internally, never copied into the container's configured environment. Private mounts and UID/idmap/SELinux permissions are operator responsibilities. `status` does not load secret files.

For `start`, SIGTERM/SIGINT immediately stop accepting queued work and starting further reviews/submissions. Search and LLM requests are cancelled, a pending IS24 connection is cancelled, and an already-started contact request can settle. A synchronous guard runs immediately before the contact request. Shutdown drains and closes SQLite for **at most 30 seconds**, then exits with status **1** if still blocked. The container wrapper preserves that exit status. Configure your runtime's stop timeout above 30 seconds (for example, 40 seconds); keep its final kill safeguard for event-loop or process stalls. Successful shutdown exits 0. Hard stops retain durable submission claims; restart quarantines those as `unknown_outcome` without retrying. Unclaimed approvals can resume on normal restart.

A historical backup can predate a successful remote send; the application cannot detect that rollback or undo IS24 messages. **Your restore lifecycle must create `/data/reconciliation-required` after restoring data and before any start/resume.** The marker blocks startup, queued work, and the final submit seam. Keep it present while using `status` to inspect restored history and manually reconciling IS24 account history, stale approvals, and listings that were already contacted. Do not remove the marker merely because the restore succeeded. Remove it only after reconciliation and safe repair of restored state, then start explicitly. No automatic reconciliation or marker removal is provided. Preserve the marker during upgrades/backups until deliberately cleared. Restores must also occur with all data consumers stopped; the marker is not permission to replace a live SQLite database.

Back up the entire stopped data directory: every person's folder under `users/` (SQLite database and any WAL/SHM files, settings, and the `is24-session.json` and `immomio-session.json` login keys), Telegram offset, and the ChatGPT (Codex) login. Treat this backup as sensitive. The `raw/` directory holds IS24 responses that went wrong, unpruned and possibly with landlord contact details; see [docs/raw-responses.md](../docs/raw-responses.md). No host service manager or deployment topology is assumed here.

The first start of a multi-user version moves a single-owner data directory into `users/<telegram id>/`, and its owner becomes the admin. The first start with the admin's search list turns each person's search URL into their rent, rooms and living-space limits (rent now always means warm rent) plus an entry named `Search 1`, `Search 2`, … on that list, and waiting drafts need ✏️ Improve once before they can be sent. These moves have no automatic way back, so back up first. To roll back, stop the agent, move the files from that folder back to the data directory, and start the older image. Removing someone renames their folder to `users/removed-<telegram id>-<timestamp>`, which still holds their login keys and personal details: delete it when nothing there is needed any more. `reconciliation-required` still sits at the top of the data directory and stops the whole agent, for everybody.

## Connecting ImmoScout24

When no IS24 account is connected, or IS24 ends the login, the bot sends a **🔗 Connect ImmoScout24** button and pauses checks. It opens a Telegram Mini App where that person enters the IS24 email and password, and a security code if IS24 asks. The agent passes them once to IS24's login service, the one the IS24 Android app uses, and stores only the resulting renewable login key (`is24-session.json`, mode 0600). Password and code are never stored or logged.

The page is served on port **8080** (`/connect`). Telegram only opens Mini Apps over HTTPS, so route a public HTTPS address to that port and set `DEPANATOR_PUBLIC_URL` to it; a path prefix is fine. Every request except the static page and the bot's avatar must carry Telegram-signed Mini App data (checked against the bot token, valid for one hour) from someone on this agent, and reaches only that person's own login, so nobody else can use it even though the address is public. Logins are accepted only while the agent is waiting for one. The password passes through whatever terminates HTTPS for that address (your reverse proxy, or the tunnel provider).

Listings and contact requests use the IS24 app's API. It is unofficial and can change; sending contact requests was confirmed live on 2026-10-21 (IS24 answers delivered requests with HTTP 500).

## Publishing

[GitHub Actions](../.github/workflows/image.yml) rebuilds both architectures and publishes `latest`, commit, and version tags to GHCR on pushes to `main` or a `v*` tag, and supports manual dispatch. The workflow uses `GITHUB_TOKEN`; no separate registry secret is needed. Package visibility is independent of repository visibility.
