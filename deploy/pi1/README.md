# pi1 deployment

Runs as `depanator.service`, using the adjacent Quadlet. The pinned image is
the `Image=` line there; to upgrade, set it to the ARM64 manifest digest of the
new `sha-<commit>` tag, then `daemon-reload` and restart the service.

- Data: `/var/lib/homelab/apps/depanator/data`.
- Bot token: private `config/bot-token`, mounted through `_FILE`.
- Public Telegram Mini App:
  `https://trek.hoogstraat.net/depanator/connect`.
- Private LAN page: `https://depanator.hoogstraat.de/connect`.

`/pause` toggles searching.

Searches run on the scheduled interval; the manual search button and action
were removed. The first successful poll after startup/resume/search changes
records a baseline without reviewing it. Pending criteria prompts survive
restarts. Hard exclusions reject explicit swap-only listings, and ordinary
rentals do not need a no-swap declaration. Night pause defaults to
22:00–07:00 Europe/Berlin and is configurable in Telegram.

The [homelab deployment source](https://github.com/jhoogstraat/homelab/pull/13)
contains the Quadlet, maintenance readiness probe and `docs/depanator.md`. The Pi's device-local overrides provide the live
deployment.

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
