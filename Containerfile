FROM docker.io/oven/bun:1.4.3-debian

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates chromium fonts-liberation xvfb x11-utils tini util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts --production
RUN bun node_modules/@openai/codex/bin/codex.js --version
COPY src ./src
COPY THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses
COPY .puppeteerrc.cjs ./
COPY deploy/container-entrypoint.sh /usr/local/bin/depanator-entrypoint
RUN chmod 755 /usr/local/bin/depanator-entrypoint && mkdir -p /data && chown bun:bun /data

ENV DISPLAY=:99 \
    HOME=/data/home \
    DEPANATOR_DATA_DIR=/data \
    DEPANATOR_BROWSER_EXECUTABLE=/usr/bin/chromium \
    DEPANATOR_BROWSER_NO_SANDBOX=1

USER bun
# IS24 login page for the Telegram Mini App; publish it behind HTTPS and set DEPANATOR_PUBLIC_URL.
EXPOSE 8080
# Docker format only (podman: build with --format docker). Fails when no poll finished for 2 intervals + 10 min.
HEALTHCHECK --interval=5m --timeout=10s --start-period=15m CMD ["/usr/local/bin/depanator-entrypoint", "health"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/depanator-entrypoint"]
CMD ["start"]
