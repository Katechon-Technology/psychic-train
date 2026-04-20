import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Recorder } from "./recorder.ts";
import { SnapshotIndex } from "./snapshot.ts";

const PROFILE_DIR =
  process.env.PLAYWRIGHT_BROWSER_PROFILE ??
  join(homedir(), ".local/share/playwright-browser/profile");
const SESSIONS_ROOT =
  process.env.PLAYWRIGHT_BROWSER_SESSIONS ??
  join(process.cwd(), "sessions");
const VIEWPORT = { width: 1280, height: 800 };

export interface Session {
  id: string;
  dir: string;
  page: Page;
  recorder: Recorder;
  snapshot: SnapshotIndex;
  trace: boolean;
  startedAt: number;
}

let sharedContext: BrowserContext | null = null;
const sessions = new Map<string, Session>();

async function getContext(): Promise<BrowserContext> {
  if (sharedContext) return sharedContext;
  await mkdir(PROFILE_DIR, { recursive: true });
  sharedContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: VIEWPORT,
    recordVideo: { dir: join(SESSIONS_ROOT, ".video-staging"), size: VIEWPORT },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  sharedContext.on("close", () => {
    sharedContext = null;
  });
  return sharedContext;
}

export async function createSession(opts: { trace?: boolean } = {}): Promise<Session> {
  const ctx = await getContext();
  const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const dir = join(SESSIONS_ROOT, id);
  await mkdir(join(dir, "screenshots"), { recursive: true });

  const page = await ctx.newPage();
  if (opts.trace) {
    await ctx.tracing.start({ screenshots: true, snapshots: true, sources: true, name: id });
  }
  const recorder = new Recorder(dir);
  await recorder.init();
  const snapshot = new SnapshotIndex(page);

  const session: Session = {
    id,
    dir,
    page,
    recorder,
    snapshot,
    trace: !!opts.trace,
    startedAt: Date.now(),
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function listSessions(): Array<{ id: string; dir: string; startedAt: number }> {
  return [...sessions.values()].map((s) => ({ id: s.id, dir: s.dir, startedAt: s.startedAt }));
}

export async function closeSession(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);

  if (s.trace && sharedContext) {
    await sharedContext.tracing.stop({ path: join(s.dir, "trace.zip") });
  }

  const video = s.page.video();
  await s.page.close();
  if (video) {
    try {
      const src = await video.path();
      await rename(src, join(s.dir, "video.webm"));
    } catch {
      // video may not be ready yet; ignore
    }
  }
  await s.recorder.close();
}

export async function shutdown(): Promise<void> {
  for (const id of [...sessions.keys()]) await closeSession(id);
  if (sharedContext) {
    await sharedContext.close();
    sharedContext = null;
  }
}

export const config = { PROFILE_DIR, SESSIONS_ROOT, VIEWPORT };
