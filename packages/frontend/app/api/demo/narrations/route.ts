// Poll broker session events, filter to kind="narration", return text + id
// for the /demo viewer to TTS locally when tts_mode == "browser".

import { BROKER_INTERNAL_URL } from "../../../../lib/api";

type RawEvent = { id: number; event: { kind?: string; text?: string } | null };

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = (url.searchParams.get("session_id") || "").trim();
  const after = Number(url.searchParams.get("after") || "0") || 0;
  const limit = Math.min(Number(url.searchParams.get("limit") || "50") || 50, 200);
  if (!sessionId) {
    return new Response(JSON.stringify({ error: "session_id required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const r = await fetch(
    `${BROKER_INTERNAL_URL}/api/sessions/${sessionId}/events?after=${after}&limit=${limit}`,
    { cache: "no-store" },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    return new Response(
      JSON.stringify({ error: `broker ${r.status}: ${text.slice(0, 200)}` }),
      { status: r.status, headers: { "content-type": "application/json" } },
    );
  }
  const rows: RawEvent[] = await r.json().catch(() => []);
  const narrations = rows
    .filter((row) => row.event && String(row.event.kind || "").toLowerCase() === "narration")
    .map((row) => ({ id: row.id, text: String(row.event?.text || "") }))
    .filter((n) => n.text);
  const lastId = rows.length ? rows[rows.length - 1].id : after;
  return new Response(JSON.stringify({ lastId, narrations }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
