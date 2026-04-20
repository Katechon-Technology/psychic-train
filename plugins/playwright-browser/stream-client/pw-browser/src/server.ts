import Fastify from "fastify";
import { z } from "zod";
import {
  closeSession,
  config,
  createSession,
  getSession,
  listSessions,
  shutdown,
  type Session,
} from "./browser.ts";

const PORT = Number(process.env.PORT ?? 8731);
const HOST = process.env.HOST ?? "127.0.0.1";

const app = Fastify({ logger: { level: "info" } });

// ---------- helpers ----------

function requireSession(id: string): Session {
  const s = getSession(id);
  if (!s) {
    const err: any = new Error(`session not found: ${id}`);
    err.statusCode = 404;
    throw err;
  }
  return s;
}

async function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): Promise<z.infer<T>> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const err: any = new Error("bad request: " + r.error.message);
    err.statusCode = 400;
    throw err;
  }
  return r.data;
}

async function targetLocator(s: Session, sel: { ref?: string; selector?: string }) {
  if (sel.ref) return s.snapshot.locator(sel.ref);
  if (sel.selector) return s.page.locator(sel.selector).first();
  const err: any = new Error("must provide ref or selector");
  err.statusCode = 400;
  throw err;
}

// ---------- session lifecycle ----------

app.post("/session", async (req) => {
  const body = await parse(z.object({ trace: z.boolean().optional() }), req.body);
  const s = await createSession({ trace: body.trace });
  return { id: s.id, dir: s.dir, trace: s.trace };
});

app.delete("/session/:id", async (req) => {
  const { id } = req.params as { id: string };
  await closeSession(id);
  return { ok: true };
});

app.get("/sessions", async () => ({ sessions: listSessions() }));

app.get("/health", async () => ({ ok: true, profile: config.PROFILE_DIR }));

// ---------- browsing ----------

app.post("/session/:id/navigate", async (req) => {
  const s = requireSession((req.params as any).id);
  const { url, waitUntil } = await parse(
    z.object({
      url: z.string().url(),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
    }),
    req.body,
  );
  return s.recorder.record(s.page, "navigate", { url }, async () => {
    await s.page.goto(url, { waitUntil: waitUntil ?? "domcontentloaded" });
    return { url: s.page.url(), title: await s.page.title().catch(() => "") };
  });
});

app.post("/session/:id/back", async (req) => {
  const s = requireSession((req.params as any).id);
  return s.recorder.record(s.page, "back", null, async () => {
    await s.page.goBack({ waitUntil: "domcontentloaded" });
    return { url: s.page.url() };
  });
});

app.post("/session/:id/forward", async (req) => {
  const s = requireSession((req.params as any).id);
  return s.recorder.record(s.page, "forward", null, async () => {
    await s.page.goForward({ waitUntil: "domcontentloaded" });
    return { url: s.page.url() };
  });
});

// ---------- snapshot / screenshot ----------

app.post("/session/:id/snapshot", async (req) => {
  const s = requireSession((req.params as any).id);
  return s.recorder.record(s.page, "snapshot", null, () => s.snapshot.build());
});

app.post("/session/:id/screenshot", async (req) => {
  const s = requireSession((req.params as any).id);
  const { fullPage, format } = await parse(
    z.object({
      fullPage: z.boolean().optional(),
      format: z.enum(["png", "jpeg"]).optional(),
    }),
    req.body,
  );
  return s.recorder.record(
    s.page,
    "screenshot",
    { fullPage, format },
    async () => {
      const buf = await s.page.screenshot({
        fullPage: !!fullPage,
        type: format ?? "png",
      });
      return { format: format ?? "png", base64: buf.toString("base64"), bytes: buf.length };
    },
    { skipScreenshot: true },
  );
});

// ---------- interactions ----------

app.post("/session/:id/click", async (req) => {
  const s = requireSession((req.params as any).id);
  const args = await parse(
    z.object({
      ref: z.string().optional(),
      selector: z.string().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
      doubleClick: z.boolean().optional(),
    }),
    req.body,
  );
  return s.recorder.record(s.page, "click", args, async () => {
    const loc = await targetLocator(s, args);
    if (args.doubleClick) await loc.dblclick({ button: args.button ?? "left" });
    else await loc.click({ button: args.button ?? "left" });
    return { ok: true };
  });
});

app.post("/session/:id/type", async (req) => {
  const s = requireSession((req.params as any).id);
  const args = await parse(
    z.object({
      ref: z.string().optional(),
      selector: z.string().optional(),
      text: z.string(),
      submit: z.boolean().optional(),
      clear: z.boolean().optional(),
    }),
    req.body,
  );
  return s.recorder.record(s.page, "type", args, async () => {
    const loc = await targetLocator(s, args);
    if (args.clear) await loc.fill("");
    await loc.fill(args.text);
    if (args.submit) await loc.press("Enter");
    return { ok: true };
  });
});

app.post("/session/:id/press_key", async (req) => {
  const s = requireSession((req.params as any).id);
  const args = await parse(z.object({ key: z.string() }), req.body);
  return s.recorder.record(s.page, "press_key", args, async () => {
    await s.page.keyboard.press(args.key);
    return { ok: true };
  });
});

app.post("/session/:id/scroll", async (req) => {
  const s = requireSession((req.params as any).id);
  const args = await parse(
    z.object({
      direction: z.enum(["up", "down", "left", "right"]).optional(),
      amount: z.number().optional(), // pixels; default = viewport height
    }),
    req.body,
  );
  return s.recorder.record(s.page, "scroll", args, async () => {
    const dir = args.direction ?? "down";
    const v = await s.page.viewportSize();
    const baseY = v?.height ?? 800;
    const baseX = v?.width ?? 1280;
    const dx = dir === "left" ? -(args.amount ?? baseX) : dir === "right" ? (args.amount ?? baseX) : 0;
    const dy = dir === "up" ? -(args.amount ?? baseY) : dir === "down" ? (args.amount ?? baseY) : 0;
    await s.page.mouse.wheel(dx, dy);
    return { dx, dy };
  });
});

app.post("/session/:id/wait", async (req) => {
  const s = requireSession((req.params as any).id);
  const args = await parse(
    z.object({
      ms: z.number().optional(),
      selector: z.string().optional(),
      ref: z.string().optional(),
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      timeout: z.number().optional(),
    }),
    req.body,
  );
  return s.recorder.record(s.page, "wait", args, async () => {
    if (args.ms) await s.page.waitForTimeout(args.ms);
    if (args.selector || args.ref) {
      const loc = await targetLocator(s, args);
      await loc.waitFor({ state: args.state ?? "visible", timeout: args.timeout ?? 30000 });
    }
    return { ok: true };
  });
});

app.post("/session/:id/evaluate", async (req) => {
  const s = requireSession((req.params as any).id);
  const args = await parse(z.object({ expression: z.string() }), req.body);
  return s.recorder.record(s.page, "evaluate", args, async () => {
    // wrap in async IIFE so users can write either an expression or statements with `return`
    const result = await s.page.evaluate(`(async () => { ${args.expression} })()`);
    return { result };
  });
});

// ---------- error handler ----------

app.setErrorHandler((err: any, _req, reply) => {
  const status = err?.statusCode ?? 500;
  reply.status(status).send({ error: err?.message ?? String(err) });
});

// ---------- start ----------

await app.listen({ host: HOST, port: PORT });
app.log.info({ profile: config.PROFILE_DIR, sessions: config.SESSIONS_ROOT }, "ready");

const stop = async () => {
  app.log.info("shutting down");
  await shutdown();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
