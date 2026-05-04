// Forward the /demo viewer's TTS-mode pick to the broker. The modal posts
// here on first load; narrate.py reads session.state.tts_mode to decide
// whether to synthesize audio server-side (elevenlabs path) or emit
// narration text as a broker event for the browser to TTS locally.

import { BROKER_INTERNAL_URL } from "../../../../lib/api";

const ADMIN_KEY = process.env.BROKER_ADMIN_KEY || "";

export async function POST(req: Request) {
  let body: { session_id?: string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const sessionId = String(body.session_id || "").trim();
  const mode = String(body.mode || "").trim();
  if (!sessionId || (mode !== "elevenlabs" && mode !== "browser")) {
    return new Response(
      JSON.stringify({ error: "session_id and mode (elevenlabs|browser) required" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  try {
    const r = await fetch(
      `${BROKER_INTERNAL_URL}/api/sessions/${sessionId}/tts-mode`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ADMIN_KEY}`,
        },
        body: JSON.stringify({ mode }),
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
  return new Response(JSON.stringify({ ok: true, mode }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
