import { headers } from "next/headers";
import DemoView from "./DemoView";
import type { SessionInfo } from "../../lib/api";

export const dynamic = "force-dynamic";

const PUBLIC_AVATAR_URL =
  process.env.NEXT_PUBLIC_AVATAR_URL || "http://localhost:12393";

async function fetchActive(): Promise<SessionInfo> {
  const h = await headers();
  const host = h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  const r = await fetch(`${proto}://${host}/api/demo/active`, {
    cache: "no-store",
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(
      `failed to find or create arcade session (${r.status}): ${text}`,
    );
  }
  return r.json();
}

export default async function DemoPage() {
  let session: SessionInfo;
  try {
    session = await fetchActive();
  } catch (e) {
    return (
      <main
        style={{
          background: "#000",
          color: "#ff6666",
          minHeight: "100vh",
          padding: 40,
          fontFamily: "monospace",
          whiteSpace: "pre-wrap",
        }}
      >
        {String(e)}
      </main>
    );
  }
  return <DemoView initialSession={session} avatarUrl={PUBLIC_AVATAR_URL} />;
}
