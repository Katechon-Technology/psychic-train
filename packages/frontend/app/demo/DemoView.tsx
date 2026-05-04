"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import styles from "./demo.module.css";
import type { SessionInfo } from "../../lib/api";

type RealAgentKind = "minecraft" | "playwright";

type Workspace = {
  id: string;
  kicker: string;
  label: string;
  thumb: { kind: "video"; src: string } | { kind: "img"; src: string } | { kind: "preview"; title: string };
  // No `real` block = "not implemented yet" — alert and do nothing else.
  // `agentKind: null` = real workspace with no Claude agent (e.g. SPECTRE,
  // which is a self-driving Flask dashboard); switching pauses every agent.
  real?: {
    workspaceIndex: number;
    agentKind: RealAgentKind | null;
    task?: string;
  };
};

type Group = {
  id: "primary" | "dashboard" | "feeds";
  label: string;
  rowClass: "gifRowPrimary" | "gifRowDashboard";
  tiles: Workspace[];
};

const NEWS_TASK =
  "Doomscroll the latest AI news. Open one or two of: Hacker News, TechCrunch AI section, The Verge AI tag, ArsTechnica AI tag. Read headlines and skim articles.";

const GROUPS: Group[] = [
  {
    id: "primary",
    label: "Core demos",
    rowClass: "gifRowPrimary",
    tiles: [
      {
        // SPECTRE is workspace 3 in the arcade plugin: a Flask dashboard
        // running inside the stream-client container with a Chromium kiosk
        // pointed at it. No Claude agent — it's self-driving — so we pass
        // agentKind=null which pauses every running agent.
        id: "spectre",
        kicker: "01 / OSINT",
        label: "OSINT / SPECTRE",
        thumb: { kind: "video", src: "/demo/videos/spectre.mp4" },
        real: { workspaceIndex: 3, agentKind: null },
      },
      {
        id: "minecraft",
        kicker: "02 / WORLD",
        label: "Minecraft AI",
        thumb: { kind: "img", src: "/demo/gifs/minecraft.gif" },
        real: { workspaceIndex: 1, agentKind: "minecraft" },
      },
      {
        id: "news",
        kicker: "03 / FEED",
        label: "AI News Feed",
        thumb: { kind: "video", src: "/demo/videos/news.mp4" },
        real: { workspaceIndex: 2, agentKind: "playwright", task: NEWS_TASK },
      },
    ],
  },
  {
    id: "dashboard",
    label: "Generated dashboard prototypes",
    rowClass: "gifRowDashboard",
    tiles: [
      { id: "world-monitor", kicker: "04 / GEO", label: "World Monitor", thumb: { kind: "video", src: "/demo/videos/world-monitor.mp4" } },
      { id: "glance", kicker: "05 / NEWS", label: "Glance / Feeds", thumb: { kind: "video", src: "/demo/videos/glance.mp4" } },
      { id: "crypto-trading", kicker: "06 / CRYPTO", label: "Crypto Trading", thumb: { kind: "video", src: "/demo/videos/crypto-trading.mp4" } },
      { id: "polyrec", kicker: "07 / PRED", label: "Polyrec / Polymarket", thumb: { kind: "video", src: "/demo/videos/polyrec.mp4" } },
      { id: "dashboard123", kicker: "08 / MARKETS", label: "Dashboard123", thumb: { kind: "video", src: "/demo/videos/dashboard123.mp4" } },
      { id: "arena", kicker: "09 / ARENA", label: "AI vs AI Arena", thumb: { kind: "video", src: "/demo/videos/arena.mp4" } },
    ],
  },
  {
    id: "feeds",
    label: "Intelligence feeds",
    rowClass: "gifRowDashboard",
    tiles: [
      { id: "biotech", kicker: "10 / BIO", label: "Biotech / CRISPR", thumb: { kind: "video", src: "/demo/videos/biotech.mp4" } },
      { id: "space", kicker: "11 / SPACE", label: "Deep Space", thumb: { kind: "video", src: "/demo/videos/space.mp4" } },
      { id: "iran", kicker: "12 / IRAN", label: "Iran Signal", thumb: { kind: "video", src: "/demo/videos/iran.mp4" } },
      { id: "meme-coin", kicker: "13 / DEGEN", label: "Meme Coin Temple", thumb: { kind: "video", src: "/demo/videos/meme-coin.mp4" } },
      { id: "quantum", kicker: "14 / QUANT", label: "Quantum States", thumb: { kind: "video", src: "/demo/videos/quantum.mp4" } },
      { id: "deep-sea", kicker: "15 / ABYSS", label: "Abyssal Monitor", thumb: { kind: "video", src: "/demo/videos/deep-sea.mp4" } },
      { id: "power-grid", kicker: "16 / GRID", label: "Power Grid", thumb: { kind: "video", src: "/demo/videos/power-grid.mp4" } },
      { id: "viral", kicker: "17 / VIRAL", label: "Viral Spread", thumb: { kind: "video", src: "/demo/videos/viral.mp4" } },
      { id: "dark-forest", kicker: "18 / VOID", label: "Dark Forest", thumb: { kind: "video", src: "/demo/videos/dark-forest.mp4" } },
    ],
  },
];

