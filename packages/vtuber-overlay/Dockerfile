# Builds on stream-client-base so the nginx + HLS serving layer is identical.
# Adds: Chrome, uv, PulseAudio, Open-LLM-VTuber (pinned commit), mao_pro Live2D,
# hls.js, patches, narrator. Overrides entrypoint to start audio + avatar server
# + narrator + Chromium + FFmpeg(x11grab+pulse).
#
# Build context = psychic-train repo root (packages/vtuber-overlay/live2d-models/mao_pro
# is vendored here so no sibling-repo checkout is needed).

FROM psychic-train/stream-client-base:latest

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        pulseaudio \
        wget gnupg2 curl \
        python3 python3-pip \
        ca-certificates \
        gettext-base \
        libgl1-mesa-dri \
        libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libvulkan1 libgbm1 \
        libgtk-3-0 libnspr4 libnss3 libxcomposite1 libxdamage1 libxfixes3 \
        libxkbcommon0 libxrandr2 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Google Chrome stable
RUN wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get update \
    && apt-get install -y /tmp/google-chrome.deb \
    && rm /tmp/google-chrome.deb \
    && rm -rf /var/lib/apt/lists/*

# uv (modern Python package manager)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Open-LLM-VTuber at pinned commit — same as claudetorio (19b58b1 has ElevenLabs)
RUN git init /app/vtuber \
    && cd /app/vtuber \
    && git remote add origin https://github.com/Open-LLM-VTuber/Open-LLM-VTuber \
    && git fetch --depth 1 origin 19b58b1f6c01e082289fce089392997b9d14fbc4 \
    && git checkout FETCH_HEAD \
    && git submodule update --init --recursive

# Patches: adds /api/speak and /api/speak/status; transparent embed.html
COPY packages/vtuber-overlay/patches/routes.py /app/vtuber/src/open_llm_vtuber/routes.py
COPY packages/vtuber-overlay/patches/embed.html /app/vtuber/frontend/embed.html

# Python deps for Open-LLM-VTuber
RUN cd /app/vtuber && uv sync --frozen --no-dev

# hls.js for the wrapper page's HLS iframe
RUN mkdir -p /var/www/html \
    && wget -q -O /var/www/html/hls.min.js \
       "https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"

RUN mkdir -p /app/vtuber/live2d-models/mao_pro /app/vtuber/models
COPY packages/vtuber-overlay/live2d-models/mao_pro/ /app/vtuber/live2d-models/mao_pro/

# Overlay assets + scripts
COPY packages/vtuber-overlay/conf.yaml.template /conf.yaml.template
COPY packages/vtuber-overlay/wrapper.html /wrapper.html
COPY packages/vtuber-overlay/entrypoint.sh /entrypoint.sh
COPY packages/vtuber-overlay/narrate.py /narrate.py
COPY packages/vtuber-overlay/scripts/start-rtmp.sh /scripts/start-rtmp.sh
COPY packages/vtuber-overlay/scripts/stop-rtmp.sh /scripts/stop-rtmp.sh
RUN chmod +x /entrypoint.sh /scripts/start-rtmp.sh /scripts/stop-rtmp.sh

# Override stream-client-base's CMD with our own entrypoint.
CMD ["/entrypoint.sh"]
