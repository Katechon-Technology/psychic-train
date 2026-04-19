# Factorio plugin

Ports claudetorio's Factorio setup into a psychic-train kind.

- **Environment**: `factoriotools/factorio:1.1.110` (public image).
- **Stream-client**: `FROM stream-client-base` + the Factorio GUI client. Launches
  `factorio --mp-connect $SERVER_HOST:$SERVER_PORT` under Xvfb; FFmpeg grabs the X
  display and encodes HLS.
- **Agent**: Python loop that connects to the server over RCON and drives it. The v1
  stub just idles; the full FLE-based observe-think-act loop lives in
  `/home/user/code/projects/randos/katechon/claudetorio/packages/run-worker/main.py`
  and `.../packages/fle/` — port it here when ready.

## Setup: populate the Factorio client

The Factorio GUI client is proprietary and gitignored. Download Factorio 1.1.110
headless + client archives and extract into `plugins/factorio/factorio-client/`. The
stream-client Dockerfile copies this directory at build time:

```
plugins/factorio/
└── factorio-client/          # gitignored
    ├── bin/x64/factorio
    ├── data/
    └── ... (rest of Factorio install)
```

Alternatively, mirror claudetorio's pattern: mount `factorio-client/` as a shared
Docker volume via `factorio-client-init` compose service instead of baking it into
the image.
