# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

psychic-train is a generalized version of [claudetorio](../claudetorio/). Where
claudetorio only hosts Factorio, psychic-train hosts an arbitrary set of **kinds**
defined by per-plugin manifests. Users click a kind on the frontend, a session is
created, containers are spawned, and an HLS stream is returned.

Read `../claudetorio/CLAUDE.md` for the patterns this repo builds on — slot allocation,
port conventions, HLS streaming pipeline, broker structure — they all carry over.

## Key architectural differences vs. claudetorio

- **No Factorio-specific code in the broker.** `Run` is renamed `Session` with a `kind`
  column and a free-form `state` JSON blob. Every kind-specific field (Factorio's
  production score, Minecraft's blocks-placed, etc.) goes in `state`.
- **No replay for v1.** Only live streaming; no `stream-worker` container.
- **No scoring, leaderboards, OAuth, VTuber overlay, Twitch RTMP push.** Dropped from v1
  scope to reduce surface area.
- **Per-kind child stream-client images.** Base image at
  `packages/stream-client-base/` has Xvfb+ffmpeg+nginx; each plugin's
  `stream-client/Dockerfile` extends it with the kind-specific client binary and a
  `launch.sh` that the base entrypoint execs.
- **Manifests, not Python adapters.** A plugin author writes
  `plugins/<name>/manifest.yaml` and container images. They do not edit the broker.

## Manifest schema

Every plugin declares:

```yaml
name: <kind>
display_name: <str>
description: <str>
topology: separate | combined  # combined = stream-client IS the env

ports:
  - { name: <str>, protocol: tcp|udp, base: <int> }   # actual port = base + slot

environment:              # skipped when topology=combined
  image: <image>
  env: { KEY: "{template}" }
  volumes: [{ name: <volname>, mount: <path>, readonly: <bool> }]
  healthcheck: { type: tcp_port|http|rcon_command, port: "{port_name_port}", timeout_seconds: <int> }

agent:
  image: <image>
  env: { KEY: "{template}" }

stream_client:
  image: <image>
  display: { width: <int>, height: <int>, fps: <int> }
  env: { KEY: "{template}" }
```

Template variables the broker interpolates:
`{slot}`, `{session_id}`, `{env_host}`, `{broker_url}`, `{broker_api_key}`,
`{rcon_password}`, `{anthropic_api_key}`, `{model}`, and one `{<port_name>_port}` per
declared port.

## Common commands

```bash
# Full local stack
cd dev && docker compose up --build

# Broker only (no Docker)
cd packages/broker
uv sync && uv run uvicorn main:app --reload --port 8080

# Frontend only
cd packages/frontend
npm run dev     # :3000

# List kinds via API
curl http://localhost:8080/api/kinds

# Start a session
curl -X POST http://localhost:8080/api/sessions \
  -H "Authorization: Bearer $BROKER_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"kind":"factorio"}'
```

## Ports (dev defaults)

Every kind is free to pick its own `base` in its manifest `ports:` section (actual port =
`base + slot`). The stream-client HTTP port (where `/stream.m3u8` is served) is always
`STREAM_BASE_PORT + slot` (default `3003`), same as claudetorio, regardless of kind.

## Broker → plugin spawn order

1. Allocate a slot from `slots:<kind>` Redis set.
2. Load manifest; build template context from `{slot, session_id, env_host, ports…}`.
3. If `topology == separate`: `docker run` the `environment.image`; wait for healthcheck.
4. `docker run` the `stream_client.image` (local, or HTTP to `stream-agent` in prod).
   Wait for `/stream.m3u8` to exist.
5. `docker run` the `agent.image`, injecting `SESSION_ID`, `BROKER_URL`,
   `BROKER_API_KEY`, `MODEL`, `ANTHROPIC_API_KEY` on top of whatever the manifest
   declares.
6. Update session → `running`; return `stream_url`.

Teardown is the reverse, triggered when the agent container exits or
`session_timeout_checker` hits the configured TTL.

## Layout

```
psychic-train/
├── packages/
│   ├── broker/              # FastAPI + Postgres + Redis (reused from claudetorio)
│   ├── frontend/            # Next.js 16 (reused)
│   ├── stream-agent/        # HTTP container spawner (reused, parameterized by kind)
│   └── stream-client-base/  # Base Dockerfile: Xvfb + ffmpeg + nginx
├── plugins/
│   ├── factorio/            # Port of claudetorio (FLE + factorio-client)
│   ├── playwright-browser/  # Wraps ../playwright-browser as a kind
│   └── minecraft/           # Wraps ../cli-minecraft server + mineflayer bot
├── machines/
│   ├── game-server/         # broker + postgres + redis + frontend (docker-compose, NO nix)
│   └── stream-server/       # stream-agent + caddy
├── dev/
│   └── docker-compose.yml
└── .github/workflows/deploy.yml
```
