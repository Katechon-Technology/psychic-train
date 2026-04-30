// Persistent Chromium controller. Modeled on
// plugins/playwright-browser/stream-client/pw-browser/src/browser.ts — same
// extension loading, same auto-close-extension-tab handling, same persistent
// profile pattern — but adapted for *multi-tab* desktop use: kiosk is off, we
// expose tabs by id, and we don't do full DOM snapshots (the agent uses
// xdotool/screenshot to click visually when it wants).

import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const PROFILE_DIR =
  process.env.PLAYWRIGHT_BROWSER_PROFILE ?? "/workspace/.browser-profile";
const KIOSK_MODE = process.env.PLAYWRIGHT_BROWSER_KIOSK === "1";
const EXTENSION_PATHS = (process.env.PLAYWRIGHT_BROWSER_EXTENSIONS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface Tab {
  id: string;
  page: Page;
  createdAt: number;
}

let sharedContext: BrowserContext | null = null;
const tabs = new Map<string, Tab>();
const pageToId = new WeakMap<Page, string>();

async function getContext(): Promise<BrowserContext> {
  if (sharedContext) return sharedContext;
  await mkdir(PROFILE_DIR, { recursive: true });

  const args = ["--disable-blink-features=AutomationControlled", "--no-first-run"];
  if (KIOSK_MODE) {
    args.push("--kiosk", "--start-maximized");
  } else {
    // Default to a sub-screen window sized for the right-half tile so the
    // seed xterms on the left stay visible. seed_layout.sh and the agent's
    // window/tile tool re-place it later if needed.
    const w = Number(process.env.DISPLAY_WIDTH ?? "1600");
    const h = Number(process.env.DISPLAY_HEIGHT ?? "900");
    args.push(`--window-size=${Math.floor(w / 2)},${h - 60}`);
    args.push(`--window-position=${Math.floor(w / 2)},20`);
  }
  if (EXTENSION_PATHS.length) {
    args.push(`--disable-extensions-except=${EXTENSION_PATHS.join(",")}`);
    args.push(`--load-extension=${EXTENSION_PATHS.join(",")}`);
  }

  console.log(
    `[browser] launching Chromium kiosk=${KIOSK_MODE} ext=${EXTENSION_PATHS.length} args=${JSON.stringify(args)}`,
  );

  sharedContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: EXTENSION_PATHS.length ? "chromium" : undefined,
    headless: false,
    viewport: null,
    args,
  });
  sharedContext.on("close", () => {
    sharedContext = null;
    tabs.clear();
  });

  // Auto-close extension-installed onboarding tabs (Consent-O-Matic in
  // particular pops one). Same pattern as pw-browser.
  if (EXTENSION_PATHS.length) {
    const closeIfExtension = async (p: Page) => {
      try {
        await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
        const url = p.url();
        if (url.startsWith("chrome-extension://") || url.startsWith("chrome://")) {
          console.log(`[browser] auto-closing extension tab: ${url}`);
          await p.close();
        }
      } catch {
        // already closed
      }
    };
    sharedContext.on("page", (p) => void closeIfExtension(p));
    for (const p of sharedContext.pages()) await closeIfExtension(p);
  }

  // Track new tabs the user/agent opens via window.open() etc.
  sharedContext.on("page", (p) => {
    if (pageToId.has(p)) return;
    const id = "tab-" + randomBytes(3).toString("hex");
    tabs.set(id, { id, page: p, createdAt: Date.now() });
    pageToId.set(p, id);
    p.on("close", () => tabs.delete(id));
  });

  return sharedContext;
}

function ensureTab(id: string): Tab {
  const t = tabs.get(id);
  if (!t) {
    throw Object.assign(new Error(`tab ${id} not found`), { statusCode: 404 });
  }
  if (t.page.isClosed()) {
    tabs.delete(id);
    throw Object.assign(new Error(`tab ${id} already closed`), { statusCode: 410 });
  }
  return t;
}

export async function newTab(url: string): Promise<{ tab_id: string }> {
  const ctx = await getContext();
  const page = await ctx.newPage();
  const id = "tab-" + randomBytes(3).toString("hex");
  tabs.set(id, { id, page, createdAt: Date.now() });
  pageToId.set(page, id);
  page.on("close", () => tabs.delete(id));
  if (url && url !== "about:blank") {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((e) => {
      console.log(`[browser] initial goto ${url} failed: ${e}`);
    });
  }
  await page.bringToFront().catch(() => {});
  return { tab_id: id };
}

