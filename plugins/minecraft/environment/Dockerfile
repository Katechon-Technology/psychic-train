FROM eclipse-temurin:21-jre-jammy

WORKDIR /srv/minecraft

# The server binary (fabric-server-*.jar) and world data are mounted from a shared
# Docker volume populated by the `minecraft-server-init` compose service from
# `plugins/minecraft/server/` on the host.

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 25565
CMD ["/entrypoint.sh"]
