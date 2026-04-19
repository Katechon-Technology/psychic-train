import Link from "next/link";
import { KindInfo, SessionInfo, BROKER_INTERNAL_URL } from "../lib/api";

async function fetchKinds(): Promise<KindInfo[]> {
  const r = await fetch(`${BROKER_INTERNAL_URL}/api/kinds`, { cache: "no-store" });
  if (!r.ok) return [];
  return r.json();
}

async function fetchLiveSessions(): Promise<SessionInfo[]> {
  const r = await fetch(`${BROKER_INTERNAL_URL}/api/sessions?status=running&limit=30`, {
    cache: "no-store",
  });
  if (!r.ok) return [];
  return r.json();
}

export default async function Home() {
  const [kinds, live] = await Promise.all([fetchKinds(), fetchLiveSessions()]);

  return (
    <main className="mx-auto max-w-5xl p-8 space-y-12">
      <header>
        <h1 className="text-3xl font-bold">psychic-train</h1>
        <p className="text-neutral-400 mt-2">
          Pick a kind. An AI plays. You watch.
        </p>
      </header>

      <section>
        <h2 className="text-xl font-semibold mb-4">Kinds</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {kinds.map((k) => (
            <Link
              key={k.name}
              href={`/kind/${k.name}`}
              className="block rounded-lg border border-neutral-800 bg-neutral-950 p-5 hover:border-neutral-600 transition"
            >
              <div className="flex items-baseline justify-between">
                <h3 className="text-lg font-medium">{k.display_name}</h3>
                <span className="text-xs text-neutral-500">
                  {k.active_sessions}/{k.max_concurrent}
                </span>
              </div>
              <p className="text-sm text-neutral-400 mt-2">{k.description}</p>
            </Link>
          ))}
          {kinds.length === 0 && (
            <p className="text-neutral-500 col-span-full">
              No kinds loaded. Check broker logs.
            </p>
          )}
        </div>
      </section>

      {live.length > 0 && (
        <section>
          <h2 className="text-xl font-semibold mb-4">Live now</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {live.map((s) => (
              <Link
                key={s.id}
                href={`/session/${s.id}`}
                className="block rounded-lg border border-green-900/50 bg-neutral-950 p-4 hover:border-green-700"
              >
                <div className="text-sm text-green-500">{s.kind}</div>
                <div className="text-xs text-neutral-500 mt-1">{s.id}</div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
