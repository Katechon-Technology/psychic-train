import { BROKER_INTERNAL_URL } from "../../../lib/api";

export async function GET() {
  const r = await fetch(`${BROKER_INTERNAL_URL}/api/kinds`, { cache: "no-store" });
  return new Response(await r.text(), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
}
