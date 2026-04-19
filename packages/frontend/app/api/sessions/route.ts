import { BROKER_INTERNAL_URL } from "../../../lib/api";

const ADMIN_KEY = process.env.BROKER_ADMIN_KEY || "";

export async function GET() {
  const r = await fetch(`${BROKER_INTERNAL_URL}/api/sessions`, { cache: "no-store" });
  return new Response(await r.text(), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: Request) {
  const body = await req.text();
  const r = await fetch(`${BROKER_INTERNAL_URL}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_KEY}`,
    },
    body,
  });
  return new Response(await r.text(), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
}
