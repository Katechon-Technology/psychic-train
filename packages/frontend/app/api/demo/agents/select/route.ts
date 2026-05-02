// Pause every arcade agent that isn't the click target, then start (or
// resume) the target. Mirrors ArcadePanel.switchTo's choreography but uses
// the server's ANTHROPIC_API_KEY so visitors don't need their own key.
//
// Body: { session_id, agent_kind: "minecraft" | "playwright" | null, task?: string }
//   agent_kind=null  → pause every running agent (Hub workspace).
//   task             → forwarded to the broker as TASK_HINT on a fresh start
//                      (only used when starting, not resuming).

import { BROKER_INTERNAL_URL, DEFAULT_MODEL, type SessionInfo } from "../../../../../lib/api";

const ADMIN_KEY = process.env.BROKER_ADMIN_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.DEMO_AGENT_MODEL || DEFAULT_MODEL;

const KNOWN_AGENTS = ["minecraft", "playwright"] as const;
type AgentKind = (typeof KNOWN_AGENTS)[number];

type AgentEntry = { status?: string };

async function callAgent(
  sessionId: string,
  agentKind: AgentKind,
  action: "start" | "stop" | "pause" | "resume",
  body: Record<string, unknown> = {},
): Promise<void> {
  await fetch(
    `${BROKER_INTERNAL_URL}/api/sessions/${sessionId}/agents/${agentKind}/${action}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: Object.keys(body).length ? JSON.stringify(body) : "",
    },
  ).catch(() => {});
}

export async function POST(req: Request) {
  let body: { session_id?: string; agent_kind?: string | null; task?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const sessionId = String(body.session_id || "").trim();
  if (!sessionId) {
    return new Response(JSON.stringify({ error: "session_id required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const target = body.agent_kind === null || body.agent_kind === undefined
    ? null
    : (KNOWN_AGENTS as readonly string[]).includes(body.agent_kind)
      ? (body.agent_kind as AgentKind)
      : null;

  if (target !== null && !ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  // Read current agent statuses so we don't pause an already-paused agent
  // or restart a running one.
  const r = await fetch(`${BROKER_INTERNAL_URL}/api/sessions/${sessionId}`, {
    cache: "no-store",
  });
  if (!r.ok) {
    return new Response(await r.text(), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }
  const session = (await r.json()) as SessionInfo;
  const agents = (session.state?.agents ?? {}) as Record<string, AgentEntry>;

  // Pause every agent that isn't the target and is currently active.
  const pauses: Promise<void>[] = [];
  for (const k of KNOWN_AGENTS) {
    if (k === target) continue;
    const status = agents[k]?.status;
    if (status === "running" || status === "starting") {
      pauses.push(callAgent(sessionId, k, "pause"));
    }
  }
  await Promise.all(pauses);

  // Start or resume the target.
  if (target !== null) {
    const status = agents[target]?.status;
    const startBody: Record<string, unknown> = {
      anthropic_api_key: ANTHROPIC_API_KEY,
      model: MODEL,
    };
    if (body.task && String(body.task).trim()) {
      startBody.task = String(body.task).trim();
    }
    if (status === "paused" && !body.task) {
      // Plain resume — fast path, no new TASK_HINT.
      await callAgent(sessionId, target, "resume", {
        anthropic_api_key: ANTHROPIC_API_KEY,
        model: MODEL,
      });
    } else {
      // Fresh start (also handles paused→start with new task hint, since
      // the broker pre-stops the old container in that case).
      await callAgent(sessionId, target, "start", startBody);
    }
  }

  return new Response(JSON.stringify({ ok: true, target }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
