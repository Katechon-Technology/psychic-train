"use client";

import { useState } from "react";
import type { SessionInfo, WorkerStatus } from "../../../lib/api";
import WorkerModal from "./WorkerModal";

export default function WorkerPanel({
  session,
  onSession,
}: {
  session: SessionInfo | null;
  onSession: (s: SessionInfo) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const status: WorkerStatus = session?.worker_status ?? "off";
  const sessionStatus = session?.status ?? "loading";

  const canStart =
    sessionStatus === "waiting" && (status === "off" || status === "error");
  const canStop = status === "running" || status === "starting";

  async function stop() {
    if (!session) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/sessions/${session.id}/worker/stop`, {
        method: "POST",
      });
      const body = await r.text();
      if (!r.ok) {
        try {
          setErr(JSON.parse(body).detail || body);
        } catch {
          setErr(body);
        }
        return;
      }
      onSession(JSON.parse(body) as SessionInfo);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const workerError =
    (session?.state as { worker_error?: string } | null)?.worker_error;

  return (
    <div className="rounded-lg border border-neutral-800 p-4 space-y-3">
      <div className="flex items-center gap-3">
        <span className="font-medium">Worker</span>
        <StatusPill status={status} />
        {canStart && (
          <button
            onClick={() => setModalOpen(true)}
            disabled={busy}
            className="ml-auto rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-white text-sm font-medium disabled:opacity-50"
          >
            Start worker
          </button>
        )}
        {canStop && (
          <button
            onClick={stop}
            disabled={busy}
            className="ml-auto rounded bg-red-600 hover:bg-red-500 px-4 py-2 text-white text-sm font-medium disabled:opacity-50"
          >
            {busy ? "Stopping…" : "Stop worker"}
          </button>
        )}
      </div>
      <div className="text-sm text-neutral-400">
        {status === "off" && sessionStatus === "waiting"
          ? "Preview is live. Start a worker to let Claude drive the plugin."
          : status === "starting"
          ? "Spawning agent container…"
          : status === "running"
          ? "Agent is running. Stop anytime; the session and stream keep going."
          : status === "stopping"
          ? "Shutting the agent down…"
          : status === "error"
          ? "Agent exited with an error. Start again to retry."
          : "Waiting for the preview to come up first…"}
      </div>
      {workerError && status === "error" && (
        <div className="text-xs text-red-400 break-all">{workerError}</div>
      )}
      {err && <div className="text-xs text-red-400 break-all">{err}</div>}

      {modalOpen && session && (
        <WorkerModal
          sessionId={session.id}
          onClose={() => setModalOpen(false)}
          onStarted={onSession}
        />
      )}
    </div>
  );
}

function StatusPill({ status }: { status: WorkerStatus }) {
  const styles: Record<WorkerStatus, string> = {
    off: "bg-neutral-800 text-neutral-400",
    starting: "bg-amber-900 text-amber-300",
    running: "bg-emerald-900 text-emerald-300",
    stopping: "bg-amber-900 text-amber-300",
    error: "bg-red-900 text-red-300",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${styles[status]}`}>{status}</span>
  );
}
