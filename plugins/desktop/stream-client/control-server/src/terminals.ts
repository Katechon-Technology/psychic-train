import { execa, type ResultPromise } from "execa";
import { mkdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const DISPLAY = process.env.DISPLAY ?? ":1";
const LOG_DIR = "/tmp/desktop-terminals";

interface Terminal {
  id: string;
  cmd: string;
  cwd?: string;
  startedAt: number;
  logPath: string;
  child: ResultPromise<{ reject: false }>;
}

const terminals = new Map<string, Terminal>();

async function ensureLogDir(): Promise<void> {
  if (!existsSync(LOG_DIR)) await mkdir(LOG_DIR, { recursive: true });
}

function makeId(): string {
  return "t-" + randomBytes(4).toString("hex");
}

/**
 * Opens a new xterm window running `cmd` and tees its output to a logfile we
 * can tail later. `script` (from bsdutils) preserves color/escape codes; we
 * strip them at read time. We don't bother with tmux for the simple
 * spawn/tail case — one xterm per command is more visible on the stream.
 */
export async function spawnTerminal(opts: {
  cmd: string;
  cwd?: string;
  title?: string;
}): Promise<{ id: string }> {
  await ensureLogDir();
  const id = makeId();
  const logPath = join(LOG_DIR, `${id}.log`);
  const title = opts.title ?? id;
  const cwd = opts.cwd ?? process.env.WORKSPACE ?? "/workspace";

  // The inner shell tees both stdout and stderr to the log, then drops into an
  // interactive bash so the agent can send stdin if it wants. `exec </dev/tty`
  // would re-bind stdin to the xterm's tty for the trailing shell.
  const inner = `cd ${shellQuote(cwd)} && { ${opts.cmd}; } 2>&1 | tee ${shellQuote(logPath)}; echo; echo '[command exited; press Ctrl-D to close]'; exec bash`;

  const child = execa(
    "xterm",
    [
      "-title",
      title,
      "-fa",
      "DejaVu Sans Mono",
      "-fs",
      "11",
      "-bg",
      "#0e1116",
      "-fg",
      "#d8dee9",
      "-geometry",
      "100x28",
      "-e",
      "bash",
      "-c",
      inner,
    ],
    {
      env: { ...process.env, DISPLAY },
      reject: false,
      detached: true,
    },
  );

  terminals.set(id, {
    id,
    cmd: opts.cmd,
    cwd,
    startedAt: Date.now(),
    logPath,
    child,
  });

  return { id };
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

export async function execHeadless(opts: {
  cmd: string;
  cwd?: string;
  timeout_s?: number;
}): Promise<{ stdout: string; stderr: string; exit_code: number; truncated: boolean }> {
  const cwd = opts.cwd ?? process.env.WORKSPACE ?? "/workspace";
  const timeout = (opts.timeout_s ?? 30) * 1000;
  const r = await execa("bash", ["-lc", opts.cmd], {
    cwd,
    timeout,
    reject: false,
    maxBuffer: 1024 * 1024,
  });
  const cap = (s: string) => (s.length > 8000 ? s.slice(0, 8000) : s);
  return {
    stdout: cap(r.stdout ?? ""),
    stderr: cap(r.stderr ?? ""),
    exit_code: r.exitCode ?? -1,
    truncated: (r.stdout?.length ?? 0) > 8000 || (r.stderr?.length ?? 0) > 8000,
  };
}

export async function readTerminalOutput(id: string): Promise<{
  stdout_so_far: string;
  running: boolean;
  bytes: number;
}> {
  const t = terminals.get(id);
  if (!t) {
    throw Object.assign(new Error(`terminal ${id} not found`), { statusCode: 404 });
  }
  let bytes = 0;
  let stdout = "";
  if (existsSync(t.logPath)) {
    const st = await stat(t.logPath);
    bytes = st.size;
    const start = Math.max(0, bytes - 8000);
    const buf = await readFile(t.logPath);
    stdout = buf.slice(start).toString("utf8");
  }
  // execa terminates the promise when the xterm process exits; if it's still
  // pending the child is alive.
  let running = false;
  try {
    running = t.child.exitCode == null;
  } catch {
    running = false;
  }
  return { stdout_so_far: stdout, running, bytes };
}

export async function killTerminal(id: string): Promise<void> {
  const t = terminals.get(id);
  if (!t) return;
  try {
    t.child.kill("SIGTERM");
  } catch {
    // ignore
  }
  terminals.delete(id);
}

export function listTerminals(): Array<{
  id: string;
  cmd: string;
  startedAt: number;
}> {
  return [...terminals.values()].map((t) => ({
    id: t.id,
    cmd: t.cmd.length > 120 ? t.cmd.slice(0, 120) + "…" : t.cmd,
    startedAt: t.startedAt,
  }));
}