type AgentCommand = {
  action: "switch" | "home" | "unknown";
  workspace: string | null;
  speech: string;
  audio?: string;
  id?: string;
};

type LayoutMode = "showcase" | "rows" | "spotlight";
const LAYOUT_MODES: { id: LayoutMode; label: string }[] = [
  { id: "showcase", label: "Showcase" },
  { id: "rows", label: "Rows" },
  { id: "spotlight", label: "Spotlight" },
];
const LAYOUT_STORAGE_KEY = "katechon.dashboardTileLayout.v1";

type AvatarPlacement = {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  modelY: number;
};
const AVATAR_DEFAULTS: AvatarPlacement = {
  x: 66.666,
  y: 0,
  w: 33.333,
  h: 100,
  scale: 0.755,
  modelY: 1.35,
};
const AVATAR_STORAGE_KEY = "katechon.browserAvatarPlacement.v1";
const TTS_MODE_STORAGE_KEY = "katechon.ttsMode.v1";
const VOICE_URI_STORAGE_KEY = "katechon.browserVoiceURI.v1";

type TtsMode = "elevenlabs" | "browser";

const ALL_TILES: Workspace[] = GROUPS.flatMap((g) => g.tiles);
const TILE_BY_ID = new Map(ALL_TILES.map((t) => [t.id, t]));

