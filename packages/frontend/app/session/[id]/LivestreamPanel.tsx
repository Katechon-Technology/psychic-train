"use client";

import { useState } from "react";
import type { LivestreamStatus } from "../../../lib/api";

export default function LivestreamPanel({
  sessionId,
  livestreamStatus,
  disabled,
  onChange,
}: {
  sessionId: string;
  livestreamStatus: LivestreamStatus;
  disabled: boolean;
  onChange: (ls: LivestreamStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const isOn = livestreamStatus === "on";
  const starting = livestreamStatus === "starting" || (busy && !isOn);
  const stopping = busy && isOn;

  async function toggle() {
    if (disabled || busy) return;
    setBusy(true);
    setMsg(null);
    const action = isOn ? "stop" : "start";
    // Optimistically show the transition state
    onChange(isOn ? "off" : "starting");
    try {
      const r = await fetch(`/api/sessions/${sessionId}/livestream/${action}`, {
        method: "POST",
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg(data.detail || `broker returned ${r.status}`);
        onChange("error");
      } else if (data.livestream_status) {
        onChange(data.livestream_status);
      }
    } catch (e) {
      setMsg(String(e));
      onChange("error");
    } finally {
      setBusy(false);
    }
  }

  let label: string;
  if (disabled) label = "Waiting for preview…";
  else if (starting) label = "Starting livestream…";
  else if (stopping) label = "Stopping…";
  else if (isOn) label = "Stop livestream";
  else label = "Start livestream";

  return (
    <div className="rounded-lg border border-neutral-800 p-4 flex items-center gap-4">
      <button
        onClick={toggle}
        disabled={disabled || busy}
        className={`rounded px-5 py-2.5 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 ${
          isOn ? "bg-red-600 hover:bg-red-500" : "bg-rose-600 hover:bg-rose-500"
        }`}
      >
        {label}
      </button>
      <div className="text-sm text-neutral-400">
        {isOn
          ? "Pushing to Twitch / Kick (based on broker env). Preview keeps running."
          : disabled
          ? "Start a session and wait for the preview to appear first."
          : "Click to start pushing RTMP. You can stop any time."}
      </div>
      {msg && <div className="text-xs text-red-400 ml-auto">{msg}</div>}
    </div>
  );
}
