FROM psychic-train/stream-client-base:latest

ENV DEBIAN_FRONTEND=noninteractive

# Node.js (for the playwright-browser Fastify server) + Chromium deps + unzip
# (for extracting the uBlock Origin release zip).
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl gnupg ca-certificates unzip \
        fonts-liberation libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
        libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
        libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Unpacked browser extensions to load via --load-extension. Bumping these ARGs
# is the supported way to track upstream releases without touching the rest of
# the file. Both pull *built* release zips, not raw source — the C-O-M source
# tree's manifest has a "REPLACED_BY_BUILD_SCRIPT" version placeholder and
# references compiled JS/CSS that only exist in release artifacts.
ARG UBOL_VERSION=2026.422.1301
ARG CONSENT_O_MATIC_VERSION=1.1.5

RUN mkdir -p /extensions/consent-o-matic /extensions/ublock-origin-lite \
    && curl -fsSL -o /tmp/com.zip \
       "https://github.com/cavi-au/Consent-O-Matic/releases/download/v${CONSENT_O_MATIC_VERSION}/consent-o-matic-v${CONSENT_O_MATIC_VERSION}-unpacked-release-chromium.zip" \
    && unzip -q /tmp/com.zip -d /extensions/consent-o-matic \
    && rm -f /tmp/com.zip \
    # C-O-M opens its onboarding tab on every fresh profile because its default
    # debug flag `autoOpenOptionsTab` is true and we run with an ephemeral
    # profile. Flip the default to false so the welcome path is never taken.
    && sed -i 's/autoOpenOptionsTab:!0/autoOpenOptionsTab:!1/g' /extensions/consent-o-matic/*.js \
    # Flip the six consent categories (A=preferences, B=performance, D=info,
    # E=content, F=ads, X=other) from opt-out to opt-in so C-O-M clicks "Accept
    # all" instead of "Reject" — some CMPs only fully dismiss on positive consent.
    && sed -i 's/defaultValues={A:!1,B:!1,D:!1,E:!1,F:!1,X:!1}/defaultValues={A:!0,B:!0,D:!0,E:!0,F:!0,X:!0}/g' /extensions/consent-o-matic/*.js \
    && curl -fsSL -o /tmp/ubol.zip \
       "https://github.com/uBlockOrigin/uBOL-home/releases/download/${UBOL_VERSION}/uBOLite_${UBOL_VERSION}.chromium.zip" \
    && unzip -q /tmp/ubol.zip -d /extensions/ublock-origin-lite \
    && rm -f /tmp/ubol.zip

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
    PW_PORT=8731 \
    PLAYWRIGHT_BROWSER_KIOSK=1 \
    PLAYWRIGHT_BROWSER_EXTENSIONS=/extensions/consent-o-matic,/extensions/ublock-origin-lite

EXPOSE 8731
