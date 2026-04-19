"use client";

import { useEffect, useState } from "react";
import {
  API_KEY_STORAGE,
  DEFAULT_MODEL,
  MODEL_OPTIONS,
  MODEL_STORAGE,
  type SessionInfo,
} from "../../../lib/api";

export default function WorkerModal({
  sessionId,
  onClose,
  onStarted,
}: {
  sessionId: string;
  onClose: () => void;
  onStarted: (s: SessionInfo) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Hydrate from localStorage on mount (client-only).
  useEffect(() => {
    try {
      const k = window.localStorage.getItem(API_KEY_STORAGE) || "";
      const m = window.localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL;
      setApiKey(k);
      setModel(m);
    } catch {}
  }, []);

  function forget() {
    try {
      window.localStorage.removeItem(API_KEY_STORAGE);
    } catch {}
    setApiKey("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) {
      setErr("API key is required");
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const r = await fetch(`/api/sessions/${sessionId}/worker/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anthropic_api_key: apiKey, model }),
      });
      const text = await r.text();
      if (!r.ok) {
        try {
          const j = JSON.parse(text);
          setErr(j.detail || text);
        } catch {
          setErr(text);
        }
        return;
      }
      try {
        window.localStorage.setItem(API_KEY_STORAGE, apiKey);
        window.localStorage.setItem(MODEL_STORAGE, model);
      } catch {}
      onStarted(JSON.parse(text) as SessionInfo);
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-950 p-6 space-y-4"
      >
        <h2 className="text-lg font-semibold">Start worker</h2>
        <p className="text-sm text-neutral-400">
          Launches an agent container with your key. Not stored on the server;
          saved in your browser for next time.
        </p>

        <label className="block text-sm">
          <span className="text-neutral-300">Anthropic API key</span>
          <input
            type="password"
            autoComplete="off"
            className="mt-1 w-full rounded bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm font-mono"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
          />
        </label>

        <label className="block text-sm">
          <span className="text-neutral-300">Model</span>
          <select
            className="mt-1 w-full rounded bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {MODEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {err && <div className="text-red-400 text-xs break-all">{err}</div>}

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={forget}
            className="text-xs text-neutral-500 hover:text-neutral-300 underline"
          >
            Forget saved key
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-2 text-sm bg-neutral-800 hover:bg-neutral-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-50"
            >
              {submitting ? "Starting…" : "Start worker"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
