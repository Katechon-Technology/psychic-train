# psychic-train

A generalized "click a button, watch an AI do X" platform. Users browse a catalog of
**kinds** (environments + agents), click Watch, and get a live HLS stream of a freshly
spawned container running the agent inside it.

Design principle — same as [claudetorio](../claudetorio/): decouple cheap simulation
from GPU-backed rendering. A *kind* is a plugin. Each plugin ships a manifest pointing at
three container images (environment, agent, stream-client) plus port/env/healthcheck
config. The broker reads those manifests at startup; there is no kind-specific code in
the broker.

## v1 kinds

- **factorio** — Claude plays Factorio from scratch (ported from claudetorio).
- **playwright-browser** — Claude drives a headed Chromium via the
  [`playwright-browser`](../playwright-browser/) HTTP API, rendered under Xvfb and streamed.
- **minecraft** — Claude plays on a Fabric-loader Minecraft server (mirrored from
  [`cli-minecraft`](../cli-minecraft/)); the stream is a spectator bot rendered through
  prismarine-viewer in a Chromium kiosk.

## Quickstart (dev, local)

```bash
cd dev && docker compose up --build
# then http://localhost:3000
```

Before the minecraft plugin can start, populate
`plugins/minecraft/server/` with the Fabric launcher jar, world, and libraries —
see `plugins/minecraft/server/README.md`.

Before the factorio plugin can start, install a Factorio client into
`plugins/factorio/factorio-client/` (gitignored) — see `plugins/factorio/README.md`.

## Architecture

```
broker (FastAPI)
  ├── reads plugins/*/manifest.yaml at startup
  ├── POST /api/sessions {kind} → spawn env → healthcheck → spawn stream-client
  │                             → spawn agent → return stream_url
  └── GET /api/kinds, /api/sessions, /api/sessions/{id}

stream-agent (HTTP)
  └── spawns stream-client containers on the stream server (prod only; dev uses local docker)

stream-client-base (base image)
  └── Xvfb + openbox + ffmpeg(x11grab→HLS) + nginx serving /stream.m3u8

plugins/<kind>/
  ├── manifest.yaml     → image, env, ports, healthcheck, stream-client config
  ├── agent/            → Dockerfile + observe-think-act loop (Claude SDK)
  ├── environment/      → Dockerfile for the env (if topology=separate)
  └── stream-client/    → Dockerfile FROM stream-client-base + launch.sh
```

See `/home/user/.claude/plans/we-have-all-of-sorted-kettle.md` for the full design.
