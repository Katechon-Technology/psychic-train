// playwright-browser plugin agent.
//
// Loop: ask Claude what to do; Claude picks a browser tool; we call the
// playwright-browser HTTP API at $ENV_HOST:$API_PORT; we feed the result back.
// Stops when Claude sends a stop_reason="end_turn" without any tool use, or after
// MAX_STEPS.

import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const {
  ENV_HOST,
  API_PORT,
  ANTHROPIC_API_KEY,
  MODEL = "claude-sonnet-4-5-20250929",
  INITIAL_GOAL = "Browse wikipedia.org for a minute.",
  SESSION_ID = "unknown",
  SESSION_LOG_PATH = "/var/log/session/agent.jsonl",
} = process.env;

if (!ENV_HOST || !API_PORT || !ANTHROPIC_API_KEY) {
  console.error("missing ENV_HOST / API_PORT / ANTHROPIC_API_KEY");
  process.exit(1);
}

const BASE = `http://${ENV_HOST}:${API_PORT}`;
const MAX_STEPS = 40;

// Shared-volume JSONL log the narrator tails. Safe no-op if the directory isn't
// mounted (narration disabled for this kind).
function log(kind: string, fields: Record<string, unknown> = {}): void {
  try {
    mkdirSync(dirname(SESSION_LOG_PATH), { recursive: true });
    appendFileSync(
      SESSION_LOG_PATH,
      JSON.stringify({ t: Date.now() / 1000, kind, ...fields }) + "\n",
    );
  } catch {
    // ignore
  }
}

type ToolResult = { ok: boolean; data?: any; error?: string };

async function pwCall(path: string, body: unknown = {}): Promise<ToolResult> {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) return { ok: false, error: `${r.status} ${JSON.stringify(data)}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function createSession(): Promise<string> {
  const r = await fetch(`${BASE}/session`, { method: "POST" });
  const body = await r.json();
  return body.id;
}

// Tool schemas for Claude — keep small; one action per step.
const tools: Anthropic.Tool[] = [
  {
    name: "navigate",
    description: "Navigate the browser to a URL. Returns a snapshot of interactive elements on the page.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Fully-qualified URL" } },
      required: ["url"],
    },
  },
  {
    name: "snapshot",
    description: "Get an accessibility-tree snapshot of the current page — lists clickable elements with refs.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "click",
    description: "Click an element by its ref from the last snapshot.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
    },
  },
  {
    name: "type",
    description: "Type text into an input element by ref.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string" }, text: { type: "string" } },
      required: ["ref", "text"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the page. direction='down'|'up'|'left'|'right'.",
    input_schema: {
      type: "object",
      properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] } },
      required: ["direction"],
    },
  },
  {
    name: "wait",
    description: "Wait for N seconds so the user can observe the page.",
    input_schema: {
      type: "object",
      properties: { seconds: { type: "number" } },
      required: ["seconds"],
    },
  },
];

async function dispatchTool(sid: string, name: string, input: any): Promise<string> {
  switch (name) {
    case "navigate":
      return JSON.stringify((await pwCall(`/session/${sid}/navigate`, { url: input.url })).data ?? {});
    case "snapshot":
      return JSON.stringify((await pwCall(`/session/${sid}/snapshot`)).data ?? {});
    case "click":
      return JSON.stringify((await pwCall(`/session/${sid}/click`, { ref: input.ref })).data ?? {});
    case "type":
      return JSON.stringify((await pwCall(`/session/${sid}/type`, input)).data ?? {});
    case "scroll":
      return JSON.stringify((await pwCall(`/session/${sid}/scroll`, input)).data ?? {});
    case "wait":
      await new Promise((r) => setTimeout(r, Math.min(60, Number(input.seconds) || 1) * 1000));
      return `waited ${input.seconds}s`;
    default:
      return `unknown tool: ${name}`;
  }
}

async function main() {
  console.log(`[agent] session=${SESSION_ID}; base=${BASE}`);
  log("session_start", { session_id: SESSION_ID, base: BASE });
  // Wait for the playwright-browser server to be reachable.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/sessions`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }

  const sid = await createSession();
  console.log(`[agent] created browser session ${sid}`);
  log("browser_session_ready", { browser_session: sid });

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY! });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: INITIAL_GOAL }];
  const system =
    "You are a research assistant driving a web browser. Call one tool at a time. After each tool result, decide the next step. Stop when you've completed the goal.";

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.messages.create({
      model: MODEL!,
      max_tokens: 1024,
      system,
      messages,
      tools,
    });

    messages.push({ role: "assistant", content: res.content });

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      console.log("[agent] no more tool calls; exiting");
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const out = await dispatchTool(sid, tu.name, tu.input as any);
      console.log(`[agent] step=${step} tool=${tu.name} input=${JSON.stringify(tu.input)} -> ${out.slice(0, 200)}`);
      log("tool", { step, name: tu.name, input: tu.input, result: out.slice(0, 500) });
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: out });
    }
    messages.push({ role: "user", content: toolResults });
  }

  await fetch(`${BASE}/session/${sid}`, { method: "DELETE" }).catch(() => {});
  log("session_end", { reason: "agent_complete" });
  console.log("[agent] done");
}

main().catch((e) => {
  console.error("[agent] fatal:", e);
  process.exit(1);
});
