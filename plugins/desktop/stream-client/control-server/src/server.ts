// Desktop control server. The desktop plugin's stream-client image runs this
// Fastify app under the same Xvfb display ffmpeg is encoding for HLS, and the
// agent container POSTs every action against it: mouse, keyboard, windows,
// terminals, browser, fs.

import Fastify from "fastify";
import { z } from "zod";
import {
  mouseMove,
  mouseClick,
  mouseScroll,
  keyboardType,
  keyboardKey,
} from "./input.ts";
import {
  closeWindow,
  focusWindow,
  listWindows,
  moveWindow,
  tileWindows,
} from "./windows.ts";
import {
  execHeadless,
  killTerminal,
  listTerminals,
  readTerminalOutput,
  spawnTerminal,
} from "./terminals.ts";
import {
  clickTab,
  closeTab,
  digestTab,
  focusTab,
  listTabs,
  navigate,
  newTab,
  scrollTab,
  shutdown as shutdownBrowser,
  typeIntoTab,
} from "./browser.ts";
import { screenshotFullDisplay } from "./screenshot.ts";
import { fsList, fsOpen, fsRead, fsWrite } from "./fs_routes.ts";

const HOST = process.env.HOST ?? process.env.CTRL_HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? process.env.CTRL_PORT ?? "8780");

const app = Fastify({ logger: { level: "info" } });

async function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): Promise<z.infer<T>> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    throw Object.assign(new Error("bad request: " + r.error.message), { statusCode: 400 });
  }
  return r.data;
}

app.get("/health", async () => ({ ok: true, display: process.env.DISPLAY ?? ":1" }));

// ---------- screenshot ----------

app.post("/screenshot", async () => screenshotFullDisplay());

// ---------- mouse ----------

app.post("/mouse/move", async (req) => {
  const { x, y } = await parse(z.object({ x: z.number(), y: z.number() }), req.body);
  await mouseMove(x, y);
  return { ok: true };
});

app.post("/mouse/click", async (req) => {
  const args = await parse(
    z.object({
      x: z.number().optional(),
      y: z.number().optional(),
      button: z.number().int().min(1).max(5).optional(),
      double: z.boolean().optional(),
    }),
    req.body,
  );
  await mouseClick(args);
  return { ok: true };
});

app.post("/mouse/scroll", async (req) => {
  const args = await parse(
    z.object({ dy: z.number(), x: z.number().optional(), y: z.number().optional() }),
    req.body,
  );
  await mouseScroll(args.dy, args.x, args.y);
  return { ok: true };
});

// ---------- keyboard ----------

app.post("/keyboard/type", async (req) => {
  const { text, delay_ms } = await parse(
    z.object({ text: z.string(), delay_ms: z.number().optional() }),
    req.body,
  );
  await keyboardType(text, delay_ms);
  return { ok: true };
});

app.post("/keyboard/key", async (req) => {
  const { key } = await parse(z.object({ key: z.string() }), req.body);
  await keyboardKey(key);
  return { ok: true };
});

// ---------- windows ----------

app.post("/window/list", async () => ({ windows: await listWindows() }));

app.post("/window/focus", async (req) => {
  const args = await parse(
    z.object({ id: z.string().optional(), title_substring: z.string().optional() }),
    req.body,
  );
  await focusWindow(args);
  return { ok: true };
});

app.post("/window/move", async (req) => {
  const args = await parse(
    z.object({
      id: z.string().optional(),
      title_substring: z.string().optional(),
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
    }),
    req.body,
  );
  await moveWindow(args);
  return { ok: true };
});

app.post("/window/close", async (req) => {
  const args = await parse(
    z.object({ id: z.string().optional(), title_substring: z.string().optional() }),
    req.body,
  );
  await closeWindow(args);
  return { ok: true };
});

app.post("/window/tile", async (req) => {
  const args = await parse(
    z.object({
      layout: z.enum(["grid", "main_stack"]),
      ids: z.array(z.string()).optional(),
    }),
    req.body,
  );
  return tileWindows(args);
});

