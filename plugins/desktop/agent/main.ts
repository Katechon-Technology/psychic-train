// desktop plugin agent. A "director" Claude loop drives a full Linux desktop
// (browser, terminals, files, mouse/keyboard) via the control server's HTTP
// API. It can spawn in-process worker subagents — separate Claude threads
// with smaller token budgets and a slimmed-down toolset — to do focused
// research in parallel. The result is many windows updating at once, which
// is the manic "schizo" feel the plugin is going for.

import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";

const {
  ENV_HOST,
  CONTROL_PORT = "8780",
  ANTHROPIC_API_KEY,
  MODEL = "claude-sonnet-4-5-20250929",
  SESSION_ID = "unknown",
  BROKER_URL = "http://broker:8080",
  BROKER_API_KEY = "",
  TASK = "Pick a live Polymarket market and decide whether to bet YES or NO. Walk through the bet UI but stop before wallet connect.",
} = process.env;

if (!ENV_HOST || !ANTHROPIC_API_KEY) {
  console.error("[agent] ENV_HOST and ANTHROPIC_API_KEY are required");
  process.exit(1);
}

const BASE = `http://${ENV_HOST}:${CONTROL_PORT}`;
const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---------- broker event log (fire-and-forget) ----------

function log(kind: string, fields: Record<string, unknown> = {}): void {
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

// ---------- control server client ----------

interface CtrlResult {
  ok: boolean;
  status: number;
  data: any;
  error?: string;
}

async function ctrl(method: string, path: string, body?: unknown): Promise<CtrlResult> {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!r.ok) {
      return { ok: false, status: r.status, data, error: `${r.status} ${typeof data === "string" ? data : JSON.stringify(data)}` };
    }
    return { ok: true, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e) };
  }
}

const desktop = {
  screenshot: () => ctrl("POST", "/screenshot"),
  mouseMove: (x: number, y: number) => ctrl("POST", "/mouse/move", { x, y }),
  mouseClick: (a: any) => ctrl("POST", "/mouse/click", a),
  mouseScroll: (a: any) => ctrl("POST", "/mouse/scroll", a),
  keyboardType: (text: string, delay_ms?: number) => ctrl("POST", "/keyboard/type", { text, delay_ms }),
  keyboardKey: (key: string) => ctrl("POST", "/keyboard/key", { key }),
  windowList: () => ctrl("POST", "/window/list"),
  windowFocus: (a: any) => ctrl("POST", "/window/focus", a),
  windowTile: (a: any) => ctrl("POST", "/window/tile", a),
  windowMove: (a: any) => ctrl("POST", "/window/move", a),
  terminalSpawn: (a: any) => ctrl("POST", "/terminal/spawn", a),
  terminalExec: (a: any) => ctrl("POST", "/terminal/exec", a),
  terminalRead: (id: string) => ctrl("GET", `/terminal/${id}/output`),
  browserOpen: (url: string) => ctrl("POST", "/browser/tab/new", { url }),
  browserList: () => ctrl("GET", "/browser/tab"),
  browserNavigate: (id: string, url: string) => ctrl("POST", `/browser/tab/${id}/navigate`, { url }),
  browserFocus: (id: string) => ctrl("POST", `/browser/tab/${id}/focus`),
  browserScroll: (id: string, dy: number) => ctrl("POST", `/browser/tab/${id}/scroll`, { dy }),
  browserClick: (id: string, a: any) => ctrl("POST", `/browser/tab/${id}/click`, a),
  browserType: (id: string, a: any) => ctrl("POST", `/browser/tab/${id}/type`, a),
  browserSnapshot: (id: string) => ctrl("POST", `/browser/tab/${id}/snapshot`),
  fsWrite: (a: any) => ctrl("POST", "/fs/write", a),
  fsRead: (a: any) => ctrl("POST", "/fs/read", a),
  fsList: (a: any) => ctrl("POST", "/fs/list", a),
  fsOpen: (a: any) => ctrl("POST", "/fs/open", a),
};

// ---------- tool definitions (shared by director and workers) ----------

