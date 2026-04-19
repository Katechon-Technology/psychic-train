FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends software-properties-common \
    && add-apt-repository universe \
    && apt-get update && apt-get install -y --no-install-recommends \
        xvfb openbox x11-utils \
        ffmpeg \
        nginx \
        libxrandr2 libxcursor1 libxinerama1 libxi6 libgl1 libasound2 \
        wget xz-utils ca-certificates curl procps \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /tmp/hls /var/www/hls /var/log/nginx /var/lib/nginx /run/nginx

COPY entrypoint.sh /entrypoint.sh
COPY nginx.conf /etc/nginx/nginx.conf
COPY index.html /var/www/hls/index.html

RUN chmod +x /entrypoint.sh

ENV DISPLAY=:1 \
    DISPLAY_WIDTH=1280 \
    DISPLAY_HEIGHT=720 \
    DISPLAY_FPS=30

EXPOSE 3000

# Child images install kind-specific binaries and drop a launcher at /app/launch.sh.
# The base entrypoint will exec it after the X server is up.
CMD ["/entrypoint.sh"]
