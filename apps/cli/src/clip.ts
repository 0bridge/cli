import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, delimiter, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { deviceTokenKey, openSecretStore, type CloudClient, type Context } from "@0bridge/core";
import { installAgent } from "./background.ts";
import { cloudClient } from "./cloud.ts";
import { c } from "./ui.ts";

/**
 * The clipboard relay: send a screenshot, file or text from this computer to 0bridge, where
 * an agent anywhere (over SSH, on a server, in claude.ai) reads it once with `bridge__clipboard`.
 * Nothing is sent unless the user runs this, or turns on `0b clip sync` (images copied on a Mac
 * go up on their own); items wait 10 minutes.
 */

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".log": "text/plain",
  ".html": "text/html",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".ts": "text/typescript",
  ".js": "text/javascript",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
};
const mimeOf = (file: string) => MIME[extname(file).toLowerCase()] ?? "application/octet-stream";

/** Images agents read best: at most 1568 px on the long side, and under ~4 MB (Claude's limits). Needs macOS sips. */
function fitImage(file: string, dir: string): string {
  if (process.platform !== "darwin") return file;
  const dims = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" }).stdout;
  const w = Number(/pixelWidth: (\d+)/.exec(dims)?.[1] ?? 0);
  const h = Number(/pixelHeight: (\d+)/.exec(dims)?.[1] ?? 0);
  const heic = /\.(heic|tiff?)$/i.test(file);
  let out = file;
  if (Math.max(w, h) > 1568 || heic) {
    out = join(dir, `${basename(file, extname(file))}.png`);
    spawnSync("sips", ["-Z", "1568", "-s", "format", "png", file, "--out", out], { stdio: "ignore" });
  }
  if (statSync(out).size > 4 * 1024 * 1024) {
    const jpg = join(dir, `${basename(file, extname(file))}.jpg`);
    spawnSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", out, "--out", jpg], { stdio: "ignore" });
    if (existsSync(jpg)) out = jpg;
  }
  return out;
}

/** What's on the Mac clipboard: copied files (Finder), else an image (a screenshot), else text. */
function readMacClipboard(dir: string): { files: string[] } | { text: string } | null {
  const script = `
ObjC.import('AppKit');
// Tests use a pasteboard of their own, never the user's.
const pb = ${JSON.stringify(process.env.ZEROBRIDGE_PASTEBOARD ?? "")} ? $.NSPasteboard.pasteboardWithName(${JSON.stringify(process.env.ZEROBRIDGE_PASTEBOARD ?? "")}) : $.NSPasteboard.generalPasteboard;
const urls = pb.readObjectsForClassesOptions($([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));
const files = [];
if (urls && urls.count > 0) for (let i = 0; i < urls.count; i++) files.push(urls.objectAtIndex(i).path.js);
let image = null;
if (!files.length) {
  for (const [type, ext] of [['public.png', 'png'], ['public.tiff', 'tiff'], ['public.jpeg', 'jpg']]) {
    const d = pb.dataForType(type);
    if (!d.isNil()) { image = ${JSON.stringify(dir)} + '/clipboard.' + ext; d.writeToFileAtomically(image, true); break; }
  }
}
const text = files.length || image ? null : pb.stringForType('public.utf8-plain-text');
JSON.stringify({ files, image, text: text && !text.isNil() ? text.js : null });`;
  const r = spawnSync("osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const got = JSON.parse(r.stdout.trim() || "{}") as { files?: string[]; image?: string | null; text?: string | null };
  if (got.files?.length) return { files: got.files };
  if (got.image) return { files: [got.image] };
  return got.text ? { text: got.text } : null;
}

/** The real `xclip` / `wl-paste`, skipping 0bridge's own shims (`0b clip shims`) in ~/.0bridge/bin. */
function realBin(name: string): string | null {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (!d || d.includes(`${"/"}.0bridge${"/"}bin`)) continue;
    if (existsSync(join(d, name))) return join(d, name);
  }
  return null;
}