const DESKTOP_TOOLS = [
  {
    name: "desktop_screenshot",
    description:
      "Take a screenshot of the entire desktop. Returns a PNG image you'll see in the next turn. Use sparingly — it's expensive and you usually don't need it.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "desktop_mouse_click",
    description:
      "Click at absolute screen coordinates. Useful when you need to interact with native desktop UI (xterm, file manager). For browser content, prefer desktop_browser_click.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "number", description: "1=left, 2=middle, 3=right" },
        double: { type: "boolean" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "desktop_keyboard_type",
    description: "Type text into the currently-focused window/field.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" }, delay_ms: { type: "number" } },
      required: ["text"],
    },
  },
  {
    name: "desktop_keyboard_key",
    description:
      "Press a single key or chord. Examples: 'Return', 'Escape', 'ctrl+l', 'shift+Tab'.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "desktop_window_list",
    description: "List all top-level windows with their ids, titles, and positions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "desktop_window_focus",
    description: "Raise and focus a window by id or by a substring of its title.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title_substring: { type: "string" },
      },
    },
  },
  {
    name: "desktop_window_tile",
    description:
      "Auto-tile open windows. layout='grid' arranges them in a grid; 'main_stack' gives the first window 60% on the left and stacks the rest on the right.",
    input_schema: {
      type: "object",
      properties: { layout: { type: "string", enum: ["grid", "main_stack"] } },
      required: ["layout"],
    },
  },
  {
    name: "desktop_terminal_spawn",
    description:
      "Open a NEW xterm window running `cmd`. Use this for long-running commands the viewer should see (data crunching, model fits, scrapers). Returns a terminal id you can read output from.",
    input_schema: {
      type: "object",
      properties: {
        cmd: { type: "string" },
        title: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["cmd"],
    },
  },
  {
    name: "desktop_terminal_exec",
    description:
      "Run a shell command headlessly (no window) and return its captured output. Best for quick one-shot commands like `ls`, `cat`, `curl`, or quick python -c.",
    input_schema: {
      type: "object",
      properties: {
        cmd: { type: "string" },
        cwd: { type: "string" },
        timeout_s: { type: "number" },
      },
      required: ["cmd"],
    },
  },
  {
    name: "desktop_terminal_read",
    description: "Read the latest output from an xterm spawned by desktop_terminal_spawn.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "desktop_browser_open",
    description:
      "Open a new browser tab on the given URL. Returns a tab_id. The Chromium window is already open on the right side of the desktop; new tabs appear inside it.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "desktop_browser_navigate",
    description: "Navigate an existing tab to a URL.",
    input_schema: {
      type: "object",
      properties: { tab_id: { type: "string" }, url: { type: "string" } },
      required: ["tab_id", "url"],
    },
  },
  {
    name: "desktop_browser_focus",
    description: "Bring a tab to the front of the browser window.",
    input_schema: {
      type: "object",
      properties: { tab_id: { type: "string" } },
      required: ["tab_id"],
    },
  },
  {
    name: "desktop_browser_scroll",
    description: "Scroll a tab by `dy` pixels (positive=down, negative=up).",
    input_schema: {
      type: "object",
      properties: { tab_id: { type: "string" }, dy: { type: "number" } },
      required: ["tab_id", "dy"],
    },
  },
  {
    name: "desktop_browser_click",
    description:
      "Click an element in a tab — either by CSS selector, or by {x,y} viewport coordinates. Prefer selector when you can.",
    input_schema: {
      type: "object",
      properties: {
        tab_id: { type: "string" },
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["tab_id"],
    },
  },
  {
    name: "desktop_browser_type",
    description:
      "Fill or type into an input. With selector: fills that element. Without: types into whatever's currently focused. submit=true presses Enter after.",
    input_schema: {
      type: "object",
      properties: {
        tab_id: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean" },
        clear: { type: "boolean" },
      },
      required: ["tab_id", "text"],
    },
  },
  {
    name: "desktop_browser_snapshot",
    description:
      "Get a structured digest of the current page (title, headings, top links, leading paragraphs). Cheap text snapshot; use this to read pages instead of screenshots.",
    input_schema: {
      type: "object",
      properties: { tab_id: { type: "string" } },
      required: ["tab_id"],
    },
  },
  {
    name: "desktop_fs_write",
    description: "Write a text file under /workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        text: { type: "string" },
      },
      required: ["path", "text"],
    },
  },
  {
    name: "desktop_fs_read",
    description: "Read a text file from /workspace.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "desktop_fs_open",
    description:
      "Open a file in a viewer window (feh for images, xdg-open for everything else). Use this to display generated infographics on screen.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

const DIRECTOR_EXTRA_TOOLS = [
  {
    name: "spawn_worker",
    description:
      "Dispatch an in-process worker subagent to do focused work in parallel. role describes what kind of worker it is (e.g. 'researcher', 'analyst', 'designer'). brief is the natural-language task. Returns a worker_id immediately — use list_workers / collect_worker to track and collect results.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string" },
        brief: { type: "string" },
      },
      required: ["role", "brief"],
    },
  },
  {
    name: "list_workers",
    description: "List all dispatched workers and their statuses.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "collect_worker",
    description:
      "Wait for a worker to finish (up to ~60s) and return its final report. Returns immediately if the worker is already done.",
    input_schema: {
      type: "object",
      properties: { worker_id: { type: "string" } },
      required: ["worker_id"],
    },
  },
  {
    name: "think_aloud",
    description:
      "Surface a short narration line for the stream without taking any other action. Use sparingly — every other tool call already feeds the narrator.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

const WORKER_EXTRA_TOOLS = [
  {
    name: "final_report",
    description:
      "Submit your final findings to the director and stop. Call this once you have your answer.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

const DIRECTOR_TOOLS = [...DESKTOP_TOOLS, ...DIRECTOR_EXTRA_TOOLS];
const WORKER_TOOLS = [...DESKTOP_TOOLS, ...WORKER_EXTRA_TOOLS];

// ---------- worker registry ----------

interface Worker {
  id: string;
  role: string;
  brief: string;
  status: "running" | "done" | "error";
  report?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  promise: Promise<void>;
}

const workers = new Map<string, Worker>();

function spawnWorker(role: string, brief: string): { worker_id: string } {
  const id = "w-" + randomBytes(3).toString("hex");
  log("spawn_worker", { worker_id: id, role, brief: brief.slice(0, 240) });
  const w: Worker = {
    id,
    role,
    brief,
    status: "running",
    startedAt: Date.now(),
    promise: Promise.resolve(),
  };
  w.promise = (async () => {
    try {
      w.report = await runWorker(id, role, brief);
      w.status = "done";
    } catch (e: any) {
      w.error = e?.message ?? String(e);
      w.status = "error";
    } finally {
      w.endedAt = Date.now();
      log("worker_done", {
        worker_id: id,
        status: w.status,
        report: (w.report ?? w.error ?? "").slice(0, 500),
      });
    }
  })();
  workers.set(id, w);
  return { worker_id: id };
}

function listWorkersInfo(): Array<{
  id: string;
  role: string;
  status: string;
  age_s: number;
}> {
  const now = Date.now();
  return [...workers.values()].map((w) => ({
    id: w.id,
    role: w.role,
    status: w.status,
    age_s: Math.round((now - w.startedAt) / 1000),
  }));
}

async function collectWorker(id: string): Promise<{ status: string; text: string }> {
  const w = workers.get(id);
  if (!w) return { status: "unknown", text: `worker ${id} not found` };
  await Promise.race([
    w.promise,
    new Promise((res) => setTimeout(res, 60_000)),
  ]);
  if (w.status === "running") {
    return { status: "still_running", text: `worker ${id} still running after 60s — try again later` };
  }
  return {
    status: w.status,
    text: (w.status === "done" ? w.report : w.error) ?? "(no output)",
  };
}

// ---------- tool dispatch ----------

interface ToolReturn {
  text?: string;
  imageB64?: string; // when set, attach as an image content block
}

function summarize(v: unknown, cap = 1200): string {
  if (v == null) return "";
  if (typeof v === "string") return v.length > cap ? v.slice(0, cap) + "…" : v;
  const j = JSON.stringify(v);
  return j.length > cap ? j.slice(0, cap) + "…" : j;
}

async function runDesktopTool(name: string, input: any): Promise<ToolReturn> {
  switch (name) {
    case "desktop_screenshot": {
      const r = await desktop.screenshot();
      if (!r.ok) return { text: `error: ${r.error}` };
      return {
        imageB64: r.data?.png_b64,
        text: `screenshot ${r.data?.bytes ?? "?"}B`,
      };
    }
    case "desktop_mouse_click": {
      const r = await desktop.mouseClick(input);
      return { text: r.ok ? "clicked" : `error: ${r.error}` };
    }
    case "desktop_keyboard_type": {
      const r = await desktop.keyboardType(input.text, input.delay_ms);
      return { text: r.ok ? `typed ${input.text.length} chars` : `error: ${r.error}` };
    }
    case "desktop_keyboard_key": {
      const r = await desktop.keyboardKey(input.key);
      return { text: r.ok ? `key=${input.key}` : `error: ${r.error}` };
    }
    case "desktop_window_list": {
      const r = await desktop.windowList();
      return { text: summarize(r.data?.windows ?? r.data) };
    }
    case "desktop_window_focus": {
      const r = await desktop.windowFocus(input);
      return { text: r.ok ? "focused" : `error: ${r.error}` };
    }
    case "desktop_window_tile": {
      const r = await desktop.windowTile(input);
      return { text: r.ok ? `tiled ${r.data?.tiled ?? "?"} windows` : `error: ${r.error}` };
    }
    case "desktop_terminal_spawn": {
      const r = await desktop.terminalSpawn(input);
      return { text: r.ok ? `spawned terminal id=${r.data?.id}` : `error: ${r.error}` };
    }
    case "desktop_terminal_exec": {
      const r = await desktop.terminalExec(input);
      if (!r.ok) return { text: `error: ${r.error}` };
      const d = r.data ?? {};
      return {
        text: `exit=${d.exit_code}\nstdout:\n${summarize(d.stdout, 2000)}\nstderr:\n${summarize(d.stderr, 800)}`,
      };
    }
    case "desktop_terminal_read": {
      const r = await desktop.terminalRead(input.id);
      if (!r.ok) return { text: `error: ${r.error}` };
      return {
        text: `running=${r.data?.running} bytes=${r.data?.bytes}\n${summarize(r.data?.stdout_so_far, 2000)}`,
      };
    }
    case "desktop_browser_open": {
      const r = await desktop.browserOpen(input.url);
      return { text: r.ok ? `tab_id=${r.data?.tab_id}` : `error: ${r.error}` };
    }
    case "desktop_browser_navigate": {
      const r = await desktop.browserNavigate(input.tab_id, input.url);
      return { text: r.ok ? summarize(r.data) : `error: ${r.error}` };
    }
    case "desktop_browser_focus": {
      const r = await desktop.browserFocus(input.tab_id);
      return { text: r.ok ? "focused" : `error: ${r.error}` };
    }
    case "desktop_browser_scroll": {
      const r = await desktop.browserScroll(input.tab_id, input.dy);
      return { text: r.ok ? `scrolled dy=${input.dy}` : `error: ${r.error}` };
    }
    case "desktop_browser_click": {
      const { tab_id, ...rest } = input;
      const r = await desktop.browserClick(tab_id, rest);
      return { text: r.ok ? "clicked" : `error: ${r.error}` };
    }
    case "desktop_browser_type": {
      const { tab_id, ...rest } = input;
      const r = await desktop.browserType(tab_id, rest);
      return { text: r.ok ? `typed ${rest.text?.length ?? 0} chars` : `error: ${r.error}` };
    }
    case "desktop_browser_snapshot": {
      const r = await desktop.browserSnapshot(input.tab_id);
      return { text: summarize(r.data, 3000) };
    }
    case "desktop_fs_write": {
      const r = await desktop.fsWrite(input);
      return { text: r.ok ? `wrote ${r.data?.bytes}B to ${r.data?.path}` : `error: ${r.error}` };
    }
    case "desktop_fs_read": {
      const r = await desktop.fsRead(input);
      if (!r.ok) return { text: `error: ${r.error}` };
      return { text: summarize(r.data?.text, 3000) };
    }
    case "desktop_fs_open": {
      const r = await desktop.fsOpen(input);
      return { text: r.ok ? "opened" : `error: ${r.error}` };
    }
    default:
      return { text: `unknown desktop tool: ${name}` };
  }
}

// ---------- worker loop ----------

async function runWorker(workerId: string, role: string, brief: string): Promise<string> {
  const systemPrompt = `You are a ${role} worker subagent on a live desktop AI stream. The director has given you a focused task; do it and submit a final_report when done. Be quick, be concrete, be specific. Each turn, call ONE OR MORE tools. Do not narrate; the desktop's other components handle narration. When you have an answer, call final_report exactly once and stop.`;

  let messages: any[] = [
    { role: "user", content: `Your brief from the director:\n\n${brief}` },
  ];
  const MAX_STEPS = 25;

  for (let step = 0; step < MAX_STEPS; step++) {
    let res;
    try {
      res = await claude.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages,
        tools: WORKER_TOOLS as any,
      });
    } catch (e: any) {
      log("worker_claude_error", { worker_id: workerId, step, error: e?.message ?? String(e) });
      await sleep(3000);
      continue;
    }

    messages.push({ role: "assistant", content: res.content });

    const toolUses = res.content.filter((b: any) => b.type === "tool_use");
    if (toolUses.length === 0) {
      // no tool calls — assume worker is done; pull the last text block as the report
      const text = res.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
      return text || "(worker exited without a report)";
    }

    const toolResults: any[] = [];
    for (const tu of toolUses) {
      log("worker_tool", { worker_id: workerId, role, step, name: tu.name, input: summarize(tu.input, 240) });
      await dlog(`  ${workerId}/${role} step=${step} -> ${tu.name}(${summarize(tu.input, 160)})`);
      if (tu.name === "final_report") {
        const report = String((tu.input as any).text ?? "");
        await dlog(`  ${workerId}/${role} FINAL: ${report.slice(0, 240)}`);
        return report;
      }
      const out = await runDesktopTool(tu.name, tu.input);
      toolResults.push(buildToolResult(tu.id, out));
    }
    messages.push({ role: "user", content: toolResults });

    // light history trim
    if (step > 0 && step % 8 === 0 && messages.length > 16) {
      messages = trimMessages(messages, 14);
    }
  }
  return "(hit MAX_STEPS without a final_report)";
}

// ---------- director loop ----------

const SYSTEM_PROMPT = `You are the DIRECTOR of a small swarm of AI workers running on a full Linux desktop, live on stream. The user is watching every window. Your style is fast, parallel, and a little frantic — keep multiple things happening at once.

You have:
- A browser (multi-tab Chromium with uBlock Origin and Consent-O-Matic — open lots of tabs).
- A terminal (xterm) you can spawn (visible window) or run headlessly. Python 3, numpy/pandas/matplotlib, requests/bs4 are all preinstalled.
- A workspace at /workspace where you can write scripts, save data, and generate infographics (which you can then desktop_fs_open to display in a window).
- Workers — separate Claude threads you dispatch via spawn_worker. Use them aggressively for parallel research.

VISUAL STAGECRAFT IS A HARD REQUIREMENT, NOT A SUGGESTION. The viewer must see terminals AND the browser AND generated images, not just a browser. You will be judged on whether the stream looked busy across many windows, not on how thorough your browsing was.

Hard rules (failing any of these is failing the task):
- Use desktop_terminal_spawn (visible xterm) at least 4 times across the run. desktop_terminal_exec (headless) does NOT count — it produces no visible window.
- Generate at least one PNG infographic via matplotlib in a terminal and desktop_fs_open it.
- Dispatch at least 2 workers via spawn_worker (parallel research, not sequential).
- Call desktop_window_tile {layout:"grid"} at least once after windows are open, and again whenever the count has grown by 2+.
- Write to /workspace/scratch.log periodically (the second seed xterm is tailing it — the viewer sees lines appear there as you type them via desktop_fs_write or desktop_terminal_exec "echo ... >> /workspace/scratch.log").

Each turn, call MULTIPLE tools at once whenever the work is independent. Don't wait for one browser navigate to finish before opening the next tab. Don't wait for one worker before spawning the next.

If you find yourself only calling desktop_browser_* in a turn, STOP and add at least one terminal/fs/worker call to that same turn.

The user's task is at the start of the conversation. Stick to it. When you finish or run out of time, surface a clear final decision (think_aloud, then stop).`;

async function director(): Promise<void> {
  const seed = `Your task:\n\n${TASK}\n\nThe desktop boots with two filler xterms on the left and a Chromium window on the right. Don't rely on the filler — START by spawning your OWN visible xterms (desktop_terminal_spawn) doing real work, then desktop_window_tile {layout:"grid"} so the viewer can see everything at once. Keep the screen busy across MANY windows, not just the browser. Begin.`;
  let messages: any[] = [{ role: "user", content: seed }];
  const MAX_STEPS = 80;

  for (let step = 0; step < MAX_STEPS; step++) {
    let res;
    try {
      res = await claude.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages,
        tools: DIRECTOR_TOOLS as any,
      });
    } catch (e: any) {
      console.error(`[director] step=${step} claude error:`, e?.message ?? e);
      log("director_claude_error", { step, error: e?.message ?? String(e) });
      await dlog(`step=${step} CLAUDE ERROR: ${(e?.message ?? String(e)).slice(0, 200)}`);
      await sleep(5000);
      continue;
    }

    messages.push({ role: "assistant", content: res.content });

    const assistantText = res.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(" ")
      .trim();
    if (assistantText) {
      // Surface the director's free-form thinking on the live-log so the
      // viewer can read its reasoning as it goes.
      await dlog(`step=${step} DIRECTOR: ${assistantText.slice(0, 240)}`);
    }

    const toolUses = res.content.filter((b: any) => b.type === "tool_use");
    if (toolUses.length === 0) {
      log("director_idle", { step, text: assistantText.slice(0, 500) });
      await dlog(`step=${step} no tool calls; idling 6s`);
      console.log(`[director] step=${step} no tool calls; idling 6s`);
      await sleep(6000);
      continue;
    }

    // Run all tool calls for this turn in parallel — that's where the "many
    // things at once" feel comes from. Order is preserved in the tool_results.
    const results = await Promise.all(
      toolUses.map(async (tu: any): Promise<any> => {
        const inputStr = summarize(tu.input, 200);
        log("tool", { step, name: tu.name, input: summarize(tu.input, 240) });
        await dlog(`step=${step} -> ${tu.name}(${inputStr})`);
        let out: ToolReturn;
        try {
          if (tu.name === "spawn_worker") {
            const { worker_id } = spawnWorker(tu.input.role, tu.input.brief);
            await dlog(`step=${step}    spawned ${worker_id} role=${tu.input.role}`);
            out = { text: JSON.stringify({ worker_id }) };
          } else if (tu.name === "list_workers") {
            out = { text: JSON.stringify(listWorkersInfo()) };
          } else if (tu.name === "collect_worker") {
            const c = await collectWorker(tu.input.worker_id);
            log("collect_worker", { step, worker_id: tu.input.worker_id, status: c.status });
            await dlog(
              `step=${step}    collect ${tu.input.worker_id} [${c.status}] ${c.text.slice(0, 200)}`,
            );
            out = { text: `[${c.status}] ${c.text}` };
          } else if (tu.name === "think_aloud") {
            await dlog(`step=${step}    think: ${String(tu.input.text ?? "").slice(0, 240)}`);
            out = { text: "ok" };
          } else {
            out = await runDesktopTool(tu.name, tu.input);
          }
        } catch (e: any) {
          out = { text: `error: ${e?.message ?? String(e)}` };
          await dlog(`step=${step}    ERROR: ${out.text}`);
        }
        const outSummary = summarize(out.text ?? "<image>", 160);
        console.log(`[director] step=${step} ${tu.name}(${summarize(tu.input, 120)}) -> ${outSummary}`);
        // Only echo non-trivial results back to the live-log to keep it readable.
        if (out.text && out.text.length > 8 && !/^(ok|clicked|focused|tab_id=)/.test(out.text)) {
          await dlog(`step=${step}    = ${outSummary}`);
        }
        return buildToolResult(tu.id, out);
      }),
    );
    messages.push({ role: "user", content: results });

    if (step > 0 && step % 10 === 0 && messages.length > 24) {
      messages = trimMessages(messages, 22);
    }
  }

  log("director_done", { step: MAX_STEPS });
  console.log("[director] hit MAX_STEPS, exiting");
}