export default function DemoView({
  initialSession,
}: {
  initialSession: SessionInfo;
}) {
  const [session, setSession] = useState<SessionInfo>(initialSession);
  const [statusText, setStatusText] = useState("connecting...");
  const [activeWs, setActiveWs] = useState<string | null>(null);
  const [busyWs, setBusyWs] = useState<string | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("showcase");
  const [spotlightFocus, setSpotlightFocus] = useState(0);
  const [transcript, setTranscript] = useState<{ text: string; color: string } | null>(null);
  const [listening, setListening] = useState(false);
  const [avatarPlacement, setAvatarPlacement] = useState<AvatarPlacement>(AVATAR_DEFAULTS);
  const [avatarToolsOpen, setAvatarToolsOpen] = useState(false);
  const [ttsMode, setTtsMode] = useState<TtsMode | null>(null);
  const ttsModeRef = useRef<TtsMode | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState<string | null>(null);
  const selectedVoiceURIRef = useRef<string | null>(null);
  const lastNarrationEventIdRef = useRef<number>(0);
  const [narrationStats, setNarrationStats] = useState<{
    heard: number;
    lastPollAt: number | null;
    lastPollOk: boolean;
    lastNarrationAt: number | null;
  }>({ heard: 0, lastPollAt: null, lastPollOk: false, lastNarrationAt: null });

  const videoRef = useRef<HTMLVideoElement>(null);
  const avatarFrameRef = useRef<HTMLIFrameElement>(null);
  const transcriptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const livestreamKickedOff = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const avatarReadyRef = useRef(false);
  const avatarReadyResolverRef = useRef<(() => void) | null>(null);
  const audioWaitersRef = useRef<Map<string, () => void>>(new Map());
  const groupsRef = useRef<HTMLDivElement>(null);

  // ---- Hydrate persisted state on mount --------------------------------
  useEffect(() => {
    try {
      const savedLayout = localStorage.getItem(LAYOUT_STORAGE_KEY) as LayoutMode | null;
      if (savedLayout && LAYOUT_MODES.some((m) => m.id === savedLayout)) {
        setLayoutMode(savedLayout);
      }
      const savedPlacement = JSON.parse(localStorage.getItem(AVATAR_STORAGE_KEY) || "null");
      if (savedPlacement && typeof savedPlacement === "object") {
        setAvatarPlacement({
          x: numOrDefault(savedPlacement.x, AVATAR_DEFAULTS.x),
          y: numOrDefault(savedPlacement.y, AVATAR_DEFAULTS.y),
          w: numOrDefault(savedPlacement.w, AVATAR_DEFAULTS.w),
          h: numOrDefault(savedPlacement.h, AVATAR_DEFAULTS.h),
          scale: numOrDefault(savedPlacement.scale, AVATAR_DEFAULTS.scale),
          modelY: numOrDefault(savedPlacement.modelY, AVATAR_DEFAULTS.modelY),
        });
      }
      const savedMode = localStorage.getItem(TTS_MODE_STORAGE_KEY);
      if (savedMode === "elevenlabs" || savedMode === "browser") {
        setTtsMode(savedMode);
        ttsModeRef.current = savedMode;
      }
      const savedVoiceURI = localStorage.getItem(VOICE_URI_STORAGE_KEY);
      if (savedVoiceURI) {
        setSelectedVoiceURI(savedVoiceURI);
        selectedVoiceURIRef.current = savedVoiceURI;
      }
    } catch {
      // ignore localStorage parse errors
    }
  }, []);

  // ---- Push the chosen tts_mode to the broker (so narrate.py reads it). The
  // modal calls applyTtsMode() on first pick; mounting also re-syncs in case
  // the mode is in localStorage but the session was just created.
  const applyTtsMode = useCallback(
    (mode: TtsMode) => {
      setTtsMode(mode);
      ttsModeRef.current = mode;
      try {
        localStorage.setItem(TTS_MODE_STORAGE_KEY, mode);
      } catch {
        // ignore
      }
      fetch("/api/demo/tts-mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: session.id, mode }),
      }).catch(() => {});
      if (mode === "browser" && typeof window !== "undefined" && "speechSynthesis" in window) {
        // Prime speechSynthesis under the user gesture from the modal/toggle
        // click so the first real utterance isn't blocked.
        try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(" ")); } catch {}
      }
    },
    [session.id],
  );

  // ---- Re-sync mode to broker whenever the session id changes (e.g.
  // localStorage already had a pick from a prior session).
  useEffect(() => {
    if (!ttsMode) return;
    fetch("/api/demo/tts-mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: session.id, mode: ttsMode }),
    }).catch(() => {});
  }, [session.id, ttsMode]);

  // ---- Start / stop the broker-side narrator task. Only meaningful in
  // browser mode for /demo (the polling effect below is what consumes the
  // narrations); elevenlabs mode would need a separate audio-synthesis sink
  // before it's worth burning Anthropic tokens on narration.
  useEffect(() => {
    if (ttsMode !== "browser") return;
    fetch("/api/demo/narration/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: session.id }),
    })
      .then((r) => {
        if (!r.ok) console.warn("narration/start failed:", r.status);
      })
      .catch((err) => console.warn("narration/start error:", err));
    return () => {
      // Best-effort stop on unmount / session change. keepalive ensures the
      // request ships during page unload.
      fetch("/api/demo/narration/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: session.id }),
        keepalive: true,
      }).catch(() => {});
    };
  }, [session.id, ttsMode]);

  // ---- Load speechSynthesis voices ------------------------------------
  // Chrome populates voices asynchronously and fires `voiceschanged` once
  // they're ready. Other browsers return them synchronously.
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const refresh = () => {
      const list = window.speechSynthesis.getVoices();
      if (list.length) setVoices(list);
    };
    refresh();
    window.speechSynthesis.addEventListener("voiceschanged", refresh);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", refresh);
  }, []);

  // ---- Poll session for stream_url + status ----------------------------
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

  // ---- Once stream_url is up, attach hls.js ----------------------------
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
        setStatusText("LIVE — katechon-desktop");
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
        setStatusText("LIVE — katechon-desktop");
      });
    }
  }, [session.stream_url]);

  // ---- Narration polling: when ttsMode === "browser", narrate.py emits
  // narration text into broker events (kind="narration") instead of
  // synthesizing audio. Pull new ones every few seconds and feed each
  // through speechSynthesis. The browser's own queue serializes them.
  useEffect(() => {
    if (ttsMode !== "browser") return;
    let cancelled = false;
    // Skip whatever's already in the log when we switch into browser mode —
    // we only want to speak narrations going forward.
    let initialized = false;
    async function tick() {
      if (cancelled) return;
      const pollStartedAt = Date.now();
      try {
        const after = lastNarrationEventIdRef.current;
        const r = await fetch(
          `/api/demo/narrations?session_id=${encodeURIComponent(session.id)}&after=${after}&limit=50`,
          { cache: "no-store" },
        );
        if (r.ok) {
          const data = (await r.json()) as {
            lastId: number;
            narrations: { id: number; text: string }[];
          };
          if (typeof data.lastId === "number" && data.lastId > lastNarrationEventIdRef.current) {
            lastNarrationEventIdRef.current = data.lastId;
          }
          let heardThisTick = 0;
          if (initialized) {
            for (const n of data.narrations) {
              speakInBrowser({ text: n.text }).catch((err) => {
                console.warn("narration speak failed:", err);
              });
              heardThisTick += 1;
            }
          }
          initialized = true;
          setNarrationStats((prev) => ({
            heard: prev.heard + heardThisTick,
            lastPollAt: pollStartedAt,
            lastPollOk: true,
            lastNarrationAt: heardThisTick > 0 ? pollStartedAt : prev.lastNarrationAt,
          }));
        } else {
          setNarrationStats((prev) => ({
            ...prev,
            lastPollAt: pollStartedAt,
            lastPollOk: false,
          }));
        }
      } catch {
        setNarrationStats((prev) => ({
          ...prev,
          lastPollAt: pollStartedAt,
          lastPollOk: false,
        }));
      }
    }
    tick();
    const interval = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, ttsMode]);

  // ---- Heartbeat: tell the broker the demo viewer is still here -------
  // Broker's agent_idle_pauser pauses every running agent for this session
  // once these stop arriving for >20s.
  useEffect(() => {
    let cancelled = false;
    async function ping() {
      if (cancelled || document.visibilityState === "hidden") return;
      try {
        await fetch("/api/demo/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: session.id }),
          keepalive: true,
        });
      } catch {
        /* ignore — next tick will retry */
      }
    }
    ping();
    const interval = setInterval(ping, 5000);
    const onVisible = () => {
      if (document.visibilityState === "visible") ping();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session.id]);

  // ---- Kick livestream once preview is ready ---------------------------
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

  // ---- Avatar placement → iframe/postMessage --------------------------
  useEffect(() => {
    postToAvatar({
      type: "tune",
      scale: avatarPlacement.scale,
      yFactor: avatarPlacement.modelY,
    });
  }, [avatarPlacement.scale, avatarPlacement.modelY]);

  // ---- postMessage from avatar (ready / audio-ended) ------------------
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as { type?: string; id?: string } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "avatar-ready") {
        avatarReadyRef.current = true;
        // Push the saved placement again so the model lands in the right spot.
        postToAvatar({
          type: "tune",
          scale: avatarPlacement.scale,
          yFactor: avatarPlacement.modelY,
        });
        avatarReadyResolverRef.current?.();
        avatarReadyResolverRef.current = null;
        return;
      }
      if (data.type === "audio-ended" && data.id) {
        const cb = audioWaitersRef.current.get(data.id);
        if (cb) {
          audioWaitersRef.current.delete(data.id);
          cb();
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [avatarPlacement.scale, avatarPlacement.modelY]);

  // ---- Layout persistence ---------------------------------------------
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, layoutMode);
    } catch {
      // ignore
    }
  }, [layoutMode]);

  // ---- Spotlight focus tracker (scroll → focused tile) ----------------
  useEffect(() => {
    if (layoutMode !== "spotlight") {
      setSpotlightFocus(0);
      return;
    }
    const root = groupsRef.current;
    if (!root) return;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const tiles = Array.from(root.querySelectorAll<HTMLElement>(".gif-box"));
      if (tiles.length < 2) return;
      const rootRect = root.getBoundingClientRect();
      const targetY = rootRect.top + rootRect.height * 0.42;
      let nearest = 0;
      let nearestDist = Infinity;
      tiles.forEach((tile, idx) => {
        const rect = tile.getBoundingClientRect();
        const center = rect.top + rect.height * 0.5;
        const dist = Math.abs(center - targetY);
        if (dist < nearestDist) {
          nearest = idx;
          nearestDist = dist;
        }
      });
      setSpotlightFocus(nearest);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    root.scrollTop = 0;
    compute();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [layoutMode]);

  // ---- Toast helper ----------------------------------------------------
  const showToast = useCallback((text: string, color = "#e8e8ec") => {
    setTranscript({ text, color });
    if (transcriptTimer.current) clearTimeout(transcriptTimer.current);
    transcriptTimer.current = setTimeout(() => setTranscript(null), 3000);
  }, []);

  // ---- Avatar helpers -------------------------------------------------
  function postToAvatar(message: Record<string, unknown>) {
    avatarFrameRef.current?.contentWindow?.postMessage(message, "*");
  }

  function unlockAvatarAudio() {
    postToAvatar({ type: "unlock" });
  }

  async function waitForAvatarReady(timeoutMs = 6000) {
    if (avatarReadyRef.current) return;
    await new Promise<void>((resolve) => {
      avatarReadyResolverRef.current = resolve;
      setTimeout(resolve, timeoutMs);
    });
  }

  async function playThroughAvatar(payload: { id?: string; text?: string; audio?: string }) {
    if (!payload.audio) return;
    await waitForAvatarReady();
    const id = payload.id || `agent-audio-${Date.now()}`;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 30_000);
      audioWaitersRef.current.set(id, () => {
        clearTimeout(timeout);
        resolve();
      });
      postToAvatar({ type: "audio", id, text: payload.text || "", audio: payload.audio });
    });
  }

  // speechSynthesis output isn't capturable into Web Audio, so the avatar's
  // analyser-driven lip-sync sees silence. We bypass it by driving
  // ParamMouthOpenY directly via the iframe's `mouth` postMessage on
  // utterance lifecycle events: open on start, flutter on each word boundary,
  // release on end.
  async function speakInBrowser(payload: { text?: string }) {
    if (!payload.text) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    await waitForAvatarReady();
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        postToAvatar({ type: "mouth" });
        resolve();
      };
      const timeout = setTimeout(finish, 30_000);
      const u = new SpeechSynthesisUtterance(payload.text!);
      const wantedURI = selectedVoiceURIRef.current;
      if (wantedURI) {
        const v = window.speechSynthesis.getVoices().find((vv) => vv.voiceURI === wantedURI);
        if (v) u.voice = v;
      }
      u.onstart = () => postToAvatar({ type: "mouth", value: 0.6 });
      u.onboundary = () => {
        postToAvatar({ type: "mouth", value: 0.9 });
        window.setTimeout(() => postToAvatar({ type: "mouth", value: 0.4 }), 80);
      };
      u.onend = finish;
      u.onerror = finish;
      window.speechSynthesis.speak(u);
    });
  }

  // ---- Workspace switching --------------------------------------------
  const switchWs = useCallback(
    async (ws: Workspace) => {
      if (busyWs) return;
      if (!ws.real) {
        showToast(`${ws.label}: not implemented yet`, "#ffbd2e");
        alert("not implemented yet");
        return;
      }
      setBusyWs(ws.id);
      setActiveWs(ws.id);
      try {
        const swR = await fetch(`/api/sessions/${session.id}/workspace/switch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspace: ws.real.workspaceIndex }),
        });
        if (!swR.ok) {
          const text = await swR.text().catch(() => "");
          showToast(`switch failed: ${text.slice(0, 80) || swR.status}`, "#ff4444");
          return;
        }
        fetch(`/api/demo/agents/select`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: session.id,
            agent_kind: ws.real.agentKind,
            task: ws.real.task,
          }),
        }).catch(() => {});
        setShowOverlay(false);
      } finally {
        setBusyWs(null);
      }
    },
    [busyWs, session.id, showToast],
  );

  const goHome = useCallback(() => {
    setShowOverlay(true);
    setActiveWs(null);
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
  }, [session.id]);

  // ---- Push-to-talk → /api/demo/agent ---------------------------------
  async function handleCommand(text: string) {
    showToast(`"${text}"`);
    const r = await fetch("/api/demo/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transcript: text,
        session_id: session.id,
        ...(ttsMode === "browser" ? { tts: "browser" } : {}),
      }),
    });
    if (!r.ok) {
      showToast(`agent error (${r.status})`, "#ff4444");
      return;
    }
    const cmd = (await r.json()) as AgentCommand;
    if (cmd.speech) showToast(`Kat: ${cmd.speech}`, "#00e87b");
    if (cmd.action === "switch" && cmd.workspace) {
      const target = TILE_BY_ID.get(cmd.workspace);
      if (target) switchWs(target);
    } else if (cmd.action === "home") {
      goHome();
    }
    if (ttsMode === "browser" && cmd.speech) {
      speakInBrowser({ text: cmd.speech }).catch((err) => {
        console.warn("browser TTS failed:", err);
      });
    } else if (cmd.audio) {
      playThroughAvatar({ id: cmd.id, text: cmd.speech, audio: cmd.audio }).catch((err) => {
        console.warn("avatar audio failed:", err);
      });
    }
  }

  async function startRecording() {
    unlockAvatarAudio();
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
      } catch (e) {
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

  // ---- Avatar tools handlers ------------------------------------------
  const updatePlacement = (key: keyof AvatarPlacement, value: number) =>
    setAvatarPlacement((prev) => ({ ...prev, [key]: value }));

  const saveAvatarPlacement = () => {
    try {
      localStorage.setItem(AVATAR_STORAGE_KEY, JSON.stringify(avatarPlacement));
      showToast("avatar placement saved", "#00e87b");
    } catch {
      showToast("save failed", "#ff4444");
    }
  };

  const resetAvatarPlacement = () => {
    setAvatarPlacement({ ...AVATAR_DEFAULTS });
    try {
      localStorage.removeItem(AVATAR_STORAGE_KEY);
    } catch {
      // ignore
    }
    showToast("avatar placement reset", "#00e87b");
  };

  // ---- Render ---------------------------------------------------------
  const previewReady =
    !!session.stream_url && ["waiting", "running"].includes(session.status);
  const layoutLabel =
    LAYOUT_MODES.find((m) => m.id === layoutMode)?.label ?? "Showcase";

  return (
    <div className={styles.root}>
      {ttsMode === null && (
        <div className={styles.ttsModal} role="dialog" aria-modal="true">
          <div className={styles.ttsModalCard}>
            <div className={styles.ttsModalKicker}>Pick a voice</div>
            <h2 className={styles.ttsModalTitle}>How should the avatar speak?</h2>
            <p className={styles.ttsModalBody}>
              The narrator can either synthesize audio server-side via
              ElevenLabs (premium voice, lip-sync from real audio) or speak
              locally via your browser&apos;s built-in TTS (free, lip-sync
              approximated). You can switch later from the Avatar panel.
            </p>
            <div className={styles.ttsModalActions}>
              <button
                type="button"
                className={styles.ttsModalPrimary}
                onClick={() => applyTtsMode("elevenlabs")}
              >
                ElevenLabs (premium)
              </button>
              <button
                type="button"
                className={styles.ttsModalSecondary}
                onClick={() => applyTtsMode("browser")}
              >
                Browser voice (free)
              </button>
            </div>
          </div>
        </div>
      )}
      <div className={styles.desktopFallback} aria-hidden />
      <video
        ref={videoRef}
        className={styles.video}
        autoPlay
        muted
        playsInline
      />

      <div
        className={styles.browserAvatarWrap}
        style={{
          left: `${avatarPlacement.x}vw`,
          top: `${avatarPlacement.y}vh`,
          width: `${avatarPlacement.w}vw`,
          height: `${avatarPlacement.h}vh`,
        }}
        aria-hidden
      >
        <iframe
          ref={avatarFrameRef}
          className={styles.browserAvatar}
          src="/demo/avatar-pet.html?model=0&w=640&h=1080"
          title="VTuber avatar"
          allow="autoplay"
        />
      </div>

      <div className={styles.status}>
        <span className={styles.statusDot} />
        <span>{previewReady ? statusText : `spinning up… (${session.status})`}</span>
      </div>

      {showOverlay && (
        <div
          className={`${styles.overlay} ${styles.mainOverlay}`}
          data-layout={layoutMode}
        >
          <div className={styles.mainHead}>
            <div className={styles.mainKicker}>
              <span className={styles.statusDot} />
              <span>Katechon live</span>
            </div>
            <div className={styles.mainTitle}>Katechon Demo</div>
            <div className={styles.mainSub}>24hr interactive livestream</div>
            <div className={styles.layoutControlRow}>
              <button
                type="button"
                className={styles.layoutToggle}
                title="Change video layout"
                aria-label={`Video layout: ${layoutLabel}`}
                onClick={() =>
                  setLayoutMode((mode) => {
                    const idx = LAYOUT_MODES.findIndex((m) => m.id === mode);
                    return LAYOUT_MODES[(idx + 1) % LAYOUT_MODES.length].id;
                  })
                }
              >
                <span>Layout</span>
                <strong>{layoutLabel}</strong>
                <span className={styles.layoutDots} aria-hidden>
                  {LAYOUT_MODES.map((m) => (
                    <span
                      key={m.id}
                      className={`${styles.layoutDot} ${
                        m.id === layoutMode ? styles.layoutDotActive : ""
                      }`}
                    />
                  ))}
                </span>
              </button>
            </div>
          </div>
          <div className={styles.mainDivider} />
          <div className={styles.gifGroups} ref={groupsRef}>
            {GROUPS.map((group) => (
              <div className={styles.gifGroup} key={group.id}>
                <div className={styles.dashboardGroupLabel}>{group.label}</div>
                <div
                  className={`${styles.gifRow} ${styles[group.rowClass]}`}
                >
                  {group.tiles.map((tile, tileIndexInGroup) => {
                    const globalIdx = ALL_TILES.indexOf(tile);
                    const isFocus =
                      layoutMode === "spotlight" && globalIdx === spotlightFocus;
                    const dist =
                      layoutMode === "spotlight"
                        ? Math.abs(globalIdx - spotlightFocus)
                        : 0;
                    const spotlightClass =
                      layoutMode === "spotlight"
                        ? isFocus
                          ? styles.spotlightFocus
                          : dist <= 2
                          ? styles.spotlightSide
                          : styles.spotlightTail
                        : "";
                    return (
                      <button
                        key={tile.id}
                        type="button"
                        onClick={() => switchWs(tile)}
                        disabled={busyWs !== null || !previewReady}
                        className={`${styles.gifBox} ${
                          activeWs === tile.id ? styles.active : ""
                        } ${spotlightClass}`}
                        // The sub-prop was used in the old katechon-demo CSS to
                        // brightness-grade tiles by spotlight distance.
                        style={
                          layoutMode === "spotlight"
                            ? ({
                                ["--spotlight-glow" as string]: String(
                                  Math.max(0, 1 - dist * 0.34),
                                ),
                              } as React.CSSProperties)
                            : undefined
                        }
                        data-tile-index={tileIndexInGroup}
                      >
                        <div className={styles.tileKicker}>{tile.kicker}</div>
                        {tile.thumb.kind === "video" && (
                          <video
                            src={tile.thumb.src}
                            aria-label={tile.label}
                            autoPlay
                            muted
                            loop
                            playsInline
                            preload="metadata"
                            onError={(e) => {
                              (e.currentTarget as HTMLVideoElement).removeAttribute(
                                "src",
                              );
                              (e.currentTarget as HTMLVideoElement).load();
                            }}
                          />
                        )}
                        {tile.thumb.kind === "img" && (
                          <img src={tile.thumb.src} alt={tile.label} />
                        )}
                        {tile.thumb.kind === "preview" && (
                          <div className={styles.tilePreview} aria-hidden>
                            <div className={styles.tilePreviewInner}>
                              <div className={styles.tileLines}>
                                {Array.from({ length: 7 }).map((_, i) => (
                                  <span key={i} />
                                ))}
                              </div>
                              <div className={styles.tilePreviewTitle}>
                                {tile.thumb.title}
                              </div>
                            </div>
                          </div>
                        )}
                        <div className={styles.gifLabel}>{tile.label}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!showOverlay && (
        <button
          type="button"
          className={styles.menuBtn}
          onClick={goHome}
          aria-label="Show menu"
        >
          ≡ MENU
        </button>
      )}

      {transcript && (
        <div
          className={`${styles.transcriptToast} ${styles.transcriptVisible}`}
          style={{ color: transcript.color }}
        >
          {transcript.text}
        </div>
      )}

      <div
        className={`${styles.avatarTools} ${
          avatarToolsOpen ? "" : styles.avatarToolsCollapsed
        }`}
      >
        <button
          type="button"
          className={styles.avatarToolsToggle}
          onClick={() => setAvatarToolsOpen((v) => !v)}
        >
          Avatar
        </button>
        {avatarToolsOpen && (
          <div className={styles.avatarToolsPanel}>
            <div className={styles.toolHead}>
              <span>Placement</span>
              <button
                type="button"
                onClick={() => setAvatarToolsOpen(false)}
              >
                Hide
              </button>
            </div>
            <Slider
              label="X"
              value={avatarPlacement.x}
              min={-20}
              max={90}
              step={0.5}
              format={(v) => `${v.toFixed(1)}%`}
              onChange={(v) => updatePlacement("x", v)}
            />
            <Slider
              label="Y"
              value={avatarPlacement.y}
              min={-20}
              max={30}
              step={0.5}
              format={(v) => `${v.toFixed(1)}%`}
              onChange={(v) => updatePlacement("y", v)}
            />
            <Slider
              label="W"
              value={avatarPlacement.w}
              min={20}
              max={60}
              step={0.5}
              format={(v) => `${v.toFixed(1)}%`}
              onChange={(v) => updatePlacement("w", v)}
            />
            <Slider
              label="H"
              value={avatarPlacement.h}
              min={55}
              max={130}
              step={0.5}
              format={(v) => `${v.toFixed(1)}%`}
              onChange={(v) => updatePlacement("h", v)}
            />
            <Slider
              label="Scale"
              value={avatarPlacement.scale}
              min={0.45}
              max={1.1}
              step={0.005}
              format={(v) => v.toFixed(3)}
              onChange={(v) => updatePlacement("scale", v)}
            />
            <Slider
              label="Model Y"
              value={avatarPlacement.modelY}
              min={0.9}
              max={1.65}
              step={0.005}
              format={(v) => v.toFixed(3)}
              onChange={(v) => updatePlacement("modelY", v)}
            />
            <div className={styles.toolActions}>
              <button type="button" onClick={saveAvatarPlacement}>
                Save
              </button>
              <button type="button" onClick={resetAvatarPlacement}>
                Reset
              </button>
            </div>
            <div className={styles.voiceToggle}>
              <span>
                TTS: <strong>{ttsMode ?? "(not set)"}</strong>
              </span>
              <button
                type="button"
                className={styles.voiceToggleSwitch}
                onClick={() => applyTtsMode(ttsMode === "browser" ? "elevenlabs" : "browser")}
              >
                Switch to {ttsMode === "browser" ? "ElevenLabs" : "browser"}
              </button>
            </div>
            {ttsMode === "browser" && (
              <div className={styles.voicePicker}>
                <label className={styles.voicePickerLabel}>
                  Voice
                  <select
                    value={selectedVoiceURI ?? ""}
                    onChange={(e) => {
                      const v = e.target.value || null;
                      setSelectedVoiceURI(v);
                      selectedVoiceURIRef.current = v;
                      try {
                        if (v) localStorage.setItem(VOICE_URI_STORAGE_KEY, v);
                        else localStorage.removeItem(VOICE_URI_STORAGE_KEY);
                      } catch {
                        // ignore
                      }
                    }}
                  >
                    <option value="">(system default)</option>
                    {voices.map((v) => (
                      <option key={v.voiceURI} value={v.voiceURI}>
                        {v.name} — {v.lang}
                        {v.default ? " ★" : ""}
                        {v.localService ? "" : " (remote)"}
                      </option>
                    ))}
                  </select>
                </label>
                <div className={styles.voicePickerActions}>
                  <span className={styles.voiceCount}>
                    {voices.length === 0
                      ? "no voices found — install a system TTS engine (e.g. espeak)"
                      : `${voices.length} voice${voices.length === 1 ? "" : "s"} available`}
                  </span>
                  <button
                    type="button"
                    disabled={voices.length === 0}
                    onClick={() => {
                      speakInBrowser({ text: "Hi, I'm your avatar. This is a voice test." }).catch(
                        (err) => console.warn("voice test failed:", err),
                      );
                    }}
                  >
                    Test
                  </button>
                </div>
                <div className={styles.narrationStats}>
                  <div>
                    narrations heard:{" "}
                    <strong>{narrationStats.heard}</strong>
                  </div>
                  <div>
                    last poll:{" "}
                    {narrationStats.lastPollAt
                      ? `${Math.max(0, Math.round((Date.now() - narrationStats.lastPollAt) / 1000))}s ago${
                          narrationStats.lastPollOk ? "" : " (failed)"
                        }`
                      : "—"}
                  </div>
                  <div>
                    last narration:{" "}
                    {narrationStats.lastNarrationAt
                      ? `${Math.max(0, Math.round((Date.now() - narrationStats.lastNarrationAt) / 1000))}s ago`
                      : "none yet"}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

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

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className={styles.toolRow}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className={styles.toolValue}>{format(value)}</span>
    </label>
  );
}

function numOrDefault(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
