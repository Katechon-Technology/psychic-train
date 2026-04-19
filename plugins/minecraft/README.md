# Minecraft plugin

Three containers: a Fabric-loader 1.21.11 Minecraft server, a mineflayer-based
Claude agent bot, and a stream-client that runs a prismarine-viewer spectator bot in
a Chromium kiosk.

## The server directory (`server/`)

`plugins/minecraft/server/` mirrors the working server setup at
`/home/user/code/projects/randos/katechon/cli-minecraft/`. Like claudetorio's
`factorio-client/`, small text configs are committed and the
large/proprietary/generated files are gitignored.

**Committed** (safe to check in): `server.properties`, `eula.txt`,
`ops.json`, `whitelist.json`, `banned-*.json`, anything inside `mods/` that is your
own config, anything inside `config/` that isn't a vendor runtime dump.

**Gitignored** (populate yourself — see top-level `.gitignore`):
- `fabric-server-mc.<version>-loader.*.jar` — the Fabric launcher JAR
- `libraries/` — downloaded by Fabric on first run
- `versions/` — Minecraft JAR cache
- `world/`, `world_*/` — world data
- `logs/`, `*.log`, `.fabric/` — runtime logs
- `usercache.json`
- `node_modules/`

## How to populate

```bash
cd plugins/minecraft/server

# Download the Fabric loader JAR for Minecraft 1.21.11 (check loader/installer
# versions at https://fabricmc.net/use/server/).
wget https://meta.fabricmc.net/v2/versions/loader/1.21.11/0.19.2/1.1.1/server/jar \
     -O fabric-server-mc.1.21.11-loader.0.19.2-launcher.1.1.1.jar

# Accept the EULA (already committed but verify).
echo "eula=true" > eula.txt

# First run to download libraries/versions and generate the world.
java -jar fabric-server-mc.1.21.11-loader.0.19.2-launcher.1.1.1.jar nogui
# (stop when you see "Done (...)! For help, type...")
```

The environment container mounts this directory as a shared Docker volume (populated
on first boot by the `minecraft-server-init` service in `dev/docker-compose.yml`).

## Environment image

`environment/Dockerfile` provides a JRE-only Eclipse Temurin image; the server
contents come from the mounted volume. The container entrypoint just runs
`java -jar fabric-server-mc.*.jar nogui` from `/srv/minecraft`.

## Agent

`agent/main.mjs` runs a mineflayer bot that connects as `ClaudeBot` and asks Claude
for its next move each cycle. Tool format is simplified — see the file for details.
Structure borrowed from `../../../cli-minecraft/build-house.js`; decisions come from
Claude, not a hardcoded sequence.

## Stream-client

`stream-client/prismarine-viewer-bot.mjs` connects as a spectator bot named
`Spectator`, feeds the world into a `prismarine-viewer` HTTP server on port 3007, and
`launch.sh` opens Chromium in kiosk mode at `http://localhost:3007` inside the
Xvfb display. FFmpeg from the base image captures the Chromium window.
