"use client";

import { useEffect, useState } from "react";
import {
  API_KEY_STORAGE,
  DEFAULT_MODEL,
  MODEL_OPTIONS,
  MODEL_STORAGE,
  type SessionInfo,
} from "../../../lib/api";

// Arcade has three workspaces. Each agent's name in the manifest maps to a
// fixed workspace number. Index 0 (Hub) has no agent — switching to Hub just
// pauses both other agents.
type WorkspaceId = "hub" | "minecraft" | "playwright";

type AgentEntry = {
  status?: "off" | "starting" | "running" | "paused" | "stopping" | "error";
  container?: string;
  exit_code?: number;
  error?: string;
};

const WORKSPACES: {
  id: WorkspaceId;
  index: number;
  label: string;
  agentKind: string | null;
  blurb: string;
}[] = [
  {
    id: "hub",
    index: 0,
    label: "Hub",
    agentKind: null,
    blurb: "Lobby page. Both agents pause; the stream is just the hub graphic.",
  },
  {
    id: "minecraft",
    index: 1,
    label: "Minecraft",
    agentKind: "minecraft",
    blurb: "Mineflayer bot wanders/mines. Spectator camera follows it.",
  },
  {
    id: "playwright",
    index: 2,
    label: "Playwright",
    agentKind: "playwright",
    blurb: "Doomscrolls news feeds. Send a task to steer it.",
  },
];

