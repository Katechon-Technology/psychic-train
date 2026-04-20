FROM psychic-train/stream-client-base:latest

ENV DEBIAN_FRONTEND=noninteractive

# Node.js (for the playwright-browser Fastify server) + Chromium deps.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl gnupg ca-certificates \
        fonts-liberation libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
        libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
        libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /pw-browser

COPY pw-browser/package.json pw-browser/tsconfig.json ./
RUN npm install --no-audit --no-fund \
    && npx playwright install chromium --with-deps \
    || npx playwright install chromium

COPY pw-browser/src ./src
COPY pw-browser/mcp-shim ./mcp-shim

COPY launch.sh /app/launch.sh
RUN chmod +x /app/launch.sh

ENV PW_HOST=0.0.0.0 \
    PW_PORT=8731

EXPOSE 8731
