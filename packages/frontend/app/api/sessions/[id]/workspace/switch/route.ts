import { BROKER_INTERNAL_URL } from "../../../../../../lib/api";

const ADMIN_KEY = process.env.BROKER_ADMIN_KEY || "";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.text();
  const r = await fetch(
    `${BROKER_INTERNAL_URL}/api/sessions/${id}/workspace/switch`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ADMIN_KEY}`,
      },
      body,
    },
  );
  return new Response(await r.text(), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
}
