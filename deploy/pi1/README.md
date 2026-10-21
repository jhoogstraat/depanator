# pi1 deployment

Deployed on 2026-10-19 as `depanator.service`, using the adjacent Quadlet.
The ARM64 image was built from this working tree, including the night pause
and account status fixes, and published through the repository image workflow.

- Published source commit: `0d9e1e2fb644e84d83cb2e6d14a14cbe259b90ae` (updated 2026-10-21;
  IS24 HTTP 500 contact answers count as sent).
- ARM64 image: `ghcr.io/jhoogstraat/depanator:sha-0d9e1e2`.
- Pinned manifest: `sha256:c72b0c02630fc493f31fd7834e39b17f776be87c528bdf997be1814ef13ed1d0`.
- Previous unit: `/var/lib/homelab/recovery/depanator.container.before-0d9e1e2`.
- Data: `/var/lib/homelab/apps/depanator/data` (101 known listings migrated).
- Bot token: private `config/bot-token`, mounted through `_FILE`.
- Public Telegram Mini App:
  `https://trek.hoogstraat.net/depanator/connect`.
- Private LAN page: `https://depanator.hoogstraat.de/connect`.

All 60 application tests and the Bun build passed. The running ARM64 image,
Linux Quadlet generation, heartbeat, homelab startup dependency, backup writer
participation/readiness, public page and unauthenticated action rejection were
checked. TREK's existing health endpoint remains healthy.

Searching was resumed after the fixes, with a fresh baseline. `/pause` toggles
searching.
Searches run on the scheduled interval; the manual search button and action
were removed. The first successful poll after startup/resume/search changes
records a baseline without reviewing it. Pending criteria prompts survive
restarts. Hard exclusions reject explicit swap-only listings, and ordinary
rentals do not need a no-swap declaration. Night pause defaults to
22:00–07:00 Europe/Berlin and is configurable in Telegram.

The [homelab deployment source](https://github.com/jhoogstraat/homelab/pull/13)
contains the Quadlet, maintenance readiness probe and `docs/depanator.md`. The Pi's device-local overrides provide the live
deployment. Its previous unit/helper are archived under
`/var/lib/homelab/recovery/depanator-before-20261019`.

The Mac's retired `.depanator/live` retains its original data and now has a
`reconciliation-required` marker to prevent accidentally running both copies.
Do not remove that marker to restart the old agent. Historical restores require
the reconciliation procedure in the parent deployment guide.

Use `sudo systemctl status depanator` and `sudo journalctl -u depanator` on the
Pi for diagnostics. Image upgrades are deliberate digest changes; automatic
registry updates are disabled.

## Secrets and state provenance

The current Pi state was copied from the latest stopped Mac agent at
`.depanator/live`, using a consistent SQLite backup. The Pi is now the live
source of state; it does not synchronize with Git or the retired Mac copy.

- BotFather issued the Telegram bot token, previously held at
  `~/.config/depanator/bot-token` on the Mac. The Pi stores it at
  `/var/lib/homelab/apps/depanator/config/bot-token` and mounts it read-only.
- ChatGPT device login created `data/codex/auth.json`, holding OAuth login and
  renewal tokens. Codex renews these on the Pi; no API billing key is used.
- Connecting IS24 created `data/is24-session.json`, holding a renewable login.
  The IS24 password and security code are not retained.
- `data/agent.db` contains personal settings, Telegram pairing, listing history
  and application outcomes. `data/telegram-offset.json` tracks consumed updates.

Those paths are relative to `/var/lib/homelab/apps/depanator` unless absolute.
Credential files and the database are root-owned, mode 0600, inside private
app directories. The host copies are ordinary files, not SOPS ciphertext.
The existing homelab encrypted restic backup is configured to include this app
tree; its repository credentials are provisioned independently under
`/var/lib/homelab/credentials`. No credential values or runtime state are
committed to either repository.
