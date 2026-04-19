import { BROKER_INTERNAL_URL } from "../../../../../../lib/api";

const ADMIN_KEY = process.env.BROKER_ADMIN_KEY || "";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await fetch(`${BROKER_INTERNAL_URL}/api/sessions/${id}/worker/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  });
  return new Response(await r.text(), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
}
