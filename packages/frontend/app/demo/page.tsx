import { headers } from "next/headers";
import DemoView, { type AvatarOverrides } from "./DemoView";
import type { SessionInfo } from "../../lib/api";

export const dynamic = "force-dynamic";

// Same-origin path proxied by next.config.ts → AVATAR_BACKEND_URL/*. The
// browser only ever sees the frontend domain, so no CORS / DNS / new
// subdomain is required for the avatar iframe.
const PUBLIC_AVATAR_URL = "/demo-avatar";

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

function pickOne(value: string | string[] | undefined, max = 1000): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return undefined;
  // Strip control chars + cap length so a malicious URL can't bloat the
  // system prompt or break the iframe URL.
  const cleaned = v.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, max);
}

export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const avatarOverrides: AvatarOverrides = {
    character: pickOne(sp.character, 64),
    model: pickOne(sp.model, 64),
    voice: pickOne(sp.voice, 64),
    persona: pickOne(sp.persona, 2000),
  };

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
  return (
    <DemoView
      initialSession={session}
      avatarUrl={PUBLIC_AVATAR_URL}
      avatarOverrides={avatarOverrides}
    />
  );
}
