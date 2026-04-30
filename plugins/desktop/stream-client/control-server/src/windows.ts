import { execa } from "execa";

const DISPLAY = process.env.DISPLAY ?? ":1";

export interface WindowInfo {
  id: string;
  pid: number;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

async function run(cmd: string, args: string[]): Promise<string> {
  const r = await execa(cmd, args, { env: { DISPLAY }, reject: false });
  if (r.exitCode !== 0 && r.stderr) {
    throw Object.assign(new Error(`${cmd} failed: ${r.stderr}`), { statusCode: 500 });
  }
  return r.stdout;
}

export async function listWindows(): Promise<WindowInfo[]> {
  // wmctrl -lG -p:  WINID  DESK  PID  X  Y  W  H  HOST  TITLE...
  const out = await run("wmctrl", ["-lGp"]);
  const wins: WindowInfo[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;
    const [id, , pid, x, y, w, h] = parts;
    const title = parts.slice(8).join(" ");
    // Filter out the desktop/root and tiny utility windows.
    if (title === "desktop" || title === "Desktop") continue;
    const wInt = Number(w), hInt = Number(h);
    if (wInt < 50 || hInt < 30) continue;
    wins.push({
      id: id!,
      pid: Number(pid),
      title,
      x: Number(x),
      y: Number(y),
      w: wInt,
      h: hInt,
    });
  }
  return wins;
}

async function resolveWindow(arg: { id?: string; title_substring?: string }): Promise<string> {
  if (arg.id) return arg.id;
  if (arg.title_substring) {
    const wins = await listWindows();
    const needle = arg.title_substring.toLowerCase();
    const hit = wins.find((w) => w.title.toLowerCase().includes(needle));
    if (!hit) {
      throw Object.assign(new Error(`no window matching "${arg.title_substring}"`), {
        statusCode: 404,
      });
    }
    return hit.id;
  }
  throw Object.assign(new Error("must provide id or title_substring"), { statusCode: 400 });
}

export async function focusWindow(arg: { id?: string; title_substring?: string }): Promise<void> {
  const id = await resolveWindow(arg);
  await run("wmctrl", ["-i", "-a", id]);
}

export async function moveWindow(opts: {
  id?: string;
  title_substring?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}): Promise<void> {
  const id = await resolveWindow(opts);
  // wmctrl -e: gravity,x,y,w,h. Gravity 0 = use the WM's current gravity.
  await run("wmctrl", ["-i", "-r", id, "-e", `0,${opts.x},${opts.y},${opts.w},${opts.h}`]);
}

export async function closeWindow(arg: { id?: string; title_substring?: string }): Promise<void> {
  const id = await resolveWindow(arg);
  await run("wmctrl", ["-i", "-c", id]);
}

const SCREEN_W = Number(process.env.DISPLAY_WIDTH ?? "1600");
const SCREEN_H = Number(process.env.DISPLAY_HEIGHT ?? "900");

export async function tileWindows(opts: {
  layout: "grid" | "main_stack";
  ids?: string[];
}): Promise<{ tiled: number }> {
  const all = await listWindows();
  const targets = opts.ids
    ? all.filter((w) => opts.ids!.includes(w.id))
    : all.filter((w) => !w.title.toLowerCase().includes("conky"));
  if (targets.length === 0) return { tiled: 0 };

  const W = SCREEN_W;
  const H = SCREEN_H - 30; // leave a bit of breathing room at the bottom

  if (opts.layout === "main_stack" && targets.length >= 2) {
    const main = targets[0]!;
    const stack = targets.slice(1);
    await moveWindow({ id: main.id, x: 0, y: 0, w: Math.floor(W * 0.6), h: H });
    const stackX = Math.floor(W * 0.6);
    const stackW = W - stackX;
    const each = Math.floor(H / stack.length);
    for (let i = 0; i < stack.length; i++) {
      await moveWindow({
        id: stack[i]!.id,
        x: stackX,
        y: i * each,
        w: stackW,
        h: each,
      });
    }
    return { tiled: targets.length };
  }

  // grid: roughly square layout
  const cols = Math.ceil(Math.sqrt(targets.length));
  const rows = Math.ceil(targets.length / cols);
  const cellW = Math.floor(W / cols);
  const cellH = Math.floor(H / rows);
  for (let i = 0; i < targets.length; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    await moveWindow({
      id: targets[i]!.id,
      x: c * cellW,
      y: r * cellH,
      w: cellW,
      h: cellH,
    });
  }
  return { tiled: targets.length };
}
