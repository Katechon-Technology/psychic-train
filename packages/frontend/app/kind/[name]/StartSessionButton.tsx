"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function StartSessionButton({ kind, disabled }: { kind: string; disabled?: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function start() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      if (!r.ok) {
        setErr(`broker returned ${r.status}: ${await r.text()}`);
        return;
      }
      const s = await r.json();
      router.push(`/session/${s.id}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        onClick={start}
        disabled={loading || disabled}
        className="rounded bg-emerald-600 px-5 py-3 text-white font-medium disabled:bg-neutral-700 disabled:cursor-not-allowed"
      >
        {loading ? "Starting…" : disabled ? "No slots available" : "Watch"}
      </button>
      {err && <div className="text-red-400 text-sm">{err}</div>}
    </div>
  );
}
