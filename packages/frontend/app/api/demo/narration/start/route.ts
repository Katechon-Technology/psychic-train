// Forward the /demo viewer's request to start narration to the broker. The
// frontend's server-side ANTHROPIC_API_KEY is forwarded as part of the
// payload so the broker can call Claude on this session's behalf without
// needing its own key.

import { BROKER_INTERNAL_URL } from "../../../../../lib/api";

const ADMIN_KEY = process.env.BROKER_ADMIN_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

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
      JSON.stringify({ error: "ANTHROPIC_API_KEY unset on the frontend" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
  try {
    const r = await fetch(
      `${BROKER_INTERNAL_URL}/api/sessions/${sessionId}/narration/start`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ADMIN_KEY}`,
        },
        body: JSON.stringify({ anthropic_api_key: ANTHROPIC_API_KEY }),
      },
    );
    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}
