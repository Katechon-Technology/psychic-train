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

// Optional kiosk mode (no URL bar, no tabs, fullscreen) for streaming setups.
const KIOSK_MODE = !!process.env.PLAYWRIGHT_BROWSER_KIOSK;

// Optional comma-separated list of unpacked-extension directories. Loaded via
// --load-extension; --disable-extensions-except scopes Chromium to only these.
const EXTENSION_PATHS = (process.env.PLAYWRIGHT_BROWSER_EXTENSIONS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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

  const args = ["--disable-blink-features=AutomationControlled"];
  if (KIOSK_MODE) {
    args.push("--kiosk", "--start-maximized", "--no-first-run");
  }
  if (EXTENSION_PATHS.length) {
    args.push(`--disable-extensions-except=${EXTENSION_PATHS.join(",")}`);
    args.push(`--load-extension=${EXTENSION_PATHS.join(",")}`);
  }

  console.log(
    `[playwright-browser] launching Chromium kiosk=${KIOSK_MODE} extensions=${EXTENSION_PATHS.join(",") || "(none)"} args=${JSON.stringify(args)}`,
  );

  sharedContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    // `channel: 'chromium'` switches from the default headless-shell-leaning
    // build to the full Chromium binary, which is the only one Playwright
    // supports `--load-extension` on. Required whenever EXTENSION_PATHS is set.
    channel: EXTENSION_PATHS.length ? "chromium" : undefined,
    headless: false,
    // viewport: null in kiosk mode lets Chromium use the full window/screen
    // size; otherwise Playwright would emulate a fixed viewport inside chrome.
    viewport: KIOSK_MODE ? null : VIEWPORT,
    recordVideo: { dir: join(SESSIONS_ROOT, ".video-staging"), size: VIEWPORT },
    args,
  });
  sharedContext.on("close", () => {
    sharedContext = null;
  });

  // Extensions (notably Consent-O-Matic) open onboarding tabs on first install.
  // In kiosk mode that tab steals focus and hides whatever the agent is doing.
  // Auto-close anything that lands on a chrome-extension:// or chrome:// URL.
  if (EXTENSION_PATHS.length) {
    const closeIfExtensionPage = async (p: Page) => {
      try {
        await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
        const url = p.url();
        if (url.startsWith("chrome-extension://") || url.startsWith("chrome://")) {
          console.log(`[playwright-browser] auto-closing extension tab: ${url}`);
          await p.close();
        }
      } catch {
        // page may already be closed
      }
    };
    sharedContext.on("page", (p) => void closeIfExtensionPage(p));
    // Sweep tabs that opened before our listener attached.
    for (const p of sharedContext.pages()) await closeIfExtensionPage(p);
  }

  return sharedContext;
}

export async function createSession(opts: { trace?: boolean } = {}): Promise<Session> {
  const ctx = await getContext();
  const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const dir = join(SESSIONS_ROOT, id);
  await mkdir(join(dir, "screenshots"), { recursive: true });

  const page = await ctx.newPage();
  // In kiosk mode, only one tab is visible; ensure ours is the foregrounded one
  // even if an extension opened (and we closed) a tab moments earlier.
  await page.bringToFront().catch(() => {});
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
