import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@0bridge/core";
import {
  cronSchedule,
  installService,
  renderBin,
  renderCrontab,
  renderLauncher,
  renderPlist,
  renderTimer,
  renderUnit,
  renderWrapper,
  schtasksArgs,
  serviceInstalled,
} from "../src/service.ts";
import { dialogAnswer, dialogArgs, linuxDialog } from "../src/clip.ts";
import { renderShim, spawnTarget } from "../src/profile.ts";
import { writeToTerminal } from "../src/vault.ts";

const BIN = "/home/me/.0bridge/bin/0bridge";
const LOG = "/home/me/.0bridge/background.log";

describe("macOS LaunchAgent", () => {
  test("every 15 minutes, starting at login", () => {
    const plist = renderPlist("background", [BIN, "background", "--quiet"], LOG, { interval: 900 });
    expect(plist).toContain("<key>Label</key><string>dev.0bridge.background</string>");
    expect(plist).toContain(`<array><string>${BIN}</string><string>background</string><string>--quiet</string></array>`);
    expect(plist).toContain("<key>StartInterval</key><integer>900</integer>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).toContain(`<key>StandardOutPath</key><string>${LOG}</string>`);
  });
  test("kept alive", () => {
    const plist = renderPlist("clip", [BIN, "clip", "listen"], LOG, { keepAlive: true });
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).not.toContain("StartInterval");
  });
});

describe("Linux systemd user units", () => {
  test("a one-shot service and a timer every 15 minutes", () => {
    const unit = renderUnit("background", [BIN, "background", "--quiet"], LOG, { interval: 900 });
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain(`ExecStart="${BIN}" "background" "--quiet"`);
    expect(unit).toContain(`StandardOutput=append:${LOG}`);
    expect(unit).not.toContain("[Install]");
    const timer = renderTimer("background", 900);
    expect(timer).toContain("OnActiveSec=1min");
    expect(timer).toContain("OnUnitActiveSec=900s");
    expect(timer).toContain("Unit=0bridge-background.service");
    expect(timer).toContain("WantedBy=timers.target");
  });
  test("a kept-alive service restarts and starts at login", () => {
    const unit = renderUnit("agent", [BIN, "agent", "run"], LOG, { keepAlive: true });
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });
  test("ExecStart quoting: spaces, quotes, and % (a systemd specifier)", () => {
    expect(renderUnit("clip", ['/opt/my home/0bridge', 'say "hi" 100%'], LOG, { keepAlive: true })).toContain('ExecStart="/opt/my home/0bridge" "say \\"hi\\" 100%%"');
  });
});

describe("Linux crontab (no systemd)", () => {
  test("our line is tagged, replaced in place of the old one, and removed alone", () => {
    const mine = "0 * * * * backup.sh\n";
    const on = renderCrontab(mine, "background", `${cronSchedule(900)} ${BIN} background --quiet`);
    expect(on).toBe(`0 * * * * backup.sh\n*/15 * * * * ${BIN} background --quiet # 0bridge:background\n`);
    expect(renderCrontab(on, "background", `*/5 * * * * ${BIN} background`)).toBe(`0 * * * * backup.sh\n*/5 * * * * ${BIN} background # 0bridge:background\n`);
    expect(renderCrontab(on, "background", null)).toBe(mine);
    expect(renderCrontab(`*/15 * * * * x # 0bridge:background\n`, "background", null)).toBe("");
  });
  test("schedules in whole minutes", () => {
    expect(cronSchedule(900)).toBe("*/15 * * * *");
    expect(cronSchedule(30)).toBe("*/1 * * * *");
    expect(cronSchedule(7200)).toBe("0 */2 * * *");
  });
});

describe("Windows Task Scheduler", () => {
  test("every 15 minutes, or at logon for a job that keeps running", () => {
    const vbs = "C:\\Users\\me\\.0bridge\\bin\\0bridge-background.vbs";
    expect(schtasksArgs("background", vbs, { interval: 900 })).toEqual(["/Create", "/F", "/TN", "0bridge\\background", "/SC", "MINUTE", "/MO", "15", "/TR", `wscript.exe //B //Nologo "${vbs}"`]);
    expect(schtasksArgs("clip", vbs, { keepAlive: true })).toEqual(["/Create", "/F", "/TN", "0bridge\\clip", "/SC", "ONLOGON", "/TR", `wscript.exe //B //Nologo "${vbs}"`]);
  });
  test("the wrapper restarts a kept-alive job; the launcher hides its window and waits for it", () => {
    const bin = "C:\\Users\\me\\.0bridge\\bin\\0bridge.cmd";
    const loop = renderWrapper("clip", bin, ["clip", "listen"], "C:\\Users\\me\\.0bridge\\clip.log", { keepAlive: true });
    expect(loop).toContain(`call "${bin}" clip listen >> "C:\\Users\\me\\.0bridge\\clip.log" 2>&1`);
    expect(loop).toContain(":loop\r\n");
    expect(loop).toContain("goto loop");
    expect(renderWrapper("background", bin, ["background", "--quiet"], "x.log", { interval: 900 })).not.toContain("goto loop");
    expect(renderLauncher("C:\\w.cmd")).toBe(`CreateObject("WScript.Shell").Run """C:\\w.cmd""", 0, True\r\n`);
  });
  test("the 0bridge script runs a 0b command, flags alone being the sync", () => {
    const cmd = renderBin("C:\\node\\node.exe", "C:\\npm\\0b.js", "win32");
    expect(cmd).toContain(`"C:\\node\\node.exe" "C:\\npm\\0b.js" %*`);
    expect(cmd).toContain(`"C:\\node\\node.exe" "C:\\npm\\0b.js" background %*`);
    expect(cmd).toContain("\r\n");
  });
});