/** Linux (X11 or Wayland): an image if there is one, else text. */
function readLinuxClipboard(dir: string): { files: string[] } | { text: string } | null {
  const img = join(dir, "clipboard.png");
  for (const cmd of [["wl-paste", "--type", "image/png"], ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]]) {
    const bin = realBin(cmd[0]!);
    if (!bin) continue;
    const r = spawnSync(bin, cmd.slice(1));
    if (r.status === 0 && r.stdout?.length) {
      writeFileSync(img, r.stdout);
      return { files: [img] };
    }
  }
  for (const cmd of [["wl-paste", "--no-newline"], ["xclip", "-selection", "clipboard", "-o"]]) {
    const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" });
    if (r.status === 0 && r.stdout) return { text: r.stdout };
  }
  return null;
}

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export async function clipCommand(ctx: Context, args: string[]): Promise<void> {
  const { client } = cloudClient(ctx);
  const [sub] = args;
  if (sub === "status" || sub === "list") {
    const waiting = await client.clipsWaiting();
    if (!waiting.length) return console.log(c.dim("Nothing waiting."));
    for (const w of waiting) console.log(`${w.name}  ${c.dim(`${w.mime} · ${kb(w.size)} · ${Math.round((Date.now() - w.at) / 1000)}s ago`)}`);
    return;
  }
  if (sub === "clear") {
    const r = await client.clearClips();
    return console.log(`${c.green("✓")} removed ${r.deleted} waiting ${r.deleted === 1 ? "item" : "items"}`);
  }

  if (sub === "listen") {
    if (args[1] === "on" || args[1] === "off") return installListener(ctx, args[1] === "on");
    return listen(ctx);
  }
  if (sub === "sync") {
    if (args[1] === "on" || args[1] === "off") return installSync(ctx, args[1] === "on");
    return sync(ctx);
  }
  if (sub === "paste") return paste(ctx, args[1]);
  if (sub === "shims") return installPasteShims(ctx, args[1] !== "off");
  // What the shims run: `0b clip shim xclip <xclip's own arguments>`.
  if (sub === "shim" && (args[1] === "xclip" || args[1] === "wl-paste")) return pasteShim(ctx, args[1], args.slice(2));
  const sent = await sendClipboard(client, args);
  if (!sent.length) fail("the clipboard is empty (or this system's clipboard can't be read; pass a file: 0b clip <file>)");
  console.log(`${c.green("✓")} sent ${sent.join(", ")}. Ask your agent to look at it ("I sent you a screenshot"); it reads it once with bridge__clipboard, within 10 minutes.`);
}

