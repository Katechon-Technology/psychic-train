FROM psychic-train/stream-client-base:latest

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl gnupg ca-certificates \
        fonts-liberation libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
        libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
        libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
        chromium-browser || \
    apt-get install -y --no-install-recommends chromium \
    ; \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /viewer
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY prismarine-viewer-bot.mjs ./
COPY launch.sh /app/launch.sh
RUN chmod +x /app/launch.sh