// ---------- helpers ----------

function buildToolResult(toolUseId: string, out: ToolReturn): any {
  const content: any[] = [];
  if (out.imageB64) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: out.imageB64 },
    });
  }
  content.push({ type: "text", text: out.text ?? "" });
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
  };
}

// History trim that keeps the seed and the most recent N turns, dropping
// orphaned tool_result blocks at the head so Claude doesn't 400 on us.
function trimMessages(messages: any[], keep: number): any[] {
  const seed = messages[0];
  let kept = messages.slice(-keep);
  while (kept.length > 0) {
    const first = kept[0];
    if (
      first.role === "user" &&
      Array.isArray(first.content) &&
      first.content[0]?.type === "tool_result"
    ) {
      kept = kept.slice(2);
    } else {
      break;
    }
  }
  return [seed, ...kept];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- bootstrap ----------

async function waitForControl(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await ctrl("GET", "/health");
    if (r.ok) {
      console.log(`[agent] control server ready at ${BASE}`);
      return;
    }
    await sleep(2000);
  }
  throw new Error(`control server never became ready at ${BASE}`);
}

/**
 * Append a single line to /workspace/director.log. One of the bootstrap xterms
 * tails this file so the viewer sees the director's tool calls and reasoning
 * on the stream itself. Best-effort — failures are silent so logging never
 * blocks the director loop.
 */
