import { BROKER_INTERNAL_URL, DEFAULT_MODEL, type SessionInfo } from "../../../../lib/api";

const ADMIN_KEY = process.env.BROKER_ADMIN_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.DEMO_AGENT_MODEL || DEFAULT_MODEL;

type AgentEntry = { status?: string };

async function ensureAgent(
  sessionId: string,
  agentKind: "minecraft" | "playwright",
  status: string | undefined,
): Promise<void> {
  // Already running/starting? Leave it alone.
  if (status === "running" || status === "starting") return;

  const action = status === "paused" ? "resume" : "start";
  await fetch(
    `${BROKER_INTERNAL_URL}/api/sessions/${sessionId}/agents/${agentKind}/${action}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        anthropic_api_key: ANTHROPIC_API_KEY,
        model: MODEL,
      }),
    },
  ).catch(() => {});
}

export async function POST(req: Request) {
  let body: { session_id?: string };
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
  if (!ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

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
  if (session.kind !== "arcade") {
    return new Response(
      JSON.stringify({ error: `session is ${session.kind}, not arcade` }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }
  const agents = (session.state?.agents ?? {}) as Record<string, AgentEntry>;
  await Promise.all([
    ensureAgent(sessionId, "minecraft", agents.minecraft?.status),
    ensureAgent(sessionId, "playwright", agents.playwright?.status),
  ]);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
