# iPhone login without VPN or SSH

Use the existing noVNC viewer through authenticated HTTPS. The account browser and profile stay on the server. No application code or agent image changes are needed. Open the viewer in Safari or another browser that supports noVNC.

## Cloudflare Tunnel + Access

Requires a Cloudflare account, a domain on Cloudflare, and outbound tunnel connectivity from your server. Use a hostname such as `apartments.example.com`.

1. **Create Access protection first.** Add a self-hosted Access application for the entire hostname, with no path restriction. Enable one-time PIN or your existing identity provider. Add an Allow policy for your exact email address, with a session duration such as one hour. Do not add Everyone or Bypass policies. Both `/vnc.html` and the WebSocket endpoint must be protected.
2. Create a remotely managed Cloudflare Tunnel. Add a published HTTP route for the hostname to `http://127.0.0.1:6080`. Under the route's Access settings, enable **Protect with Access**, supplying the Access team name and application audience (AUD) tag. This makes the connector validate Access tokens before forwarding traffic.
3. Reuse an existing host-networked tunnel connector if you have one. Otherwise copy [cloudflared.container](cloudflared.container) into `~/.config/containers/systemd/cloudflared.container`. This optional second Quadlet uses the official image. Host networking reaches the agent's loopback port; it publishes no ports, and metrics also bind to loopback.
4. Save the tunnel token directly on the server in `~/.config/depanator/tunnel.env`, as `TUNNEL_TOKEN=your-tunnel-token`, with mode 600. Keep it separate from the agent's LLM and Telegram credentials. Do not paste tokens into chat or commit them.
5. Keep `PublishPort=127.0.0.1:6080:6080` in the agent Quadlet. Leave `Exec=start` and enable `"autoLogin": true` in `config.json` (the installer does this), then run:

   ```sh
   systemctl --user daemon-reload
   systemctl --user start depanator.service cloudflared.service
   ```

6. On your iPhone, open `https://apartments.example.com/vnc.html` in Safari. Authenticate through Access, enter the viewer password, and sign into IS24 including any 2FA. noVNC's side controls provide an on-screen keyboard. Close Chromium when done.
7. The agent verifies your account and begins polling automatically after Chromium closes. The tunnel remains available for future login, and Telegram notifies you when reauthentication is required. Listing reviews and approvals stay in Telegram.

Cloudflare terminates HTTPS and proxies the browser session. Access, the viewer password, and IS24 are separate authentication layers. Access expiry does not necessarily disconnect an already open WebSocket viewer; disconnect or stop the tunnel to terminate it immediately.

Before using real credentials, verify that private Safari reaches Access first, a disallowed email cannot reach noVNC, and an allowed login establishes the viewer's WebSocket connection. Protect the full hostname, not just the HTML page. This repository does not provision a live tunnel, DNS record, or Access policy.

## Existing authenticated reverse proxy

Route the chosen hostname to `http://127.0.0.1:6080` from a proxy on the host. Enforce authentication on every path, forward WebSocket upgrade headers, and avoid caching the viewer. A containerized proxy needs a network route to the viewer; its own `127.0.0.1` is not the host. Use the same iPhone login procedure. No Cloudflare connector is needed.

## References

- [Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/)
- [Access self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [Email-code authentication](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
- [Access validation at the tunnel origin](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/)
- [WebSocket support](https://developers.cloudflare.com/network/websockets/)