/** Send the given files, or what's on the clipboard. Returns what was sent ("clipboard.png (2 KB)"); empty when there was nothing. */
async function sendClipboard(client: CloudClient, files: string[]): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "0b-clip-"));
  try {
    let text: string | null = null;
    if (files.length) files = files.map((f) => (existsSync(f) ? f : fail(`${f} not found`)));
    else {
      const got = process.platform === "darwin" ? readMacClipboard(dir) : readLinuxClipboard(dir);
      if (!got) return [];
      if ("text" in got) text = got.text;
      else files = got.files;
    }
    const sent: string[] = [];
    const from = hostname().replace(/\.local$/, "");
    if (text !== null) {
      const r = await client.sendClip({ name: "clipboard.txt", mime: "text/plain", data: Buffer.from(text).toString("base64"), from });
      sent.push(`text (${kb(r.size)})`);
    }
    for (const f of files) {
      if (!statSync(f).isFile()) fail(`${f} is a folder; send files`);
      const mime = mimeOf(f);
      const path = mime.startsWith("image/") ? fitImage(f, dir) : f;
      const r = await client.sendClip({ name: basename(path), mime: mimeOf(path), data: readFileSync(path).toString("base64"), from });
      sent.push(`${r.name} (${kb(r.size)})`);
    }
    return sent;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Copy on the Mac, use it anywhere (0b clip sync) ─────────────

/**
 * Watches the Mac's clipboard and prints a JSON line for each new image on it: a screenshot
 * (⌘⌃⇧4), an image copied in an app, or image files copied in Finder. Text and other files are
 * left alone (passwords get copied too), and so is anything a password manager marks as concealed
 * or transient (nspasteboard.org's markers, which 1Password and others set).
 */
const WATCH_SCRIPT = (dir: string) => `
ObjC.import('AppKit');
const pb = ${JSON.stringify(process.env.ZEROBRIDGE_PASTEBOARD ?? "")} ? $.NSPasteboard.pasteboardWithName(${JSON.stringify(process.env.ZEROBRIDGE_PASTEBOARD ?? "")}) : $.NSPasteboard.generalPasteboard;
const out = $.NSFileHandle.fileHandleWithStandardOutput;
const say = (o) => out.writeData($(JSON.stringify(o) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
const SKIP = ['org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType', 'org.nspasteboard.AutoGeneratedType', 'com.agilebits.onepassword'];
const IMAGE_FILE = /\\.(png|jpe?g|gif|webp|heic|tiff?)$/i;
let last = pb.changeCount, n = 0;
say({ ready: true });
for (;;) {
  delay(0.5);
  const cc = pb.changeCount;
  if (cc === last) continue;
  last = cc;
  const types = ObjC.deepUnwrap(pb.types) || [];
  if (types.some((t) => SKIP.includes(t))) continue;
  const urls = pb.readObjectsForClassesOptions($([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));
  const files = [];
  if (urls && urls.count > 0) for (let i = 0; i < urls.count; i++) { const p = urls.objectAtIndex(i).path.js; if (IMAGE_FILE.test(p)) files.push(p); }
  if (urls && urls.count > 0) { if (files.length) say({ files }); continue; }
  for (const [type, ext] of [['public.png', 'png'], ['public.tiff', 'tiff'], ['public.jpeg', 'jpg']]) {
    const d = pb.dataForType(type);
    if (!d.isNil()) { const f = ${JSON.stringify(dir)} + '/copy-' + (++n) + '.' + ext; d.writeToFileAtomically(f, true); say({ files: [f] }); break; }
  }
}`;

/** Send each image copied on this Mac as it's copied; the newest replaces the one before it. */
async function sync(ctx: Context): Promise<void> {
  if (process.platform !== "darwin") fail("clipboard sync runs on a Mac (the computer you copy on); agents here read what it sends");
  const { client } = cloudClient(ctx);
  const dir = mkdtempSync(join(tmpdir(), "0b-clipsync-"));
  const from = hostname().replace(/\.local$/, "");
  const stamp = () => new Date().toISOString().slice(11, 19);
  for (;;) {
    const child = spawn("osascript", ["-l", "JavaScript", "-e", WATCH_SCRIPT(dir)], { stdio: ["ignore", "pipe", "inherit"] });
    for await (const line of createInterface({ input: child.stdout! })) {
      let ev: { ready?: boolean; files?: string[] };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.ready) console.log(`${stamp()} watching this Mac's clipboard for images`);
      for (const f of ev.files ?? []) {
        try {
          if (statSync(f).size > 20 * 1024 * 1024) continue;
          const path = fitImage(f, dir);
          const r = await client.sendClip({ name: basename(path), mime: mimeOf(path), data: readFileSync(path).toString("base64"), from, sync: true });
          console.log(`${stamp()} sent ${r.name} (${kb(r.size)})`);
        } catch (e) {
          console.log(`${stamp()} couldn't send ${basename(f)}: ${(e as Error).message}`);
        } finally {
          if (f.startsWith(dir)) rmSync(f, { force: true });
        }
      }
    }
    // The watcher ended (sleep, a crash): start it again in a moment.
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Keep `0b clip sync` running at login (macOS LaunchAgent). */
function installSync(ctx: Context, on: boolean): void {
  if (process.platform !== "darwin") {
    console.log("Clipboard sync belongs on the computer you copy on (your Mac): run `0b clip sync on` there. Agents here read what it sends; `0b clip paste` saves it here.");
    return;
  }
  installAgent(ctx, "dev.0bridge.clipsync", on ? ["clip", "sync"] : null, { keepAlive: true });
  console.log(
    on
      ? `${c.green("✓")} Images you copy on this Mac (screenshots, copied images, image files) go to your agents as you copy them. Text never does on its own; send it with ${c.cyan("0b clip")}. Each waits 10 minutes, and a new copy replaces the last.`
      : `${c.green("✓")} Copies on this Mac no longer go up on their own (${c.cyan("0b clip")} still sends).`,
  );
}

/** Save what's waiting here (files in `dir`, default a temp folder) and print their paths; text is printed. */
async function paste(ctx: Context, dir?: string): Promise<void> {
  const { client } = cloudClient(ctx);
  const items = await client.takeClips();
  if (!items.length) return console.log(c.dim("Nothing waiting. Copy something on your Mac (with `0b clip sync on` there), or run `0b clip` there."));
  const to = resolve(dir ?? join(tmpdir(), "0b-clip"));
  mkdirSync(to, { recursive: true });
  for (const it of items) {
    const data = Buffer.from(it.data, "base64");
    if (it.mime.startsWith("text/") && data.length < 64 * 1024) {
      console.log(data.toString("utf8"));
      continue;
    }
    const file = join(to, `${new Date(it.at).toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${basename(it.name)}`);
    writeFileSync(file, data);
    console.log(file);
  }
}

// ── ⌃V in a terminal on another machine (0b clip shims) ─────────────

/**
 * Claude Code on Linux pastes an image with ⌃V by asking `xclip` (or `wl-paste`) for the
 * clipboard's image. These stand-ins answer with the newest image copied on the Mac (`0b clip
 * sync`), left in place so it can be pasted again; anything else goes to the real tool.
 */
function installPasteShims(ctx: Context, on: boolean): void {
  const dir = join(ctx.storeDir, "bin");
  for (const name of ["xclip", "wl-paste"]) {
    const f = join(dir, name);
    if (!on) {
      rmSync(f, { force: true });
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(f, `#!/bin/sh\n# 0bridge: ⌃V pastes the image you last copied on your Mac (0b clip sync); the rest goes to the real ${name}.\nexec "${process.execPath}" "${process.argv[1]}" clip shim ${name} -- "$@"\n`);
    chmodSync(f, 0o755);
  }
  if (!on) return console.log(`${c.green("✓")} removed the xclip and wl-paste stand-ins`);
  const onPath = (process.env.PATH ?? "").split(delimiter)[0] === dir;
  console.log(`${c.green("✓")} ⌃V in Claude Code on this machine now pastes the image you last copied on your Mac (with ${c.cyan("0b clip sync on")} there).`);
  if (!onPath) console.log(`Put ${dir} first in your PATH (in ~/.zshrc or ~/.bashrc), then start Claude Code again:\n  ${c.cyan(`export PATH="${dir}:$PATH"`)}`);
}

/** One xclip / wl-paste call: images from 0bridge; everything else (and no image waiting) to the real tool. */
async function pasteShim(ctx: Context, tool: "xclip" | "wl-paste", argv: string[]): Promise<void> {
  const real = realBin(tool);
  const passThrough = (): never => {
    if (!real) process.exit(1);
    const r = spawnSync(real, argv, { stdio: "inherit" });
    process.exit(r.status ?? 1);
  };
  const value = (flag: string[]) => {
    const i = argv.findIndex((a) => flag.includes(a));
    return i >= 0 ? argv[i + 1] : undefined;
  };
  let wantsList = false;
  let wantsType: string | undefined;
  if (tool === "xclip") {
    const sel = value(["-selection", "-sel"]);
    if (!argv.includes("-o") && !argv.includes("-out")) passThrough();
    if (!sel || !"clipboard".startsWith(sel)) passThrough();
    const t = value(["-t", "-target"]);
    wantsList = t === "TARGETS";
    wantsType = t;
  } else {
    wantsList = argv.includes("-l") || argv.includes("--list-types");
    wantsType = value(["-t", "--type"]);
  }
  if (!wantsList && !wantsType?.startsWith("image/")) passThrough();
  const { client } = cloudClient(ctx);
  const img = await client.latestImage().catch(() => null);
  if (!img) passThrough();
  if (wantsList) {
    process.stdout.write(`${img!.mime}\n`);
    return;
  }
  if (wantsType !== img!.mime) passThrough();
  process.stdout.write(Buffer.from(img!.data, "base64"));
}

// ── Answering agents' requests (0b clip listen) ─────────────

/** How long "Allow for 1 Hour" lets the same tool read the clipboard without asking again. */
const TRUST_MS = 60 * 60 * 1000;
type Answer = "once" | "hour" | false;

/** Ask the person at this Mac. Tests answer with ZEROBRIDGE_CLIP_ANSWER=allow|hour|deny instead. */
function ask(who: string): { answer: Promise<Answer>; cancel: () => void } {
  const preset = process.env.ZEROBRIDGE_CLIP_ANSWER;
  if (preset) return { answer: Promise.resolve(preset === "hour" ? "hour" : preset === "allow" ? "once" : false), cancel: () => {} };
  if (process.platform !== "darwin") return { answer: Promise.resolve(false), cancel: () => {} };
  const q = (s: string) => `"${s.replace(/["\\]/g, "")}"`;
  const script = `display dialog ${q(`${who} wants to see what's on your clipboard (a screenshot, copied files or text).`)} with title "0bridge" buttons {"Don't Allow", "Allow for 1 Hour", "Allow"} default button "Allow" cancel button "Don't Allow" giving up after 60 with icon caution`;
  const child: ChildProcess = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  const answer = new Promise<Answer>((res) =>
    child.on("close", (code) => {
      if (code !== 0 || /gave up:true/.test(out)) return res(false);
      res(/button returned:Allow for 1 Hour/.test(out) ? "hour" : /button returned:Allow/.test(out) ? "once" : false);
    }),
  );
  return { answer, cancel: () => child.kill() };
}

/**
 * Keep a connection to 0bridge open; when an agent asks for the clipboard (bridge__clipboard with
 * nothing waiting), ask here and send it if allowed. Reconnects on its own.
 */
async function listen(ctx: Context): Promise<void> {
  const { cfg, client } = cloudClient(ctx);
  const token = openSecretStore(ctx.storeDir).get(deviceTokenKey(cfg));
  if (!token) fail("sign in first: 0b login");
  if (typeof WebSocket === "undefined") fail("this needs Node 22 or newer (WebSocket)");
  const url = `${cfg.server.replace(/\/+$/, "").replace(/^http/, "ws")}/api/clip/listen`;
  const stamp = () => new Date().toISOString().slice(11, 19);
  // Tools allowed for an hour ("Claude Code on dgithost" → until when); asked again after that.
  const trusted = new Map<string, number>();
  let delay = 1000;
  for (;;) {
    await new Promise<void>((resolve) => {
      // Node's and Bun's WebSocket both take headers here (not in the web standard).
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as never);
      let open: { id: string; cancel: () => void } | null = null;
      const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping" })), 50_000);
      ws.onopen = () => {
        delay = 1000;
        console.log(`${stamp()} listening for clipboard requests`);
      };
      ws.onmessage = async (e) => {
        let m: { type?: string; id?: string; who?: string };
        try {
          m = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (m.type === "done" && open && open.id === m.id) {
          open.cancel();
          open = null;
        }
        if (m.type !== "request" || !m.id || open) return;
        const who = m.who ?? "An AI tool";
        const q = (trusted.get(who) ?? 0) > Date.now() ? { answer: Promise.resolve<Answer>("once"), cancel: () => {} } : ask(who);
        open = { id: m.id, cancel: q.cancel };
        const answer = await q.answer;
        if (open?.id !== m.id) return; // answered on another computer
        open = null;
        if (answer === "hour") trusted.set(who, Date.now() + TRUST_MS);
        const allowed = answer !== false;
        let sent: string[] = [];
        if (allowed) sent = await sendClipboard(client, []).catch(() => []);
        console.log(`${stamp()} ${m.who}: ${allowed ? `sent ${sent.join(", ") || "nothing (empty clipboard)"}` : "declined"}`);
        ws.send(JSON.stringify({ type: allowed ? "sent" : "denied", id: m.id }));
      };
      ws.onclose = () => {
        clearInterval(ping);
        open?.cancel();
        resolve();
      };
      ws.onerror = () => {};
    });
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 30_000);
  }
}

/** Run `0b clip listen` at login and keep it running (macOS LaunchAgent). */
function installListener(ctx: Context, on: boolean): void {
  if (process.platform !== "darwin") {
    console.log(
      on
        ? "Answering clipboard requests belongs on the computer you copy on (your Mac): run `0b clip listen on` there. Agents on this machine read what it sends. (`0b clip listen` answers from this machine's clipboard, in this terminal.)"
        : "Stop your `0b clip listen` process.",
    );
    return;
  }
  installAgent(ctx, "dev.0bridge.clip", on ? ["clip", "listen"] : null, { keepAlive: true });
  console.log(
    on
      ? `${c.green("✓")} This Mac answers clipboard requests: when an agent asks, a dialog here asks you first.`
      : `${c.green("✓")} This Mac no longer answers clipboard requests (0b clip still sends).`,
  );
}
