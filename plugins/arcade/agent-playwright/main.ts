// arcade plugin — Claude-driven playwright agent.
//
// Drives the Chromium pinned to workspace 2 of the arcade stream-client via
// the embedded fastify control server (port 8731 — same shape as the
// playwright-browser plugin). Reads TASK_HINT from its container env; that
// string is whatever the viewer typed into the Send-task box. If empty we
// fall back to a generic "browse a few news feeds" prompt so the workspace
// is never visually dead.
//
// Like the desktop agent, we keep tool calls atomic: each Claude tool_use
// becomes one fastify POST, the result is JSON-stringified back into a
// tool_result block. We also post kind:"tool" and kind:"page_content"
// events to the broker on every action so the vtuber narrator has material.

import Anthropic from "@anthropic-ai/sdk";

const {
  ENV_HOST,
  API_PORT = "8731",
  ANTHROPIC_API_KEY,
  MODEL = "claude-sonnet-4-5-20250929",
  SESSION_ID = "unknown",
  BROKER_URL = "http://broker:8080",
  BROKER_API_KEY = "",
  TASK_HINT = "",
} = process.env;

if (!ENV_HOST || !ANTHROPIC_API_KEY) {
  console.error("[pw-agent] ENV_HOST and ANTHROPIC_API_KEY are required");
  process.exit(1);
}

const BASE = `http://${ENV_HOST}:${API_PORT}`;
const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const FALLBACK_TASK =
  "Take a quick tour of three news sites you find interesting. Navigate to each, " +
  "scroll to skim headlines, click into one story per site, then move on. " +
  "Aim to finish in ~10 steps.";

const TASK = (TASK_HINT.trim() || FALLBACK_TASK);

// ---------- broker event log (fire-and-forget) ----------

function postEvent(kind: string, fields: Record<string, unknown> = {}): void {
  const event = { t: Date.now() / 1000, kind, ...fields };
  fetch(`${BROKER_URL}/api/sessions/${SESSION_ID}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(BROKER_API_KEY ? { Authorization: `Bearer ${BROKER_API_KEY}` } : {}),
    },
    body: JSON.stringify(event),
  }).catch(() => {});
}

// ---------- fastify control server client ----------

interface PwResult {
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
}

async function pw(path: string, body: unknown = {}, method = "POST"): Promise<PwResult> {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!r.ok) {
      return { ok: false, status: r.status, data, error: `${r.status} ${text.slice(0, 300)}` };
    }
    return { ok: true, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e) };
  }
}

// Find or create a fastify session. The arcade stream-client's launch.sh
// triggers an initial /session at startup, so usually we'll just adopt that.
async function ensureSession(): Promise<string> {
  const list = await pw("/sessions", undefined, "GET");
  if (list.ok && list.data && Array.isArray((list.data as { sessions?: unknown[] }).sessions)) {
    const sessions = (list.data as { sessions: { id: string }[] }).sessions;
    if (sessions.length > 0 && sessions[0]?.id) return sessions[0].id;
  }
  const created = await pw("/session", {});
  if (!created.ok) throw new Error(`createSession: ${created.error}`);
  return (created.data as { id: string }).id;
}

// ---------- Claude tools ----------

const TOOLS: Anthropic.Tool[] = [
  {
    name: "navigate",
    description: "Load a URL in the browser. Use full https URLs.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to load" } },
      required: ["url"],
    },
  },
  {
    name: "scroll",
    description:
      "Scroll the page. direction is up|down|left|right. amount is pixels (default = one viewport).",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number" },
      },
    },
  },
  {
    name: "click",
    description:
      "Click an element. Provide either `ref` (from a prior snapshot) OR `selector` (CSS).",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        selector: { type: "string" },
      },
    },
  },
  {
    name: "type",
    description:
      "Type text into a focused/input element. ref or selector to target it. Set submit=true to press Enter after.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean" },
        clear: { type: "boolean" },
      },
      required: ["text"],
    },
  },
  {
    name: "press_key",
    description: "Press a single keyboard key (e.g. 'Enter', 'Escape', 'PageDown').",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "back",
    description: "Browser back button.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "snapshot",
    description:
      "Returns the page's current accessibility-tree snapshot — title, URL, list of interactive elements with their refs you can use for click/type. Call this before clicking unfamiliar pages.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "page_digest",
    description:
      "Returns a compact text digest of the current page (headings, leading paragraphs, headline links). Use this to read the page like a human would.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "wait",
    description: "Sleep for a number of milliseconds (use to let pages settle).",
    input_schema: {
      type: "object",
      properties: { ms: { type: "number" } },
      required: ["ms"],
    },
  },
  {
    name: "finish",
    description: "Call when the task is complete. The agent loop will stop.",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string" } },
    },
  },
];

const SYSTEM = [
  "You're an AI driving a real Chromium browser, live on stream. The viewer can",
  "see what you click. Be deliberate, narrate via your tool calls.",
  "",
  "Loop pattern: navigate → snapshot → page_digest → scroll/click/type → repeat.",
  "Always snapshot before clicking on a new page so refs are fresh. Don't",
  "fabricate refs you haven't seen. If an action fails, read the error, try",
  "a different selector, then move on rather than retrying forever.",
  "",
  "Stop when the task is done by calling `finish`. You have ~40 steps total.",
].join(" ");

// ---------- main loop ----------

async function main() {
  postEvent("agent_start", { task: TASK, model: MODEL });
  console.log(`[pw-agent] task: ${TASK.slice(0, 200)}`);

  const sid = await ensureSession();
  console.log(`[pw-agent] using fastify session ${sid}`);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Task: ${TASK}` },
  ];

  const MAX_STEPS = 40;
  for (let step = 1; step <= MAX_STEPS; step++) {
    let resp: Anthropic.Message;
    try {
      resp = await claude.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM,
        tools: TOOLS,
        messages,
      });
    } catch (e) {
      console.error(`[pw-agent] step ${step} claude error: ${e}`);
      postEvent("agent_error", { step, error: String(e) });
      // Network blip / 529 — back off and retry once.
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const textBlocks = resp.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    for (const t of textBlocks) {
      if (t.text.trim()) postEvent("agent_text", { step, text: t.text.slice(0, 600) });
    }

    if (toolUses.length === 0 || resp.stop_reason === "end_turn") {
      console.log(`[pw-agent] step ${step}: no tools, stop_reason=${resp.stop_reason}`);
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const result = await runTool(sid, step, use);
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: result.text,
        is_error: result.isError,
      });
      if (use.name === "finish") {
        postEvent("agent_finish", { step, summary: (use.input as any)?.summary });
        return;
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  postEvent("agent_done", { reason: "max_steps" });
}

