# Container interface

Image: `ghcr.io/jhoogstraat/depanator:latest`, for Linux x86_64 and ARM64. The image includes Bun, Chromium, a virtual display, and the noVNC login viewer. A private package needs registry credentials; a public package supports anonymous pulls.

The operator chooses the container runtime, service manager, host paths, volume names, user mapping, published ports, domain, proxy, and authentication provider. The image does not create host services, modify system configuration, install Quadlets, or provision tunnels/DNS/access policies.

## Configuration wizard

Run the image interactively with command `setup --output-dir DIRECTORY`, where `DIRECTORY` is an existing writable directory you provide inside the container. The wizard writes only `config.json` and `secrets.env` there. It does not overwrite existing files or start services. No viewer password or display is needed to run setup.

The wizard asks for the filtered search URL, preferences, contact name/email, LLM backend (`api` or ChatGPT subscription through `codex`), Telegram bot token, and optional viewer URL. Only API mode asks for an LLM API key. Credentials are hidden while typing. After you send `/start` to your bot, it discovers the private chat and asks you to confirm it. It generates an eight-character viewer password and enables automatic login handoff. Additional contact facts can be added under `persona` later.

Mount the generated configuration wherever you choose and pass the secret values as environment variables through your deployment tooling. Restrict access to both files. `secrets.env` is a plain `KEY=value` file, not a shell script; how it is loaded depends on your runtime. Keys must not be included in the image or committed to source control.

You can also run the wizard from the source checkout: `bun src/cli.js setup --output-dir DIRECTORY`.

## Runtime inputs

| Input | Default / purpose |
| --- | --- |
| `DEPANATOR_CONFIG` | `/config/config.json`; path to the supplied JSON config |
| `DEPANATOR_DATA_DIR` | `/data`; absolute writable path for persistent SQLite state and browser profile |
| `DEPANATOR_BROWSER_PROFILE` | `browser` under the data directory; optional independent profile path |
| `HOME` | `/data/home`; writable browser home directory |
| `OPENAI_API_KEY` or `DEPANATOR_LLM_API_KEY` | Required only for `llm.backend: api` |
| `TELEGRAM_BOT_TOKEN` | Required dedicated bot credential |
| `TELEGRAM_CHAT_ID` | Required positive private chat ID; also accepted in config |
| `VNC_PASSWORD` | Required for `start`/`login`; viewer authentication, eight characters |

Internal paths are image defaults, not prescribed host locations. Persist the data directory and any independently configured browser profile. These paths must be writable by the container process; the image defaults to user `bun` (UID/GID 1000), and your runtime controls permissions and user mapping. If changing the data path, also configure a writable `HOME` as appropriate. Run one instance per data directory and Telegram bot.

Commands: `start` (default), `login` (explicit manual maintenance), `status` (read-only history), `llm-login` (ChatGPT device-code login), and `setup`. Configuration and secrets must be supplied before starting. Runtime lifecycle, restarts, upgrades, and backups are controlled by your deployment tooling.

For subscription mode, run the image with command `llm-login`, the generated configuration, and the same persistent data storage used by `start`. It prints a link and one-time code; complete login in your phone's browser. No viewer password, display, inbound port, or phone VPN is required for this command. Enable device-code login in ChatGPT security settings if requested. Authentication is saved under `codex` in the data directory, or at `llm.codexHome` if configured independently; persist and protect that location. Run `start` afterward. The bundled Codex CLI uses your plan's allowance and never falls back to API billing. [Subscription backend details](../README.md#chatgpt-subscription).

## Viewer and account login

The viewer listens on container TCP port **6080**, with its page at `/vnc.html` and a WebSocket connection on the same service. Publishing/routing this port is the operator's choice. The image makes no assumption that container loopback is reachable from a host or another container.

For remote access, place authenticated HTTPS in front of the entire viewer service, including WebSockets. Forward WebSocket upgrades and avoid caching. Choose your own proxy or tunnel; no provider is bundled. The viewer password is an additional layer, distinct from your external access controls and IS24 credentials. An already open WebSocket can outlive an external login session; use your infrastructure to terminate access when required.

With `"autoLogin": true`, the agent verifies the signed-in IS24 account before work. If it cannot verify the configured identity, it pauses, notifies Telegram, and opens the manual login browser. Open your configured viewer, sign into IS24 including 2FA, and close Chromium. The agent rechecks identity and resumes automatically. The optional `viewerUrl` config field is your HTTPS login link for notifications; leaving it empty does not disable authentication handoff. No mode edits or service-manager commands are required by this flow.

The container disables Chromium's own sandbox by default. Isolation is the operator's responsibility; `DEPANATOR_BROWSER_NO_SANDBOX=0` enables Chromium's sandbox when your runtime supports it. The viewer is only for account login/maintenance; listing approvals remain in Telegram.

Live IS24 account compatibility has not been verified. Missing identity indicators, changed site structure, or unverifiable form values fail closed. Network/site failures remain errors and are retried by normal polling; they are not accepted as authenticated sessions.

## Publishing

[GitHub Actions](../.github/workflows/image.yml) rebuilds both architectures and publishes `latest`, commit, and version tags to GHCR on pushes to `main` or a `v*` tag, and supports manual dispatch. The workflow uses `GITHUB_TOKEN`; no separate registry secret is needed. Package visibility is independent of repository visibility.
