# playwright-browser plugin

Wraps [`../../../playwright-browser`](../../../playwright-browser/) as a psychic-train
kind.

**Topology: combined** — unlike Factorio/Minecraft where the environment and the
stream-client are separate containers, here the thing being driven (Chromium rendered
under Xvfb) is also the thing being captured. So the stream-client container bundles
the playwright-browser Fastify server and launches it as `/app/launch.sh`. The agent
container runs separately and HTTP-calls the API at `$ENV_HOST:$API_PORT/session/...`.

## Building

The stream-client Dockerfile copies the upstream playwright-browser TypeScript source
from `../../../playwright-browser/` at build time. Run `docker compose build` from
`dev/` — it will build the deps automatically.

## Agent

v1 ships a tiny Claude-tools loop that exposes `navigate`, `snapshot`, `click`, `type`,
`screenshot`, and `wait` tools to Claude and runs until the conversation ends. See
`agent/main.ts` and the upstream MCP shim at
`../../../playwright-browser/mcp-shim/index.ts` for the full tool schema.