export async function closeTab(id: string): Promise<void> {
  const t = tabs.get(id);
  if (!t) return;
  await t.page.close().catch(() => {});
  tabs.delete(id);
}

export function listTabs(): Array<{
  id: string;
  url: string;
  title: string;
  createdAt: number;
}> {
  const out: Array<{ id: string; url: string; title: string; createdAt: number }> = [];
  for (const t of tabs.values()) {
    if (t.page.isClosed()) continue;
    out.push({
      id: t.id,
      url: t.page.url(),
      title: "",
      createdAt: t.createdAt,
    });
  }
  return out;
}

export async function navigate(
  id: string,
  url: string,
): Promise<{ url: string; title: string }> {
  const t = ensureTab(id);
  await t.page.bringToFront().catch(() => {});
  await t.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return { url: t.page.url(), title: await t.page.title().catch(() => "") };
}

export async function focusTab(id: string): Promise<void> {
  const t = ensureTab(id);
  await t.page.bringToFront().catch(() => {});
}

export async function scrollTab(
  id: string,
  dy: number,
): Promise<void> {
  const t = ensureTab(id);
  await t.page.mouse.wheel(0, dy);
}

export async function clickTab(
  id: string,
  arg: { selector?: string; x?: number; y?: number; button?: "left" | "right" | "middle" },
): Promise<void> {
  const t = ensureTab(id);
  if (arg.selector) {
    await t.page.locator(arg.selector).first().click({ button: arg.button ?? "left", timeout: 10_000 });
    return;
  }
  if (arg.x !== undefined && arg.y !== undefined) {
    await t.page.mouse.click(arg.x, arg.y, { button: arg.button ?? "left" });
    return;
  }
  throw Object.assign(new Error("must provide selector or {x,y}"), { statusCode: 400 });
}

export async function typeIntoTab(
  id: string,
  arg: { selector?: string; text: string; submit?: boolean; clear?: boolean },
): Promise<void> {
  const t = ensureTab(id);
  if (arg.selector) {
    const loc = t.page.locator(arg.selector).first();
    if (arg.clear) await loc.fill("");
    await loc.fill(arg.text);
    if (arg.submit) await loc.press("Enter");
    return;
  }
  // No selector: type into whatever's currently focused.
  await t.page.keyboard.type(arg.text);
  if (arg.submit) await t.page.keyboard.press("Enter");
}

const DIGEST_JS = `(() => {
  const trim = (s) => (s || '').trim().replace(/\\s+/g, ' ');
  const title = (document.title || '').slice(0, 200);
  let description = null;
  const md = document.querySelector('meta[name="description"]') ||
             document.querySelector('meta[property="og:description"]');
  if (md) {
    const c = md.getAttribute('content');
    if (c) description = trim(c).slice(0, 300);
  }
  const headings = [];
  const seen = new Set();
  for (const h of document.querySelectorAll('h1, h2, h3')) {
    const t = trim(h.textContent).slice(0, 120);
    if (!t || t.length < 4) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    headings.push(t);
    if (headings.length >= 15) break;
  }
  const links = [];
  const linkSeen = new Set();
  const buckets = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const r = a.getBoundingClientRect();
    if (r.height < 8) continue;
    const t = trim(a.textContent);
    if (t.length < 6 || t.length > 200) continue;
    if (linkSeen.has(t)) continue;
    const y = Math.round(r.top + window.scrollY);
    const bucket = Math.floor(y / 30);
    if (buckets.has(bucket)) continue;
    buckets.add(bucket);
    linkSeen.add(t);
    links.push({ text: t, href: a.href });
    if (links.length >= 20) break;
  }
  const paragraphs = [];
  for (const p of document.querySelectorAll('p')) {
    const t = trim(p.textContent);
    if (t.length < 80) continue;
    paragraphs.push(t.slice(0, 240));
    if (paragraphs.length >= 5) break;
  }
  return { url: location.href, title, description, headings, links, paragraphs };
})()`;

export async function digestTab(id: string): Promise<unknown> {
  const t = ensureTab(id);
  return t.page.evaluate(DIGEST_JS);
}

export async function shutdown(): Promise<void> {
  if (!sharedContext) return;
  try {
    await sharedContext.close();
  } catch {
    // ignore
  }
  sharedContext = null;
  tabs.clear();
}
