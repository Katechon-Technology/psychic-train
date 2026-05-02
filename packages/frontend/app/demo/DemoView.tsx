"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import styles from "./demo.module.css";
import type { SessionInfo } from "../../lib/api";

type Workspace = {
  id: string;
  index: number;
  agentKind: "minecraft" | "playwright" | null;
  label: string;
  thumb: { kind: "img" | "video"; src: string };
  task?: string;
};

const WORKSPACES: Workspace[] = [
  {
    id: "spectre",
    index: 2,
    agentKind: "playwright",
    label: "OSINT / SPECTRE",
    thumb: { kind: "video", src: "/demo/videos/spectre.mp4" },
    task: "Browse OSINT / open-source intelligence dashboards. Look for interesting public data on companies, public figures, or current events. Narrate what you find.",
  },
  {
    id: "minecraft",
    index: 1,
    agentKind: "minecraft",
    label: "Minecraft AI",
    thumb: { kind: "img", src: "/demo/gifs/minecraft.gif" },
  },
  {
    id: "news",
    index: 2,
    agentKind: "playwright",
    label: "AI News Feed",
    thumb: { kind: "video", src: "/demo/videos/news.mp4" },
    task: "Doomscroll the latest AI news. Open one or two of: Hacker News, TechCrunch AI section, The Verge AI tag, ArsTechnica AI tag. Read headlines and skim articles.",
  },
];

type AgentCommand = {
  action: "switch" | "home" | "unknown";
  workspace: string | null;
  speech: string;
  audio?: string;
};

export type AvatarOverrides = {
  character?: string;
  model?: string;
  voice?: string;
  persona?: string;
};

