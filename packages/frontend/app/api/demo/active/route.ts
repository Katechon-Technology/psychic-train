import { BROKER_INTERNAL_URL, type SessionInfo } from "../../../../lib/api";

const ADMIN_KEY = process.env.BROKER_ADMIN_KEY || "";

async function findExisting(): Promise<SessionInfo | null> {
  // The broker's GET /api/sessions only filters by a single status, so we
  // fetch the most recent arcade sessions and pick the first one that is
  // either waiting or running.
  const r = await fetch(
    `${BROKER_INTERNAL_URL}/api/sessions?kind=arcade&limit=10`,
    { cache: "no-store" },
  );
  if (!r.ok) return null;
  const list = (await r.json()) as SessionInfo[];
  return (
    list.find((s) => s.status === "running" || s.status === "waiting") || null
  );
}

async function createNew(): Promise<SessionInfo> {
  const r = await fetch(`${BROKER_INTERNAL_URL}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_KEY}`,
    },
    body: JSON.stringify({ kind: "arcade" }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`create arcade failed (${r.status}): ${text}`);
  }
  return r.json();
}

export async function GET() {
  try {
    const existing = await findExisting();
    const session = existing ?? (await createNew());
    return new Response(JSON.stringify(session), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