describe("the 0bridge script", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "0bridge-bin-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  test.skipIf(process.platform === "win32")("a command passes through; nothing or flags only is `0b background` (LaunchAgents from before)", () => {
    // `echo` stands in for node, so the script shows what it would run.
    const bin = join(dir, "0bridge");
    writeFileSync(bin, renderBin("/bin/echo", "/x/0b.js", "linux"));
    chmodSync(bin, 0o755);
    const run = (...a: string[]) => Bun.spawnSync([bin, ...a]).stdout.toString().trim();
    expect(run("hook", "claude")).toBe("/x/0b.js hook claude");
    expect(run("clip", "listen")).toBe("/x/0b.js clip listen");
    expect(run("--quiet")).toBe("/x/0b.js background --quiet");
    expect(run()).toBe("/x/0b.js background");
  });
});

describe("installing under a test home", () => {
  let home: string;
  let ctx: Context;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "0bridge-svc-"));
    ctx = { home, storeDir: join(home, ".0bridge") };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("writes this OS's files only, and removes them", () => {
    const where = installService(ctx, "background", ["background", "--quiet"], { interval: 900 });
    const bin = join(ctx.storeDir, "bin", process.platform === "win32" ? "0bridge.cmd" : "0bridge");
    expect(existsSync(bin)).toBe(true);
    if (process.platform === "darwin") {
      expect(where).toBe(join(home, "Library", "LaunchAgents", "dev.0bridge.background.plist"));
      expect(readFileSync(where, "utf8")).toContain("<integer>900</integer>");
    } else if (process.platform === "win32") {
      expect(where).toBe("0bridge\\background");
      expect(existsSync(join(ctx.storeDir, "bin", "0bridge-background.cmd"))).toBe(true);
      expect(existsSync(join(ctx.storeDir, "bin", "0bridge-background.vbs"))).toBe(true);
    } else if (existsSync("/run/systemd/system")) {
      expect(where).toBe(join(home, ".config", "systemd", "user", "0bridge-background.timer"));
      expect(readFileSync(join(home, ".config", "systemd", "user", "0bridge-background.service"), "utf8")).toContain(`ExecStart="${bin}" "background" "--quiet"`);
      expect(readFileSync(where, "utf8")).toContain("OnUnitActiveSec=900s");
    } else expect(where).toBe("crontab");
    if (where !== "crontab") expect(serviceInstalled(ctx, "background")).toBe(true);
    installService(ctx, "background", null, { interval: 900 });
    expect(serviceInstalled(ctx, "background")).toBe(false);
  });
});

describe("other platform differences", () => {
  test("Linux clipboard requests ask through zenity or kdialog, with a display", () => {
    expect(linuxDialog({}, () => true)).toBeNull();
    expect(linuxDialog({ DISPLAY: ":0" }, (c) => c === "kdialog")).toBe("kdialog");
    expect(linuxDialog({ WAYLAND_DISPLAY: "wayland-0" }, () => true)).toBe("zenity");
    expect(linuxDialog({ DISPLAY: ":0" }, () => false)).toBeNull();
    expect(dialogArgs("zenity", "Claude Code wants…")).toContain("--extra-button=Allow for 1 Hour");
    expect(dialogAnswer("zenity", 0, "")).toBe("once");
    expect(dialogAnswer("zenity", 1, "Allow for 1 Hour\n")).toBe("hour");
    expect(dialogAnswer("zenity", 1, "")).toBe(false);
    expect(dialogAnswer("zenity", 5, "")).toBe(false);
    expect(dialogAnswer("kdialog", 0, "")).toBe("once");
    expect(dialogAnswer("kdialog", 1, "")).toBe("hour");
    expect(dialogAnswer("kdialog", 2, "")).toBe(false);
  });

  test("CLI shims are .cmd files on Windows", () => {
    expect(renderShim("wrangler", "win32")).toEqual({ file: "wrangler.cmd", body: "@echo off\r\nrem 0bridge: run the real wrangler with this repo's profile (0b profile).\r\n0b exec --shim wrangler -- %*\r\n" });
    expect(renderShim("gh", "linux").file).toBe("gh");
  });

  test("Windows runs npm's .cmd CLIs through cmd, arguments quoted", () => {
    const PATH = "C:\\npm;C:\\bin";
    const exists = (p: string) => p === "C:\\npm\\wrangler.cmd" || p === "C:\\bin\\git.exe";
    expect(spawnTarget("wrangler", ["deploy", "--name", "my app"], PATH, "win32", exists)).toEqual({ cmd: "C:\\npm\\wrangler.cmd", args: ["deploy", "--name", '"my app"'], shell: true });
    expect(spawnTarget("git", ["status"], PATH, "win32", exists)).toEqual({ cmd: "C:\\bin\\git.exe", args: ["status"], shell: false });
    expect(spawnTarget("wrangler", ["deploy"], PATH, "linux", exists)).toEqual({ cmd: "wrangler", args: ["deploy"], shell: false });
  });

  test("on Windows a secret is shown only when a person is at the console", () => {
    expect(writeToTerminal("x", "win32", false)).toBe(false);
  });
});
