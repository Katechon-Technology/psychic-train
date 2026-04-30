// Arcade control server.
//
// Runs inside the arcade stream-client container under the same Xvfb display
// that ffmpeg is encoding. Two responsibilities:
//
//   POST /workspace/switch  { workspace: 0|1|2 }   → wmctrl -s N
//   POST /tasks/:kind       { task: string }       → writes /tmp/arcade-tasks/<kind>.txt
//
// The broker normally drives /workspace/switch via `docker exec wmctrl -s N`
// directly (see broker app/services/environment.py:workspace_switch). This
// server exists as a recoverable HTTP entry point that is also useful for
// local debugging without docker exec.
//
// /tasks/<kind> is a passthrough: the broker writes a free-text task hint
// here and the corresponding agent (mineflayer or playwright) can poll for it
// later. v1 doesn't do that polling — the agent reads TASK_HINT from its
// container env at start — but the file mechanism is simple enough that it
// costs nothing to keep around.

import { execa } from "execa";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import { z } from "zod";

const HOST = process.env.HOST ?? process.env.CTRL_HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? process.env.CTRL_PORT ?? "8780");
const TASK_DIR = "/tmp/arcade-tasks";

const app = Fastify({ logger: { level: "info" } });

const switchSchema = z.object({ workspace: z.number().int().min(0).max(31) });
const taskSchema = z.object({ task: z.string().min(0).max(4000) });

app.get("/health", async () => ({
  ok: true,
  display: process.env.DISPLAY ?? ":1",
}));

app.post("/workspace/switch", async (req, reply) => {
  const r = switchSchema.safeParse(req.body ?? {});
  if (!r.success) {
    reply.code(400);
    return { error: r.error.message };
  }
  const { workspace } = r.data;
  try {
    await execa("wmctrl", ["-s", String(workspace)], {
      env: { DISPLAY: process.env.DISPLAY ?? ":1" },
    });
    return { ok: true, workspace };
  } catch (e: unknown) {
    reply.code(500);
    return { error: String(e) };
  }
});

app.post("/tasks/:kind", async (req, reply) => {
  const kind = (req.params as { kind: string }).kind;
  if (!/^[a-z0-9_-]{1,32}$/.test(kind)) {
    reply.code(400);
    return { error: "invalid kind" };
  }
  const r = taskSchema.safeParse(req.body ?? {});
  if (!r.success) {
    reply.code(400);
    return { error: r.error.message };
  }
  await mkdir(TASK_DIR, { recursive: true });
  await writeFile(join(TASK_DIR, `${kind}.txt`), r.data.task, "utf8");
  return { ok: true, kind, bytes: r.data.task.length };
});

await app.listen({ host: HOST, port: PORT });
app.log.info(`arcade control server listening on ${HOST}:${PORT}`);