async function dlog(line: string): Promise<void> {
  const safe = line.replace(/\r?\n/g, " ").replace(/'/g, `'\\''`);
  const cmd = `printf '[%s] %s\\n' "$(date +%H:%M:%S)" '${safe}' >> /workspace/director.log`;
  await desktop.terminalExec({ cmd, timeout_s: 5 }).catch(() => {});
}

// Pre-spawn ambient terminals so the desktop has visible non-browser activity
// from second one and stays alive even when the director is between Claude
// calls. One xterm tails /workspace/director.log so the viewer (and you) can
// watch the director's tool calls and reasoning live, without `docker logs`.
async function bootstrap(): Promise<void> {
  console.log("[agent] bootstrapping ambient windows");
  log("bootstrap", {});
  await desktop.terminalExec({
    cmd: "mkdir -p /workspace && : > /workspace/director.log && : > /workspace/scratch.log",
    timeout_s: 5,
  }).catch(() => {});
  await dlog("DIRECTOR: bootstrapping…");
  await desktop.terminalSpawn({
    // -c shows the full command line. -d 2 gives a 2s refresh — gentler than 1s
    // so the stream doesn't strobe.
    cmd: "top -c -d 2",
    title: "top",
  });
  await desktop.terminalSpawn({
    cmd:
      "echo '[director live-log — every tool call, worker dispatch, and reaction lands here]'; " +
      "tail -F /workspace/director.log",
    title: "director-log",
  });
  await desktop.terminalSpawn({
    cmd:
      "echo '[scratch — director can write here via desktop_fs_write or echo >>]'; " +
      "tail -F /workspace/scratch.log",
    title: "scratch-log",
  });
  // Open one Polymarket tab up front so the director isn't navigating from
  // about:blank. Non-fatal if it fails; the director will retry.
  await desktop.browserOpen("https://polymarket.com/").catch(() => {});
  await sleep(2500);
  // Lay everything out in a grid before the LLM gets the first turn.
  await desktop.windowTile({ layout: "grid" }).catch(() => {});
  await dlog("DIRECTOR: ambient windows up; entering director loop");
}

async function main(): Promise<void> {
  console.log(`[agent] session=${SESSION_ID} base=${BASE} model=${MODEL}`);
  log("session_start", { session_id: SESSION_ID, base: BASE, task: TASK });
  await waitForControl();
  await bootstrap();
  await director();
  log("session_end", {});
  console.log("[agent] director loop exited; idling so the stream stays up");
  // Keep the container alive so the broker's session monitor doesn't
  // immediately tear down the stream — the stream-client is independent, but
  // the agent exiting flips the worker_status. The session TTL will reap us.
  while (true) await sleep(60_000);
}

main().catch((e) => {
  console.error("[agent] fatal:", e);
  log("agent_fatal", { error: String(e) });
  process.exit(1);
});