// ---------- terminals ----------

app.post("/terminal/spawn", async (req) => {
  const args = await parse(
    z.object({
      cmd: z.string(),
      cwd: z.string().optional(),
      title: z.string().optional(),
    }),
    req.body,
  );
  return spawnTerminal(args);
});

app.post("/terminal/exec", async (req) => {
  const args = await parse(
    z.object({
      cmd: z.string(),
      cwd: z.string().optional(),
      timeout_s: z.number().optional(),
    }),
    req.body,
  );
  return execHeadless(args);
});

app.get("/terminal", async () => ({ terminals: listTerminals() }));

app.get("/terminal/:id/output", async (req) => {
  const { id } = req.params as { id: string };
  return readTerminalOutput(id);
});

app.delete("/terminal/:id", async (req) => {
  const { id } = req.params as { id: string };
  await killTerminal(id);
  return { ok: true };
});

// ---------- browser ----------

app.post("/browser/tab/new", async (req) => {
  const { url } = await parse(z.object({ url: z.string() }), req.body);
  return newTab(url);
});

app.get("/browser/tab", async () => ({ tabs: listTabs() }));

app.delete("/browser/tab/:id", async (req) => {
  const { id } = req.params as { id: string };
  await closeTab(id);
  return { ok: true };
});

app.post("/browser/tab/:id/navigate", async (req) => {
  const { id } = req.params as { id: string };
  const { url } = await parse(z.object({ url: z.string() }), req.body);
  return navigate(id, url);
});

app.post("/browser/tab/:id/focus", async (req) => {
  const { id } = req.params as { id: string };
  await focusTab(id);
  return { ok: true };
});

app.post("/browser/tab/:id/scroll", async (req) => {
  const { id } = req.params as { id: string };
  const { dy } = await parse(z.object({ dy: z.number() }), req.body);
  await scrollTab(id, dy);
  return { ok: true };
});

app.post("/browser/tab/:id/click", async (req) => {
  const { id } = req.params as { id: string };
  const args = await parse(
    z.object({
      selector: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
    }),
    req.body,
  );
  await clickTab(id, args);
  return { ok: true };
});

app.post("/browser/tab/:id/type", async (req) => {
  const { id } = req.params as { id: string };
  const args = await parse(
    z.object({
      selector: z.string().optional(),
      text: z.string(),
      submit: z.boolean().optional(),
      clear: z.boolean().optional(),
    }),
    req.body,
  );
  await typeIntoTab(id, args);
  return { ok: true };
});

app.post("/browser/tab/:id/snapshot", async (req) => {
  const { id } = req.params as { id: string };
  return digestTab(id);
});

// ---------- fs ----------

app.post("/fs/write", async (req) => {
  const args = await parse(
    z.object({
      path: z.string(),
      text: z.string().optional(),
      content_b64: z.string().optional(),
    }),
    req.body,
  );
  return fsWrite(args);
});

app.post("/fs/read", async (req) => {
  const args = await parse(
    z.object({ path: z.string(), max_bytes: z.number().optional() }),
    req.body,
  );
  return fsRead(args);
});

app.post("/fs/list", async (req) => {
  const args = await parse(z.object({ path: z.string() }), req.body);
  return fsList(args);
});

app.post("/fs/open", async (req) => {
  const args = await parse(z.object({ path: z.string() }), req.body);
  await fsOpen(args);
  return { ok: true };
});

// ---------- error handler ----------

app.setErrorHandler((err: any, _req, reply) => {
  const status = err?.statusCode ?? 500;
  reply.status(status).send({ error: err?.message ?? String(err) });
});

// ---------- start ----------

await app.listen({ host: HOST, port: PORT });
app.log.info({ display: process.env.DISPLAY }, "desktop control server ready");

const stop = async () => {
  app.log.info("shutting down");
  await shutdownBrowser();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