export default function ArcadePanel({
  session,
  onSession,
}: {
  session: SessionInfo | null;
  onSession: (s: SessionInfo) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [taskTarget, setTaskTarget] = useState<"minecraft" | "playwright">(
    "playwright",
  );

  const state = (session?.state ?? {}) as {
    current_workspace?: number;
    agents?: Record<string, AgentEntry>;
  };
  const currentIndex =
    typeof state.current_workspace === "number" ? state.current_workspace : 0;
  const agents = state.agents ?? {};

  const ready =
    !!session && (session.status === "waiting" || session.status === "running");

  // API key + model are kept in localStorage and mirrored in component state
  // so the Settings row stays in sync with whatever WorkerModal (used by
  // other kinds) wrote on a previous session. Both are sent in every
  // start/resume request body; the broker ignores its own ANTHROPIC_API_KEY /
  // MODEL fallbacks when the frontend supplies them.
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    try {
      setApiKey(window.localStorage.getItem(API_KEY_STORAGE) || "");
      setModel(window.localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL);
    } catch {}
  }, []);

  function saveModel(m: string) {
    setModel(m);
    try {
      window.localStorage.setItem(MODEL_STORAGE, m);
    } catch {}
  }

  function saveApiKey(k: string) {
    setApiKey(k);
    try {
      if (k) window.localStorage.setItem(API_KEY_STORAGE, k);
      else window.localStorage.removeItem(API_KEY_STORAGE);
    } catch {}
  }

  function getKeyOrPrompt(): string | null {
    if (apiKey.trim()) return apiKey.trim();
    const entered = window.prompt(
      "Anthropic API key (saved in this browser only)",
    );
    if (!entered || !entered.trim()) return null;
    saveApiKey(entered.trim());
    return entered.trim();
  }

  async function callAgent(
    agentKind: string,
    action: "start" | "stop" | "pause" | "resume",
    extra: Record<string, unknown> = {},
  ): Promise<SessionInfo | null> {
    const needsKey = action === "start" || action === "resume";
    const body: Record<string, unknown> = { ...extra };
    if (needsKey) {
      const key = getKeyOrPrompt();
      if (!key) return null;
      body.anthropic_api_key = key;
      body.model = model;
    }
    const r = await fetch(
      `/api/sessions/${session!.id}/agents/${agentKind}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: needsKey || Object.keys(extra).length ? JSON.stringify(body) : "",
      },
    );
    const text = await r.text();
    if (!r.ok) {
      try {
        setErr(JSON.parse(text).detail || text);
      } catch {
        setErr(text);
      }
      return null;
    }
    try {
      return JSON.parse(text) as SessionInfo;
    } catch {
      return null;
    }
  }

  async function switchTo(workspaceIndex: number) {
    if (!session) return;
    setBusy(true);
    setErr(null);
    try {
      // 1) Switch the X11 workspace.
      const sw = await fetch(`/api/sessions/${session.id}/workspace/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: workspaceIndex }),
      });
      if (!sw.ok) {
        const text = await sw.text();
        try {
          setErr(JSON.parse(text).detail || text);
        } catch {
          setErr(text);
        }
        return;
      }

      // 2) Pause every agent that isn't the new target.
      const target = WORKSPACES.find((w) => w.index === workspaceIndex);
      const targetKind = target?.agentKind ?? null;

      for (const w of WORKSPACES) {
        if (!w.agentKind || w.agentKind === targetKind) continue;
        const status = agents[w.agentKind]?.status;
        if (status === "running" || status === "starting") {
          await callAgent(w.agentKind, "pause");
        }
      }

      // 3) Start or resume the target agent.
      if (targetKind) {
        const status = agents[targetKind]?.status;
        if (status === "paused") {
          const updated = await callAgent(targetKind, "resume");
          if (updated) onSession(updated);
        } else if (!status || status === "off" || status === "error") {
          const updated = await callAgent(targetKind, "start");
          if (updated) onSession(updated);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function sendTask() {
    if (!session || !task.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      // Restart the target agent with TASK_HINT. start with task=… does a
      // clean spawn; if the container exists already, callAgent → start
      // pre-stops it via _docker_stop in the broker.
      const updated = await callAgent(taskTarget, "start", { task: task.trim() });
      if (updated) onSession(updated);
      // Switch to the target's workspace too.
      const target = WORKSPACES.find((w) => w.agentKind === taskTarget);
      if (target) {
        await fetch(`/api/sessions/${session.id}/workspace/switch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspace: target.index }),
        });
      }
      setTask("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-neutral-800 p-4 space-y-4">
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="font-medium">Arcade controls</span>
        <span className="text-xs text-neutral-500">
          {ready ? "ready" : "starting…"}
        </span>
        {!apiKey && (
          <span className="text-xs text-amber-400">
            first action will prompt for your Anthropic API key
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowSettings((v) => !v)}
          className="ml-auto text-xs text-neutral-400 hover:text-neutral-200 underline"
        >
          {showSettings ? "hide settings" : "settings"}
        </button>
      </div>

      {showSettings && (
        <div className="rounded border border-neutral-800 bg-neutral-950/50 p-3 space-y-3">
          <div className="flex items-center gap-3">
            <label className="text-xs text-neutral-400 w-24 shrink-0">
              Model
            </label>
            <select
              value={model}
              onChange={(e) => saveModel(e.target.value)}
              className="flex-1 rounded bg-neutral-900 border border-neutral-700 px-2 py-1.5 text-sm"
            >
              {MODEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-neutral-400 w-24 shrink-0">
              API key
            </label>
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                apiKey
                  ? "bg-emerald-900 text-emerald-300"
                  : "bg-amber-900 text-amber-300"
              }`}
            >
              {apiKey
                ? `set (…${apiKey.slice(-6)})`
                : "not set — will prompt on next action"}
            </span>
            <button
              type="button"
              onClick={() => {
                const entered = window.prompt(
                  "Anthropic API key (saved in this browser only). Leave blank to clear.",
                  apiKey,
                );
                if (entered === null) return;
                saveApiKey(entered.trim());
              }}
              className="ml-auto text-xs rounded bg-neutral-800 hover:bg-neutral-700 px-3 py-1.5"
            >
              {apiKey ? "replace" : "set"}
            </button>
            {apiKey && (
              <button
                type="button"
                onClick={() => saveApiKey("")}
                className="text-xs text-neutral-500 hover:text-red-400 underline"
              >
                forget
              </button>
            )}
          </div>
          <p className="text-xs text-neutral-500 leading-snug">
            Both values live in this browser&apos;s localStorage; nothing is
            stored on the server. Changes apply on the next agent
            start/resume — re-click a workspace or hit Send to use them.
          </p>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        {WORKSPACES.map((w) => {
          const active = currentIndex === w.index;
          const agentStatus = w.agentKind
            ? agents[w.agentKind]?.status ?? "off"
            : null;
          return (
            <button
              key={w.id}
              onClick={() => switchTo(w.index)}
              disabled={busy || !ready}
              className={`text-left rounded-md p-3 border transition ${
                active
                  ? "border-emerald-700 bg-emerald-950/40"
                  : "border-neutral-800 bg-neutral-950 hover:border-neutral-600"
              } disabled:opacity-50`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{w.label}</span>
                {agentStatus && (
                  <span
                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                      agentStatus === "running"
                        ? "bg-emerald-900 text-emerald-300"
                        : agentStatus === "paused"
                        ? "bg-amber-900 text-amber-300"
                        : agentStatus === "starting"
                        ? "bg-sky-900 text-sky-300"
                        : agentStatus === "error"
                        ? "bg-red-900 text-red-300"
                        : "bg-neutral-800 text-neutral-400"
                    }`}
                  >
                    {agentStatus}
                  </span>
                )}
              </div>
              <div className="text-xs text-neutral-400 mt-1 leading-snug">
                {w.blurb}
              </div>
            </button>
          );
        })}
      </div>

      <div className="space-y-2">
        <label className="block text-sm text-neutral-300">
          Task hint (optional — restarts the target agent with this prompt)
        </label>
        <div className="flex gap-2">
          <select
            value={taskTarget}
            onChange={(e) =>
              setTaskTarget(e.target.value as "minecraft" | "playwright")
            }
            className="rounded bg-neutral-900 border border-neutral-700 px-2 py-2 text-sm"
            disabled={busy || !ready}
          >
            <option value="playwright">Playwright</option>
            <option value="minecraft">Minecraft</option>
          </select>
          <input
            type="text"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder='e.g. "find AI news"'
            className="flex-1 rounded bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm"
            disabled={busy || !ready}
          />
          <button
            onClick={sendTask}
            disabled={busy || !ready || !task.trim()}
            className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-white text-sm font-medium disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>

      {err && <div className="text-xs text-red-400 break-all">{err}</div>}
    </div>
  );
}
