"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Hls from "hls.js";
import type { SessionInfo } from "../../../lib/api";
import LivestreamPanel from "./LivestreamPanel";
import WorkerPanel from "./WorkerPanel";

export default function SessionView({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const router = useRouter();

  // Poll session status for the lifetime of the page so worker_status and
  // livestream_status stay fresh.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      while (!cancelled) {
        try {
          const r = await fetch(`/api/sessions/${sessionId}`);
          if (r.ok) {
            const s: SessionInfo = await r.json();
            setSession(s);
            if (["completed", "failed"].includes(s.status)) return;
          }
        } catch (e) {
          setErr(String(e));
        }
        await new Promise((res) => setTimeout(res, 2500));
      }
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Attach hls.js once stream_url is populated; detach on change.
  useEffect(() => {
    if (!session?.stream_url || !videoRef.current) return;
    const src = session.stream_url.replace(/\/?$/, "/") + "stream.m3u8";
    const video = videoRef.current;
    if (Hls.isSupported()) {
      const hls = new Hls({ liveSyncDurationCount: 3, maxBufferLength: 20 });
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => hls.destroy();
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
    }
  }, [session?.stream_url]);

  // Preview is watchable as soon as the (vtuber) stream_url is populated, which
  // happens at `waiting` — don't require `running`.
  const previewReady =
    !!session?.stream_url && ["waiting", "running"].includes(session.status);

  async function endSession() {
    if (!session) return;
    if (!confirm("End this session and tear down all containers?")) return;
    setEnding(true);
    try {
      await fetch(`/api/sessions/${session.id}`, { method: "DELETE" });
      router.push("/");
    } catch (e) {
      setErr(String(e));
      setEnding(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">{session?.kind ?? "…"}</h1>
        <span className="text-xs text-neutral-500">{sessionId}</span>
        <span
          className={`text-xs px-2 py-0.5 rounded ${
            session?.status === "waiting" || session?.status === "running"
              ? "bg-emerald-900 text-emerald-300"
              : session?.status === "failed"
              ? "bg-red-900 text-red-300"
              : "bg-neutral-800 text-neutral-400"
          }`}
        >
          {session?.status ?? "loading"}
        </span>
        {session?.livestream_status && session.livestream_status !== "off" && (
          <span
            className={`text-xs px-2 py-0.5 rounded ${
              session.livestream_status === "on"
                ? "bg-rose-900 text-rose-300"
                : session.livestream_status === "error"
                ? "bg-red-900 text-red-300"
                : "bg-amber-900 text-amber-300"
            }`}
          >
            livestream: {session.livestream_status}
          </span>
        )}
        {previewReady && (
          <button
            onClick={endSession}
            disabled={ending}
            className="ml-auto text-xs rounded bg-neutral-800 hover:bg-red-900 hover:text-red-300 px-3 py-1.5 disabled:opacity-50"
          >
            {ending ? "Ending…" : "End session"}
          </button>
        )}
      </div>

      <div className="aspect-video bg-black rounded-lg overflow-hidden border border-neutral-800">
        {session?.stream_url ? (
          <video ref={videoRef} autoPlay muted playsInline controls className="w-full h-full" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-neutral-500 p-6 text-center whitespace-pre-wrap">
            {session?.status === "failed"
              ? session.error || "session failed"
              : "spinning up container…"}
          </div>
        )}
      </div>

      <WorkerPanel
        session={session}
        onSession={(s) => setSession(s)}
      />

      <LivestreamPanel
        sessionId={sessionId}
        livestreamStatus={session?.livestream_status ?? "off"}
        disabled={!previewReady}
        onChange={(ls) => setSession((s) => (s ? { ...s, livestream_status: ls } : s))}
      />

      {err && <div className="text-red-400 text-sm">{err}</div>}
    </div>
  );
}
