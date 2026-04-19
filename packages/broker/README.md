# broker

FastAPI service that orchestrates psychic-train sessions. Reads
`plugins/*/manifest.yaml` at startup into an in-memory registry, exposes REST endpoints
to list kinds and manage sessions, and spawns containers via `docker run` (direct or
via `stream-agent` HTTP).

## Run locally

```bash
uv sync
PLUGINS_DIR=../../plugins BROKER_ADMIN_KEY=dev \
  uv run uvicorn main:app --reload --port 8080
```

## Routes

- `GET  /api/health` — liveness
- `GET  /api/status` — loaded kinds + redis status
- `GET  /api/kinds` — list kinds with active-session counts
- `GET  /api/kinds/{name}` — single kind
- `GET  /api/sessions` — list sessions (filters: `status`, `kind`, `limit`)
- `GET  /api/sessions/{id}` — single session
- `POST /api/sessions` (admin) — body `{"kind": "<name>"}`; returns a `SessionInfo` in
  `status=queued`. Allocation + container spawns happen in a background task; poll the
  GET endpoint until `status=running` and `stream_url` is populated.
- `DELETE /api/sessions/{id}` (admin) — teardown

## Flow inside `spawn_session`

1. Allocate a slot from Redis set `slots:{kind}` (pre-populated at startup).
2. Build template context: `{slot, session_id, env_host, broker_url, broker_api_key,
   rcon_password, anthropic_api_key, model, <port_name>_port …}`.
3. If `topology=separate`, `docker run` the environment image, wait for the manifest's
   healthcheck.
4. `docker run` the stream-client image (or POST to stream-agent), wait for port 3000.
5. `docker run` the agent image with interpolated env + broker-injected env.
6. Flip session to `running`, record `stream_url`.
7. Background monitor awaits agent exit and calls `teardown_session`.
