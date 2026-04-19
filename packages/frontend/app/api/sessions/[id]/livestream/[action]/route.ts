import { BROKER_INTERNAL_URL } from "../../../../../../lib/api";

const ADMIN_KEY = process.env.BROKER_ADMIN_KEY || "";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await params;
  if (action !== "start" && action !== "stop") {
    return new Response(JSON.stringify({ detail: "action must be start or stop" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const r = await fetch(
    `${BROKER_INTERNAL_URL}/api/sessions/${id}/livestream/${action}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    },
  );
  return new Response(await r.text(), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
}
