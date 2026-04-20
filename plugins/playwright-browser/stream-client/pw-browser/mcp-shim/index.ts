#!/usr/bin/env node
/**
 * MCP shim that proxies to the playwright-browser HTTP API.
 *
 * Each tool call hits POST/DELETE on the local Fastify server. The shim
 * holds a single session id internally (auto-created on first use) so the
 * agent doesn't have to thread it manually.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE = process.env.PLAYWRIGHT_BROWSER_URL ?? "http://127.0.0.1:8731";

let sessionId: string | null = null;

async function ensureSession(): Promise<string> {
  if (sessionId) return sessionId;
  const res = await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`failed to create session: ${res.status} ${await res.text()}`);
  const json: any = await res.json();
  sessionId = json.id;
  return sessionId!;
}

async function call(path: string, body: unknown): Promise<unknown> {
  const id = await ensureSession();
  const res = await fetch(`${BASE}/session/${id}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

interface Tool {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any) => Promise<unknown>;
}

const tools: Tool[] = [
  {
    name: "browser_navigate",
    description: "Open a URL in the agent's browser tab.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    handler: (a) => call("/navigate", a),
  },
  {
    name: "browser_snapshot",
    description:
      "Return an accessibility snapshot of the current page. Each interactive element has a `ref` (e.g. e3) usable with browser_click and browser_type. Prefer this over screenshots for cheap, text-only context.",
    inputSchema: { type: "object", properties: {} },
    handler: () => call("/snapshot", {}),
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current viewport. Returns base64 PNG.",
    inputSchema: {
      type: "object",
      properties: { fullPage: { type: "boolean" } },
    },
    handler: (a) => call("/screenshot", a),
  },
  {
    name: "browser_click",
    description: "Click an element by ref (from browser_snapshot) or CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        selector: { type: "string" },
        doubleClick: { type: "boolean" },
      },
    },
    handler: (a) => call("/click", a),
  },
  {
    name: "browser_type",
    description: "Type text into a textbox identified by ref or selector. Set submit=true to press Enter after.",
    inputSchema: {
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
    handler: (a) => call("/type", a),
  },
  {
    name: "browser_press_key",
    description: "Press a keyboard key (e.g. 'Enter', 'Escape', 'ArrowDown').",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
    handler: (a) => call("/press_key", a),
  },
  {
    name: "browser_scroll",
    description: "Scroll the page. Defaults to one viewport down.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number" },
      },
    },
    handler: (a) => call("/scroll", a),
  },
  {
    name: "browser_wait",
    description: "Wait either for ms milliseconds, or until an element matches. state defaults to 'visible'.",
    inputSchema: {
      type: "object",
      properties: {
        ms: { type: "number" },
        ref: { type: "string" },
        selector: { type: "string" },
        state: { type: "string", enum: ["attached", "detached", "visible", "hidden"] },
        timeout: { type: "number" },
      },
    },
    handler: (a) => call("/wait", a),
  },
  {
    name: "browser_back",
    description: "Navigate back in history.",
    inputSchema: { type: "object", properties: {} },
    handler: () => call("/back", {}),
  },
  {
    name: "browser_forward",
    description: "Navigate forward in history.",
    inputSchema: { type: "object", properties: {} },
    handler: () => call("/forward", {}),
  },
  {
    name: "browser_evaluate",
    description:
      "Run JavaScript in the page. The expression body is wrapped in `async () => { ... }`, so use `return` to return a value.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
    handler: (a) => call("/evaluate", a),
  },
  {
    name: "browser_close",
    description: "End the current session and finalize recordings.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      if (!sessionId) return { ok: true };
      const id = sessionId;
      sessionId = null;
      const res = await fetch(`${BASE}/session/${id}`, { method: "DELETE" });
      return await res.json();
    },
  },
];

const toolByName = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: "playwright-browser", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = toolByName.get(req.params.name);
  if (!tool) throw new Error(`unknown tool: ${req.params.name}`);
  const result = await tool.handler(req.params.arguments ?? {});
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
});

await server.connect(new StdioServerTransport());
