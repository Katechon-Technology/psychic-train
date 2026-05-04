# Build context for this image is the `plugins/` directory (set in
# dev/docker-compose.yml), so we can COPY shared assets out of sibling plugins
# (notably playwright-browser/stream-client/pw-browser) without vendoring
# duplicates here.
#
# Minecraft client + assets are NOT baked into this image. They live in the
# psychic_train_minecraft_client named volume (seeded from
# plugin-data/minecraft/ via dev/docker-compose.yml :: minecraft-client-init)
# and the manifest mounts that volume at /opt/mc-data when the broker spawns
# this image. Same provisioning path as the minecraft plugin's stream-client.
#
# Reuses /pw-browser (npm install'd) and /root/.cache/ms-playwright (Chromium
# binary downloaded by `playwright install`) from the playwright-browser
# image, sidestepping flaky downloads from Playwright's CDN on every rebuild.
FROM psychic-train/playwright-browser-stream-client:latest AS pw-assets

FROM psychic-train/stream-client-base:latest

ENV DEBIAN_FRONTEND=noninteractive

# Combined toolchain: Java for Minecraft, Node + Chromium deps for Playwright,
# wmctrl/xdotool for window-to-workspace assignment + workspace switching.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg jq unzip \
        openjdk-21-jre-headless \
        libgl1 libglx-mesa0 libgl1-mesa-dri mesa-utils \
        libopenal1 libxi6 libxxf86vm1 libxrandr2 libxcursor1 libxinerama1 \
        libglfw3 libxtst6 \
        wmctrl xdotool x11-utils \
        fonts-liberation libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
        libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
        libgbm1 libpango-1.0-0 libcairo2 libasound2 \
        python3 python3-venv \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Software-OpenGL rendering (no GPU in the container) — same env as the
# minecraft stream-client.
ENV LIBGL_ALWAYS_SOFTWARE=1 \
    MESA_GL_VERSION_OVERRIDE=4.3 \
    MESA_GLSL_VERSION_OVERRIDE=430 \
    GALLIUM_DRIVER=llvmpipe \
    _JAVA_OPTIONS="-Dorg.lwjgl.opengl.libname=libGL.so.1"

# MC version is exported so launch.sh can pick the right entry under
# /opt/mc-data/versions/. Actual data arrives at runtime via the mounted
# psychic_train_minecraft_client volume.
ARG MC_VERSION=1.21.1
ENV MC_VERSION=${MC_VERSION}

# Browser extensions — same Consent-O-Matic + uBlock Origin Lite pair as the
# playwright-browser plugin (see that Dockerfile for sed-patch rationale).
ARG UBOL_VERSION=2026.422.1301
ARG CONSENT_O_MATIC_VERSION=1.1.5
RUN mkdir -p /extensions/consent-o-matic /extensions/ublock-origin-lite \
    && curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors -o /tmp/com.zip \
       "https://github.com/cavi-au/Consent-O-Matic/releases/download/v${CONSENT_O_MATIC_VERSION}/consent-o-matic-v${CONSENT_O_MATIC_VERSION}-unpacked-release-chromium.zip" \
    && unzip -q /tmp/com.zip -d /extensions/consent-o-matic \
    && rm -f /tmp/com.zip \
    && sed -i 's/autoOpenOptionsTab:!0/autoOpenOptionsTab:!1/g' /extensions/consent-o-matic/*.js \
    && sed -i 's/defaultValues={A:!1,B:!1,D:!1,E:!1,F:!1,X:!1}/defaultValues={A:!0,B:!0,D:!0,E:!0,F:!0,X:!0}/g' /extensions/consent-o-matic/*.js \
    && curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors -o /tmp/ubol.zip \
       "https://github.com/uBlockOrigin/uBOL-home/releases/download/${UBOL_VERSION}/uBOLite_${UBOL_VERSION}.chromium.zip" \
    && unzip -q /tmp/ubol.zip -d /extensions/ublock-origin-lite \
    && rm -f /tmp/ubol.zip

# Playwright fastify server — copy the entire pre-built tree (including
# node_modules) from playwright-browser-stream-client, plus the playwright
# browser cache. Skips npm install AND the chromium download.
COPY --from=pw-assets /pw-browser /pw-browser
COPY --from=pw-assets /root/.cache/ms-playwright /root/.cache/ms-playwright

# Arcade's own small control server (workspace switching + task hint passthrough).
WORKDIR /control-server
COPY arcade/stream-client/control-server/package.json \
     arcade/stream-client/control-server/tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY arcade/stream-client/control-server/src ./src

# openbox config — three virtual desktops (Hub, Minecraft, Playwright).
COPY arcade/stream-client/openbox/rc.xml /root/.config/openbox/rc.xml

# Static assets the Hub Chromium opens.
COPY arcade/stream-client/hub.html /app/hub.html

# SPECTRE — Flask-based Global Intelligence dashboard. Source is NOT baked
# into the image (it lives in a sibling repo we can't access from CI); it
# arrives at runtime via the psychic_train_arcade_spectre volume mounted at
# /app/spectre. Only the deps live in the image, in a venv at /opt/spectre-venv,
# pip-installed from the committed spectre-requirements.txt snapshot. Refresh
# that file from upstream's requirements.txt whenever SPECTRE deps change.
COPY arcade/stream-client/spectre-requirements.txt /tmp/spectre-requirements.txt
RUN python3 -m venv /opt/spectre-venv \
    && /opt/spectre-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/spectre-venv/bin/pip install --no-cache-dir -r /tmp/spectre-requirements.txt \
    && rm -f /tmp/spectre-requirements.txt

COPY arcade/stream-client/launch.sh /app/launch.sh
RUN chmod +x /app/launch.sh

ENV CTRL_HOST=0.0.0.0 \
    CTRL_PORT=8780 \
    PW_HOST=0.0.0.0 \
    PW_PORT=8731 \
    SPECTRE_HOST=0.0.0.0 \
    SPECTRE_PORT=5050 \
    PLAYWRIGHT_BROWSER_KIOSK=1 \
    PLAYWRIGHT_BROWSER_EXTENSIONS=/extensions/consent-o-matic,/extensions/ublock-origin-lite \
    PLAYWRIGHT_BROWSER_PROFILE=/tmp/pw-profile

EXPOSE 8780 8731 5050
