import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

export interface ActionLog {
  ts: string;
  step: number;
  tool: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  screenshot?: string;
  durationMs: number;
}

export class Recorder {
  private step = 0;
  private logStream!: WriteStream;

  constructor(private dir: string) {}

  async init() {
    await mkdir(join(this.dir, "screenshots"), { recursive: true });
    this.logStream = createWriteStream(join(this.dir, "actions.jsonl"), { flags: "a" });
  }

  async close() {
    await new Promise<void>((res) => this.logStream.end(res));
  }

  /**
   * Wraps a tool handler. Records timing, arguments, result, and an
   * after-the-fact screenshot. Errors are caught, logged, and rethrown.
   */
  async record<T>(
    page: Page | undefined,
    tool: string,
    args: unknown,
    fn: () => Promise<T>,
    opts: { skipScreenshot?: boolean } = {},
  ): Promise<T> {
    const step = ++this.step;
    const started = Date.now();
    const entry: ActionLog = {
      ts: new Date().toISOString(),
      step,
      tool,
      args,
      durationMs: 0,
    };
    try {
      const result = await fn();
      entry.result = summarize(result);
      if (page && !opts.skipScreenshot) {
        const name = `${String(step).padStart(4, "0")}-${tool}.png`;
        const path = join(this.dir, "screenshots", name);
        try {
          await page.screenshot({ path, fullPage: false });
          entry.screenshot = `screenshots/${name}`;
        } catch {
          // page may have navigated/closed; non-fatal
        }
      }
      return result;
    } catch (err: any) {
      entry.error = err?.message ?? String(err);
      throw err;
    } finally {
      entry.durationMs = Date.now() - started;
      this.logStream.write(JSON.stringify(entry) + "\n");
    }
  }
}

function summarize(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === "string") return v.length > 500 ? v.slice(0, 500) + "…" : v;
  if (Buffer.isBuffer(v)) return `<buffer ${v.length}b>`;
  if (Array.isArray(v)) return v.length > 20 ? `<array len=${v.length}>` : v;
  if (typeof v === "object") {
    const json = JSON.stringify(v);
    return json.length > 1000 ? json.slice(0, 1000) + "…" : v;
  }
  return v;
}
