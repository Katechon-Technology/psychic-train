# dev stack

```bash
cd dev
cp .env.example .env     # fill in ANTHROPIC_API_KEY (+ ELEVENLABS_API_KEY for TTS)
# 1. Build the stream-client base first (other images FROM it).
docker compose --profile build build stream-client-base
# 2. Build the vtuber-overlay base (used when narration is enabled for a kind).
docker compose --profile build build vtuber-overlay
# 3. Build every plugin's images.
docker compose --profile build build
# 4. One-shot: seed the minecraft server volume from plugins/minecraft/server/
docker compose --profile init run --rm minecraft-server-init
# 5. Start the long-lived services.
docker compose up -d postgres redis broker frontend
```

Open http://localhost:3000 and pick a kind.

## Teardown

Broker-spawned containers live outside docker-compose, so reap them explicitly:

```bash
docker ps --filter name=env- --filter name=agent- \
          --filter name=stream-client- --filter name=vtuber- -q \
  | xargs -r docker rm -f
docker volume ls --filter name=session-logs- -q | xargs -r docker volume rm
docker compose down -v
```

## VTuber overlay

Every kind in `plugins/*/manifest.yaml` has a `narration:` block enabled by default.
For each session:

- the plugin stream-client runs inside the docker network with no host port
- a `vtuber-{kind}-{slot}` container spins up with the Live2D avatar and the
  narrator sidecar, consumes the plugin's private HLS, and is what you actually
  connect to on `localhost:3003+slot`
- a `session-logs-{id}` docker volume is mounted into the agent (write) and the
  vtuber (read-only); the agent appends one JSONL line per event; the narrator
  tails it and speaks via ElevenLabs

If you don't have an `ELEVENLABS_API_KEY`, the stream still plays — the avatar just
won't have a natural voice. If you want to skip the overlay entirely for a kind,
delete its `narration:` block from the manifest.

## Before each kind can run

- **factorio**: populate `plugins/factorio/factorio-client/` with a Factorio 1.1.110
  client install (see `plugins/factorio/README.md`), then rebuild
  `factorio-stream-client`.
- **minecraft**: populate `plugins/minecraft/server/` with the Fabric launcher JAR and
  let it generate `world/` on first run (see `plugins/minecraft/README.md`), then
  re-run `minecraft-server-init` to copy into the volume.
- **playwright-browser**: no extra setup; Chromium is bundled into the image.