interface ToolOutcome {
  text: string;
  isError: boolean;
}

async function runTool(
  sid: string,
  step: number,
  use: Anthropic.ToolUseBlock,
): Promise<ToolOutcome> {
  const input = (use.input ?? {}) as Record<string, unknown>;
  let res: PwResult;

  switch (use.name) {
    case "navigate":
      res = await pw(`/session/${sid}/navigate`, { url: input.url });
      break;
    case "scroll":
      res = await pw(`/session/${sid}/scroll`, {
        direction: input.direction ?? "down",
        amount: input.amount,
      });
      break;
    case "click":
      res = await pw(`/session/${sid}/click`, {
        ref: input.ref,
        selector: input.selector,
      });
      break;
    case "type":
      res = await pw(`/session/${sid}/type`, {
        ref: input.ref,
        selector: input.selector,
        text: input.text,
        submit: input.submit,
        clear: input.clear,
      });
      break;
    case "press_key":
      res = await pw(`/session/${sid}/press_key`, { key: input.key });
      break;
    case "back":
      res = await pw(`/session/${sid}/back`);
      break;
    case "snapshot":
      res = await pw(`/session/${sid}/snapshot`);
      break;
    case "page_digest":
      res = await pw(`/session/${sid}/page_digest`);
      break;
    case "wait":
      res = await pw(`/session/${sid}/wait`, { ms: input.ms });
      break;
    case "finish":
      return { text: "ok", isError: false };
    default:
      return { text: `unknown tool ${use.name}`, isError: true };
  }

  // Mirror the existing playwright-browser agent's event shape so the
  // narrator's mood-hint catalog still matches.
  postEvent("tool", {
    step,
    name: use.name,
    input,
    error: res.ok ? undefined : res.error,
  });

  // Also push a page_content event after navigate / page_digest so the
  // narrator can ground its commentary in real headlines, not just URLs.
  if (use.name === "navigate" && res.ok) {
    pw(`/session/${sid}/page_digest`)
      .then((d) => {
        if (d.ok && d.data) postEvent("page_content", { step, ...(d.data as any) });
      })
      .catch(() => {});
  }
  if (use.name === "page_digest" && res.ok && res.data) {
    postEvent("page_content", { step, ...(res.data as any) });
  }

  if (!res.ok) {
    return { text: res.error ?? "request failed", isError: true };
  }
  // Trim large payloads (snapshots can be 10KB+) so we don't blow the context.
  const text = JSON.stringify(res.data ?? { ok: true });
  return { text: text.length > 8000 ? text.slice(0, 8000) + "…(truncated)" : text, isError: false };
}

main().catch((e) => {
  console.error("[pw-agent] fatal:", e);
  postEvent("agent_error", { error: String(e), fatal: true });
  process.exit(1);
});
