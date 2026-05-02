import { BROKER_INTERNAL_URL, type SessionInfo } from "../../../../lib/api";

const ADMIN_KEY = process.env.BROKER_ADMIN_KEY || "";
const DEMO_KIND = "arcade";
const PROBE_TIMEOUT_MS = 2000;

// Probe the broker-spawned stream-client over the docker network. If the
// container is gone (compose down + back up, manual `docker rm`, OOM kill,
// etc.), the broker still has the session in `running`/`waiting` state in
// the DB but `docker exec` against the container fails — that's the "no
// such container: stream-client-arcade-0" error the user kept hitting.
async function probeStreamClient(kind: string, slot: number | null): Promise<boolean> {
  if (slot === null) return false;
  const url = `http://stream-client-${kind}-${slot}:3000/`;
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

async function deleteSession(id: string): Promise<void> {
  await fetch(`${BROKER_INTERNAL_URL}/api/sessions/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  }).catch(() => {});
}

async function findLiveExisting(): Promise<SessionInfo | null> {
  const r = await fetch(
    `${BROKER_INTERNAL_URL}/api/sessions?kind=${DEMO_KIND}&limit=10`,
    { cache: "no-store" },
  );
  if (!r.ok) return null;
  const list = (await r.json()) as SessionInfo[];
  const candidates = list.filter(
    (s) => s.status === "running" || s.status === "waiting",
  );
  for (const s of candidates) {
    if (await probeStreamClient(DEMO_KIND, s.slot)) {
      return s;
    }
    // Orphan — its containers are gone, free its slot so a fresh session
    // can spawn into it. Best-effort; we don't block on the DELETE response.
    await deleteSession(s.id);
  }
  return null;
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
    const live = await findLiveExisting();
    const session = live ?? (await createNew());
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
