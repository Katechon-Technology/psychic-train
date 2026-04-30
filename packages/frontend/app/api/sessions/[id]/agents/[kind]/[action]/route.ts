import { BROKER_INTERNAL_URL } from "../../../../../../../lib/api";

const ADMIN_KEY = process.env.BROKER_ADMIN_KEY || "";

const ALLOWED_ACTIONS = new Set(["start", "stop", "pause", "resume"]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; kind: string; action: string }> },
) {
  const { id, kind, action } = await params;
  if (!ALLOWED_ACTIONS.has(action)) {
    return new Response(
      JSON.stringify({ detail: "action must be start, stop, pause, or resume" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  // start/resume both expect a JSON body; pause/stop don't, but the broker
  // tolerates a body either way. Forward the raw text.
  const body = await req.text();
  const r = await fetch(
    `${BROKER_INTERNAL_URL}/api/sessions/${id}/agents/${kind}/${action}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: body || undefined,
    },
  );
  return new Response(await r.text(), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
}
