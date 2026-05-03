import { BROKER_INTERNAL_URL, type SessionInfo } from "../../../../lib/api";

const ADMIN_KEY = process.env.BROKER_ADMIN_KEY || "";
const DEMO_KIND = "arcade";

// Statuses where a session is considered "the active one" — anything that
// hasn't ended yet. Trusting the broker here is correct because the broker
// is the only thing that can reach the spawned containers (which live on
// the stream-server in production, not on the frontend's docker network).
const ALIVE_STATUSES = new Set(["queued", "starting", "waiting", "running"]);

async function findActiveSession(): Promise<SessionInfo | null> {
  const r = await fetch(
    `${BROKER_INTERNAL_URL}/api/sessions?kind=${DEMO_KIND}&limit=20`,
    { cache: "no-store" },
  );
  if (!r.ok) return null;
  const list = (await r.json()) as SessionInfo[];
  // Broker orders by created_at desc, so the first alive session wins.
  return list.find((s) => ALIVE_STATUSES.has(s.status)) ?? null;
}

async function createNew(): Promise<SessionInfo> {
  const r = await fetch(`${BROKER_INTERNAL_URL}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_KEY}`,
    },
    body: JSON.stringify({ kind: DEMO_KIND }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`create ${DEMO_KIND} failed (${r.status}): ${text}`);
  }
  return r.json();
}

export async function GET() {
  try {
    const session = (await findActiveSession()) ?? (await createNew());
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
