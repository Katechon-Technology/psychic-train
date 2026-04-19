# stream-agent

HTTP service the broker calls to spawn stream-client containers on a separate stream
server. In dev, the broker spawns them directly via `docker run` and skips stream-agent
entirely (set `STREAM_AGENT_URL=""`). In prod, set `STREAM_AGENT_URL=http://stream-server:8090`
on the broker and stream-agent handles docker runs on the stream host.

Kind-agnostic: the broker sends `{container_name, image, host_port, env, network,
volumes}` in the spawn request; stream-agent just runs docker.

## Endpoints

- `GET  /health`
- `POST /spawn/stream-client` (`X-Stream-Agent-Key` required)
- `DELETE /containers/{name}` (same auth)

## Env vars

- `STREAM_AGENT_KEY` — shared secret with broker
- `DOCKER_NETWORK` — default network name for spawned containers (broker can override
  per-request)
