# Run the GHCR image with rootless Quadlet

The published image is `ghcr.io/jhoogstraat/depanator:latest`, for Linux x86_64 and ARM64. Servers need Podman, systemd user services, one `.container` file, config, and credentials. No source checkout or host Bun installation is needed. Pin a version or image digest for controlled updates.

## Configure

Create `~/.config/depanator` with mode 700. Extract the config template from the image:

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

Copy [depanator.container](quadlet/depanator.container) to `~/.config/containers/systemd/depanator.container`, or write your own using the same mounts and environment file. Podman automatically creates its named data volume. SQLite and the account profile persist there.

For first login, set `Exec=login` in that same file, then run:

```sh
systemctl --user daemon-reload
systemctl --user start depanator.service
```

On your workstation, run `ssh -N -L 6080:127.0.0.1:6080 USER@SERVER`. Open `http://127.0.0.1:6080/vnc.html`, enter the viewer password, sign into IS24, then close Chromium. Set `Exec=start`, reload, and start the same service again. Reviews and approval buttons arrive in Telegram.

Enable lingering once with `sudo loginctl enable-linger "$USER"` for startup without an interactive login. Quadlet's `WantedBy=default.target` handles boot activation; do not enable the generated service manually.

Logs: `journalctl --user -u depanator.service -f`. History: `podman exec depanator bun /app/src/cli.js status --config /config/config.json`.

For updates, stop the service, `podman pull ghcr.io/jhoogstraat/depanator:latest`, then start it. For reauthentication, repeat the `Exec=login` procedure. Back up the data volume with the service stopped. Log in separately on each server; cookies may not be portable.

The browser viewer is only for login and maintenance. It binds to host loopback and is accessed over SSH. Chromium's sandbox is disabled inside the unprivileged rootless container; no privileged mode or extra capabilities are required. Live IS24 account compatibility remains unverified and submission fails closed on unverifiable details or identity.

## Publishing

[The GitHub Actions workflow](../.github/workflows/image.yml) builds both architectures and publishes `latest`, commit, and version tags to GHCR when `main` or a `v*` tag is pushed, or when manually dispatched. It uses the repository's `GITHUB_TOKEN`, without a separate registry secret. Make the GHCR package public once for anonymous pulls; repository visibility is independent of package visibility. Until the first successful workflow run, the image is not available.

References: [GHCR publishing](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images), [multi-platform builds](https://docs.docker.com/build/ci/github-actions/multi-platform/), [Quadlet](https://docs.podman.io/en/stable/markdown/podman-systemd.unit.5.html).