export default function DemoView({
  initialSession,
  avatarUrl,
  avatarOverrides = {},
}: {
  initialSession: SessionInfo;
  avatarUrl: string;
  avatarOverrides?: AvatarOverrides;
}) {
  const [session, setSession] = useState<SessionInfo>(initialSession);
  const [statusText, setStatusText] = useState("connecting...");
  const [activeWs, setActiveWs] = useState<string | null>(null);
  const [busyWs, setBusyWs] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<{ text: string; color: string } | null>(null);
  const [listening, setListening] = useState(false);
  const [showOverlay, setShowOverlay] = useState(true);

  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const livestreamKickedOff = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // ---- Poll session for stream_url + status ------------------------------
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      while (!cancelled) {
        try {
          const r = await fetch(`/api/sessions/${session.id}`, { cache: "no-store" });
          if (r.ok) {
            const next: SessionInfo = await r.json();
            setSession(next);
            if (next.status === "failed" || next.status === "completed") return;
          }
        } catch {
          /* network blips are fine, just retry */
        }
        await new Promise((res) => setTimeout(res, 2500));
      }
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  // ---- Once stream_url is up, attach hls.js + flip livestream pointer ----
  useEffect(() => {
    if (!session.stream_url || !videoRef.current) return;
    const src = session.stream_url.replace(/\/?$/, "/") + "stream.m3u8";
    const video = videoRef.current;
    if (Hls.isSupported()) {
      const hls = new Hls({ liveSyncDurationCount: 3, maxBufferLength: 15 });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        setStatusText("● LIVE — katechon-desktop");
      });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) {
          setStatusText("reconnecting...");
          setTimeout(() => hls.loadSource(src), 2000);
        }
      });
      return () => hls.destroy();
    }
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      video.addEventListener("loadedmetadata", () => {
        video.play().catch(() => {});
        setStatusText("● LIVE — katechon-desktop");
      });
    }
  }, [session.stream_url]);

  // Kick off livestream/start once preview is ready so the persistent vtuber
  // narrator points at this session. Idempotent on the broker side.
  useEffect(() => {
    if (livestreamKickedOff.current) return;
    if (!session.stream_url || !["waiting", "running"].includes(session.status)) return;
    if (session.livestream_status === "on") {
      livestreamKickedOff.current = true;
      return;
    }
    livestreamKickedOff.current = true;
    fetch(`/api/sessions/${session.id}/livestream/start`, { method: "POST" }).catch(() => {});
  }, [session.id, session.status, session.stream_url, session.livestream_status]);

  // ---- Toast helper ------------------------------------------------------
  function showToast(text: string, color = "#e8e8ec") {
    setTranscript({ text, color });
    if (transcriptTimer.current) clearTimeout(transcriptTimer.current);
    transcriptTimer.current = setTimeout(() => setTranscript(null), 3000);
  }

  // ---- Workspace switch --------------------------------------------------
  async function switchWs(ws: Workspace) {
    if (busyWs) return;
    setBusyWs(ws.id);
    setActiveWs(ws.id);
    try {
      const swR = await fetch(`/api/sessions/${session.id}/workspace/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: ws.index }),
      });
      if (!swR.ok) {
        const text = await swR.text().catch(() => "");
        showToast(`switch failed: ${text.slice(0, 80) || swR.status}`, "#ff4444");
        return;
      }
      // Pause every other agent and start (or resume) this workspace's
      // agent. Server-side route uses the broker's ANTHROPIC_API_KEY so
      // the demo doesn't need any per-visitor credentials.
      fetch(`/api/demo/agents/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: session.id,
          agent_kind: ws.agentKind,
          task: ws.task,
        }),
      }).catch(() => {});
      // Match the original katechon-demo (index.html:248): hide the menu
      // overlay so the viewer sees just the stream + avatar after picking
      // a workspace. The bottom-left menu button brings it back.
      setShowOverlay(false);
    } finally {
      setBusyWs(null);
    }
  }

  // ---- Voice / push-to-talk ---------------------------------------------
  function getAudioCtx() {
    if (!audioCtxRef.current) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      audioCtxRef.current = new Ctor();
    }
    return audioCtxRef.current;
  }

  async function unlockAudio() {
    const v = videoRef.current;
    if (v) {
      v.muted = false;
      v.volume = 1;
      v.play().catch(() => {});
    }
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") await ctx.resume();
    const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  }

  async function playBase64(base64: string) {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") await ctx.resume();
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch {}
      audioSourceRef.current = null;
    }
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const audioBuf = await ctx.decodeAudioData(bytes.buffer);
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    audioSourceRef.current = src;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.ceil(audioBuf.duration * 1000) + 600);
      src.onended = () => {
        clearTimeout(t);
        if (audioSourceRef.current === src) audioSourceRef.current = null;
        resolve();
      };
      src.start(0);
    });
  }

  async function handleCommand(text: string) {
    showToast(`"${text}"`);
    const r = await fetch("/api/demo/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transcript: text,
        session_id: session.id,
        ...avatarOverrides,
      }),
    });
    if (!r.ok) {
      showToast(`agent error (${r.status})`, "#ff4444");
      return;
    }
    const cmd = (await r.json()) as AgentCommand;
    const heroName = avatarOverrides.character || "Kat";
    if (cmd.speech) showToast(`${heroName}: ${cmd.speech}`, "#00e87b");
    // Apply workspace switch (if any) before the speech finishes.
    if (cmd.action === "switch" && cmd.workspace) {
      const target = WORKSPACES.find((w) => w.id === cmd.workspace);
      if (target) switchWs(target);
    } else if (cmd.action === "home") {
      setShowOverlay(true);
      setActiveWs(null);
      // Hub workspace = 0; pause every agent so the stream just shows the
      // lobby graphic.
      fetch(`/api/sessions/${session.id}/workspace/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: 0 }),
      }).catch(() => {});
      fetch(`/api/demo/agents/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: session.id, agent_kind: null }),
      }).catch(() => {});
    }
    if (cmd.audio) {
      playBase64(cmd.audio).catch((err) => {
        console.warn("agent voice failed:", err);
      });
    }
  }

  async function startRecording() {
    try {
      await unlockAudio();
    } catch {}
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      showToast("mic access denied", "#ff4444");
      return;
    }
    const supportedMime = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
      "audio/mp4",
    ].find((m) => MediaRecorder.isTypeSupported(m));
    chunksRef.current = [];
    const rec = new MediaRecorder(stream, supportedMime ? { mimeType: supportedMime } : undefined);
    rec.ondataavailable = (e) => chunksRef.current.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setListening(false);
      const blob = new Blob(chunksRef.current, { type: rec.mimeType });
      if (blob.size < 1000) {
        showToast("too short — hold longer", "#6b6b78");
        return;
      }
      showToast("transcribing…", "#6b6b78");
      try {
        const r = await fetch("/api/demo/transcribe", {
          method: "POST",
          headers: { "content-type": blob.type },
          body: blob,
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `transcribe ${r.status}`);
        const text = (data.text || "").trim();
        if (!text) {
          showToast("no speech detected", "#6b6b78");
          return;
        }
        await handleCommand(text);
      } catch (e: unknown) {
        showToast(`transcription error`, "#ff4444");
        console.error("transcribe error:", e);
      }
    };
    recorderRef.current = rec;
    rec.start();
    setListening(true);
  }

  function stopRecording() {
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") rec.stop();
    recorderRef.current = null;
  }

  // ---- Render -----------------------------------------------------------
  const previewReady =
    !!session.stream_url && ["waiting", "running"].includes(session.status);

  // Iframe URL carries any avatar overrides as query params. Open-LLM-VTuber's
  // bundled embed.html may ignore unknown keys today, but threading them
  // through means a future patches/embed.html can read them without touching
  // this component again.
  const avatarSrc = (() => {
    const base = `${avatarUrl.replace(/\/$/, "")}/embed.html`;
    const qs = new URLSearchParams();
    if (avatarOverrides.character) qs.set("character", avatarOverrides.character);
    if (avatarOverrides.model) qs.set("model", avatarOverrides.model);
    if (avatarOverrides.voice) qs.set("voice", avatarOverrides.voice);
    const tail = qs.toString();
    return tail ? `${base}?${tail}` : base;
  })();

  return (
    <div className={styles.root}>
      <video
        ref={videoRef}
        className={styles.video}
        autoPlay
        muted
        playsInline
      />

      <iframe
        className={styles.avatarFrame}
        src={avatarSrc}
        title="VTuber avatar"
        allow="autoplay"
      />

      <div className={styles.status}>
        {previewReady ? statusText : `spinning up… (${session.status})`}
      </div>

      {showOverlay && (
        <div className={`${styles.overlay} ${styles.mainOverlay}`}>
          <div className={styles.mainTitle}>Katechon Technology</div>
          <div className={styles.mainSub}>24hr interactive livestream</div>
          <div className={styles.gifRow}>
            {WORKSPACES.map((ws) => (
              <button
                key={ws.id}
                type="button"
                onClick={() => switchWs(ws)}
                disabled={busyWs !== null || !previewReady}
                className={`${styles.gifBox} ${activeWs === ws.id ? styles.active : ""}`}
              >
                {ws.thumb.kind === "video" ? (
                  <video src={ws.thumb.src} autoPlay muted loop playsInline preload="metadata" />
                ) : (
                  <img src={ws.thumb.src} alt={ws.label} />
                )}
                <div className={styles.gifLabel}>{ws.label}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {!showOverlay && (
        <button
          type="button"
          className={styles.menuBtn}
          onClick={() => setShowOverlay(true)}
          aria-label="Show menu"
        >
          ≡ MENU
        </button>
      )}

      {transcript && (
        <div
          className={`${styles.transcript} ${styles.visible}`}
          style={{ color: transcript.color }}
        >
          {transcript.text}
        </div>
      )}

      <button
        type="button"
        className={`${styles.speechBtn} ${listening ? styles.listening : ""}`}
        title="Push to talk"
        onMouseDown={(e) => {
          e.preventDefault();
          startRecording();
        }}
        onMouseUp={() => stopRecording()}
        onMouseLeave={() => stopRecording()}
        onTouchStart={(e) => {
          e.preventDefault();
          startRecording();
        }}
        onTouchEnd={() => stopRecording()}
      >
        <svg
          width="34"
          height="34"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#00e87b"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="9" y="2" width="6" height="11" rx="3" />
          <path d="M5 10a7 7 0 0 0 14 0" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
        <span className={styles.speechLabel}>{listening ? "listening" : "hold"}</span>
      </button>
    </div>
  );
}
