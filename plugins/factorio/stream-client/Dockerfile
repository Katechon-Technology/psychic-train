FROM psychic-train/stream-client-base:latest

# The proprietary Factorio client is NOT baked into the image. Instead, the
# broker mounts a named Docker volume at /opt/factorio at container spawn time.
# That volume is populated by the `factorio-client-init` compose service from
# the host dir `plugins/factorio/factorio-client/`. Keeps the image ~50MB
# instead of 1GB and avoids re-copy on every rebuild.

COPY launch.sh /app/launch.sh
RUN chmod +x /app/launch.sh
