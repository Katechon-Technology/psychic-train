import { KindInfo, BROKER_INTERNAL_URL } from "../../../lib/api";
import StartSessionButton from "./StartSessionButton";
import Link from "next/link";

async function fetchKind(name: string): Promise<KindInfo | null> {
  const r = await fetch(`${BROKER_INTERNAL_URL}/api/kinds/${name}`, { cache: "no-store" });
  if (!r.ok) return null;
  return r.json();
}

export default async function KindPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const kind = await fetchKind(name);
  if (!kind) {
    return (
      <main className="p-8">
        <p>Unknown kind. <Link href="/" className="underline">back</Link></p>
      </main>
    );
  }
  const slotsAvailable = kind.active_sessions < kind.max_concurrent;

  return (
    <main className="mx-auto max-w-2xl p-8 space-y-8">
      <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-300">← all kinds</Link>
      <div>
        <h1 className="text-3xl font-bold">{kind.display_name}</h1>
        <p className="text-neutral-400 mt-2">{kind.description}</p>
      </div>
      <div className="rounded-lg border border-neutral-800 p-4 text-sm text-neutral-400 space-y-1">
        <div>topology: <span className="text-neutral-200">{kind.topology}</span></div>
        <div>active: <span className="text-neutral-200">{kind.active_sessions}/{kind.max_concurrent}</span></div>
      </div>
      <StartSessionButton kind={kind.name} disabled={!slotsAvailable} />
    </main>
  );
}
