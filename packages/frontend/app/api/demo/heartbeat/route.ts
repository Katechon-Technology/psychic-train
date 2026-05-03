// Forward a /demo viewer heartbeat to the broker. The broker's
// agent_idle_pauser task pauses the session's agents if these stop arriving
// for >20s, so we don't burn Anthropic credits on an unwatched stream.

import { BROKER_INTERNAL_URL } from "../../../../lib/api";

const ADMIN_KEY = process.env.BROKER_ADMIN_KEY || "";

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
  try {
    const r = await fetch(
      `${BROKER_INTERNAL_URL}/api/sessions/${sessionId}/demo/heartbeat`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      },
    );
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: `broker ${r.status}: ${text.slice(0, 200)}` }),
        { status: r.status, headers: { "content-type": "application/json" } },
      );
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
