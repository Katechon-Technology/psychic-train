FROM psychic-train/stream-client-base:latest

ENV DEBIAN_FRONTEND=noninteractive

# Desktop tooling: terminal emulator, mouse/keyboard injection, window manager
# control, screenshot tool, image viewer, status bar, scientific Python stack,
# and Chromium runtime deps. tmux gives us a clean way to spawn long-running
# commands inside an xterm and tail their output from outside.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl gnupg ca-certificates unzip jq \
        xterm xdotool wmctrl xclip xsel \
        imagemagick scrot feh \
        tmux conky \
        x11-apps x11-utils \
        fonts-liberation fonts-dejavu \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
        libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
        libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
        python3 python3-pip python3-tk python3-dev \
        python3-numpy python3-pandas python3-matplotlib python3-pil \
        python3-requests python3-bs4 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# pyautogui isn't packaged in apt; pull it from pip. The base is ubuntu:22.04
# whose system Python has no EXTERNALLY-MANAGED marker, so a plain pip install
# works without --break-system-packages (which 22.04's pip doesn't recognize).
RUN pip3 install --no-cache-dir \
        pyautogui==0.9.54 \
        pyperclip==1.8.2

# Browser extensions — same Consent-O-Matic + uBlock Origin Lite setup as the
# playwright-browser plugin (see plugins/playwright-browser/stream-client/
# Dockerfile for the rationale on the sed patches).
ARG UBOL_VERSION=2026.422.1301
ARG CONSENT_O_MATIC_VERSION=1.1.5

# --retry guards against transient mid-transfer drops from GitHub's release CDN
# (curl exit 56). Each RUN is its own layer so a flake on one download doesn't
# invalidate the cache for the other.
RUN mkdir -p /extensions/consent-o-matic \
    && curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors -o /tmp/com.zip \
       "https://github.com/cavi-au/Consent-O-Matic/releases/download/v${CONSENT_O_MATIC_VERSION}/consent-o-matic-v${CONSENT_O_MATIC_VERSION}-unpacked-release-chromium.zip" \
    && unzip -q /tmp/com.zip -d /extensions/consent-o-matic \
    && rm -f /tmp/com.zip \
    && sed -i 's/autoOpenOptionsTab:!0/autoOpenOptionsTab:!1/g' /extensions/consent-o-matic/*.js \
    && sed -i 's/defaultValues={A:!1,B:!1,D:!1,E:!1,F:!1,X:!1}/defaultValues={A:!0,B:!0,D:!0,E:!0,F:!0,X:!0}/g' /extensions/consent-o-matic/*.js

RUN mkdir -p /extensions/ublock-origin-lite \
    && curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors -o /tmp/ubol.zip \
       "https://github.com/uBlockOrigin/uBOL-home/releases/download/${UBOL_VERSION}/uBOLite_${UBOL_VERSION}.chromium.zip" \
    && unzip -q /tmp/ubol.zip -d /extensions/ublock-origin-lite \
    && rm -f /tmp/ubol.zip

# Control server (Fastify) — installs Playwright Chromium for the browser tab API.
WORKDIR /control-server
COPY control-server/package.json control-server/tsconfig.json ./
RUN npm install --no-audit --no-fund \
    && npx playwright install chromium --with-deps \
    || npx playwright install chromium

COPY control-server/src ./src

COPY launch.sh /app/launch.sh
COPY seed_layout.sh /app/seed_layout.sh
RUN chmod +x /app/launch.sh /app/seed_layout.sh

# Workspace the agent reads/writes (infographics, scratch files, downloads).
RUN mkdir -p /workspace
ENV WORKSPACE=/workspace

ENV CTRL_HOST=0.0.0.0 \
    CTRL_PORT=8780 \
    PLAYWRIGHT_BROWSER_KIOSK=0 \
    PLAYWRIGHT_BROWSER_EXTENSIONS=/extensions/consent-o-matic,/extensions/ublock-origin-lite \
    PLAYWRIGHT_BROWSER_PROFILE=/workspace/.browser-profile

EXPOSE 8780
