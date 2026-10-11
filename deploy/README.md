# Run the GHCR image with rootless Quadlet

The published image is `ghcr.io/jhoogstraat/depanator:latest`, for Linux x86_64 and ARM64. Servers need Podman, systemd user services, one `.container` file, config, and credentials. No source checkout or host Bun installation is needed. Pin a version or image digest for controlled updates.

## Quick setup

Run as your rootless service user on a Linux server with Podman and a working systemd user session:

```sh
curl -fsSLo depanator-install.sh https://raw.githubusercontent.com/jhoogstraat/depanator/main/deploy/install.sh && sh depanator-install.sh
```

The wizard asks for your filtered search URL, preferences, contact name/email, API key, bot token, and optional authenticated viewer URL. Keys are hidden while typing. It discovers your private Telegram chat after you send `/start`, asks you to confirm it, generates a viewer password, writes protected config and credentials, installs the Quadlet, and starts the service. Existing configuration is never overwritten. Additional contact facts can be added later under `persona` in `config.json`.

Configure your own [Cloudflare Tunnel + Access or authenticated reverse proxy](remote-login.md), then open the viewer link on your phone. Sign into IS24 and close Chromium. The agent verifies the account and resumes automatically. It also pauses and sends a Telegram login notice when the account needs attention. No Quadlet mode changes are needed. Site/network failures remain errors rather than being treated as a successful login.

The installer prints the one-time lingering command if needed for startup after logout or boot. Creating the bot, supplying keys, configuring your domain/access policy, and completing IS24 login/2FA remain operator tasks. No hostname, Access email, or tunnel is provisioned automatically. A private GHCR package requires registry authentication; make the package public for anonymous pulls.

## Manual setup

Create the configuration directory and extract the template from the image:

```sh
mkdir -p ~/.config/depanator ~/.config/containers/systemd
chmod 700 ~/.config/depanator
```

Then:

```sh
podman run --rm --entrypoint cat ghcr.io/jhoogstraat/depanator:latest /app/config.example.json > ~/.config/depanator/config.json
```

Edit the search URL, account email, persona, and preferences. Create `~/.config/depanator/secrets.env`:

```dotenv
OPENAI_API_KEY=your-api-key
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-private-numeric-chat-id
VNC_PASSWORD=your-viewer-password
```

Use an eight-character viewer password. Protect both files with `chmod 600`. Keep one agent per Telegram bot.

## One Quadlet

Download the example or write your own using the same mounts and environment file:

```sh
curl -fsSL https://raw.githubusercontent.com/jhoogstraat/depanator/main/deploy/quadlet/depanator.container -o ~/.config/containers/systemd/depanator.container
```

Podman automatically creates its named data volume. SQLite and the account profile persist there. Hostnames, authentication policies, and tunnel credentials are configured by each server operator; none are embedded in the image.

For automatic login handoff, add `"autoLogin": true` and your authenticated `"viewerUrl"` to `config.json`, leave `Exec=start`, then run:

```sh
systemctl --user daemon-reload
systemctl --user start depanator.service
```

For an iPhone without VPN or SSH, follow [authenticated HTTPS access](remote-login.md). Alternatively, on your workstation run `ssh -N -L 6080:127.0.0.1:6080 USER@SERVER`. Open `http://127.0.0.1:6080/vnc.html`, enter the viewer password, sign into IS24, then close Chromium. The agent verifies the account and starts polling automatically. The explicit `Exec=login` command remains available for maintenance. Reviews and approval buttons arrive in Telegram.

Enable lingering once with `sudo loginctl enable-linger "$USER"` for startup without an interactive login. Quadlet's `WantedBy=default.target` handles boot activation; do not enable the generated service manually.

Logs: `journalctl --user -u depanator.service -f`. History: `podman exec depanator bun /app/src/cli.js status --config /config/config.json`.

For updates, stop the service, `podman pull ghcr.io/jhoogstraat/depanator:latest`, then start it. With automatic login enabled, follow the Telegram login notice for reauthentication. Back up the data volume with the service stopped. Log in separately on each server; cookies may not be portable.

The browser viewer is only for login and maintenance. It binds to host loopback and is accessed over SSH or the authenticated HTTPS route above. Chromium's sandbox is disabled inside the unprivileged rootless container; no privileged mode or extra capabilities are required. Live IS24 account compatibility remains unverified and submission fails closed on unverifiable details or identity.

## Publishing

[The GitHub Actions workflow](../.github/workflows/image.yml) builds both architectures and publishes `latest`, commit, and version tags to GHCR when `main` or a `v*` tag is pushed, or when manually dispatched. It uses the repository's `GITHUB_TOKEN`, without a separate registry secret. Make the GHCR package public once for anonymous pulls; repository visibility is independent of package visibility.

References: [GHCR publishing](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images), [multi-platform builds](https://docs.docker.com/build/ci/github-actions/multi-platform/), [Quadlet](https://docs.podman.io/en/stable/markdown/podman-systemd.unit.5.html).
