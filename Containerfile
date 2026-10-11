FROM docker.io/oven/bun:1.4.3-debian

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates chromium fonts-liberation novnc websockify \
    xvfb x11vnc x11-utils openbox tini util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts --production
COPY src ./src
COPY THIRD_PARTY_NOTICES.md ./
COPY .puppeteerrc.cjs ./
COPY config.example.json ./
COPY deploy/container-entrypoint.sh /usr/local/bin/depanator-entrypoint
RUN chmod 755 /usr/local/bin/depanator-entrypoint && mkdir -p /data /config && chown bun:bun /data

ENV DISPLAY=:99 \
    HOME=/data/home \
    DEPANATOR_DATA_DIR=/data \
    DEPANATOR_BROWSER_EXECUTABLE=/usr/bin/chromium \
    DEPANATOR_BROWSER_NO_SANDBOX=1

USER bun
EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/depanator-entrypoint"]
CMD ["start"]
