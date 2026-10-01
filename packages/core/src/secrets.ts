import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { readJson, writeAtomic } from "./util.ts";

export interface SecretStore {
  readonly kind: string;
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete(name: string): void;
}

const SERVICE = "0bridge";

const SAFE_NAME = /^[A-Za-z0-9._:@\/+-]{1,200}$/;

/** Secret names are refs like `server.env.KEY`; values must be single-line (they come back via `-w`). */
export function assertSafe(name: string, value: string): void {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid secret name ${JSON.stringify(name)} (allowed: letters, digits, . _ : @ / + -)`);
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`secret ${name}: value contains control characters (newlines etc.) and cannot be stored`);
}

/** macOS login keychain via the `security` CLI. Values go over stdin, never argv. */
class KeychainStore implements SecretStore {
  readonly kind = "macOS Keychain";
  private cache = new Map<string, string | null>();

  get(name: string): string | null {
    if (this.cache.has(name)) return this.cache.get(name)!;
    // `-w` prints non-ASCII passwords as bare hex, indistinguishable from a hex-looking token.
    // `-g` labels the encoding: `password: "text"` or `password: 0xHEX  "..."`.
    const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", name, "-g"], { encoding: "utf8" });
    const line = r.status === 0 ? r.stderr.split("\n").find((l) => l.startsWith("password: ")) : undefined;
    const hex = line && /^password: 0x([0-9A-Fa-f]*)/.exec(line);
    const v = !line ? null : hex ? Buffer.from(hex[1]!, "hex").toString("utf8") : line.slice('password: "'.length, -1);
    this.cache.set(name, v);
    return v;
  }

  set(name: string, value: string): void {
    assertSafe(name, value);
    // `security -i` reads one command per line, so nothing user-controlled may carry a newline:
    // the name is restricted to a safe charset and the value goes over as hex (-X).
    const hex = Buffer.from(value, "utf8").toString("hex");
    const r = spawnSync("security", ["-i"], {
      input: `add-generic-password -U -s ${SERVICE} -a "${name}" -X ${hex}\n`,
      encoding: "utf8",
    });
    if (r.status !== 0 || /error/i.test(r.stderr)) throw new Error(`keychain write failed for ${name}: ${r.stderr.trim()}`);
    this.cache.set(name, value);
  }

  delete(name: string): void {
    spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", name]);
    this.cache.delete(name);
  }
}

/**
 * Linux: the desktop keyring (GNOME Keyring, KWallet) through the Secret Service, with libsecret's
 * `secret-tool`. Values go over stdin, never argv. Values stored in the file store before stay
 * readable there and move into the keyring when they're next written. When the keyring can't be
 * reached (locked with nobody to unlock it, no secret service running), everything goes to the file
 * store instead, so a background job without a desktop session still works.
 */
class LibsecretStore implements SecretStore {
  readonly kind = "Secret Service (secret-tool)";
  private cache = new Map<string, string | null>();
  private ok: boolean | null = null;
  constructor(
    private file: FileStore,
    private env: NodeJS.ProcessEnv,
  ) {}

  private run(args: string[], input?: string) {
    return spawnSync("secret-tool", args, { input, encoding: "utf8", env: this.env, timeout: 5000 });
  }
  /** Whether the keyring answers: looking up a name that doesn't exist exits 1 with nothing on stderr. */
  private usable(): boolean {
    if (this.ok === null) {
      const r = this.run(["lookup", "service", SERVICE, "account", "0bridge.probe"]);
      this.ok = !r.error && (r.status === 0 || (r.status === 1 && !r.stderr.trim()));
    }
    return this.ok;
  }

  get(name: string): string | null {
    if (this.cache.has(name)) return this.cache.get(name)!;
    let v: string | null = null;
    if (this.usable()) {
      const r = this.run(["lookup", "service", SERVICE, "account", name]);
      if (r.status === 0) v = r.stdout.replace(/\n$/, "");
    }
    v ??= this.file.get(name);
    this.cache.set(name, v);
    return v;
  }

  set(name: string, value: string): void {
    assertSafe(name, value);
    const r = this.usable() ? this.run(["store", `--label=0bridge ${name}`, "service", SERVICE, "account", name], value) : null;
    if (r?.status === 0) {
      if (this.file.get(name) !== null) this.file.delete(name);
    } else this.file.set(name, value);
    this.cache.set(name, value);
  }

  delete(name: string): void {
    if (this.usable()) this.run(["clear", "service", SERVICE, "account", name]);
    if (this.file.get(name) !== null) this.file.delete(name);
    this.cache.delete(name);
  }
}

/**
 * Windows: values sealed with DPAPI for this Windows user (PowerShell's ProtectedData), the sealed
 * text kept in a JSON file. PowerShell takes a few hundred ms to start, so every value is unsealed
 * in one call and cached for the rest of the process. If PowerShell can't seal, the file store is used.
 */
class DpapiStore implements SecretStore {
  readonly kind = "Windows DPAPI";
  private plain: Record<string, string> | null = null;
  constructor(
    private path: string,
    private file: FileStore,
  ) {}

  /** name → base64 through ProtectedData (`Protect` or `Unprotect`), all in one PowerShell run; null when it fails. */
  static transform(op: "Protect" | "Unprotect", items: Record<string, string>): Record<string, string> | null {
    if (!Object.keys(items).length) return {};
    const script = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = @{}
foreach ($p in $in.PSObject.Properties) { $out[$p.Name] = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}([Convert]::FromBase64String($p.Value), $null, 'CurrentUser')) }
$out | ConvertTo-Json -Compress`;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: JSON.stringify(items), encoding: "utf8", windowsHide: true, timeout: 15000 });
    if (r.status !== 0 || !r.stdout.trim()) return null;
    try {
      return JSON.parse(r.stdout.trim());
    } catch {
      return null;
    }
  }

  private sealed(): Record<string, string> {
    return readJson(this.path) ?? {};
  }

  private load(): Record<string, string> {
    if (this.plain) return this.plain;
    const sealed = this.sealed();
    const open = DpapiStore.transform("Unprotect", sealed) ?? {};
    this.plain = Object.fromEntries(Object.entries(open).map(([k, v]) => [k, Buffer.from(v, "base64").toString("utf8")]));
    return this.plain;
  }

  get(name: string): string | null {
    return this.load()[name] ?? this.file.get(name);
  }

  set(name: string, value: string): void {
    assertSafe(name, value);
    const sealed = DpapiStore.transform("Protect", { [name]: Buffer.from(value, "utf8").toString("base64") });
    if (!sealed?.[name]) return this.file.set(name, value);
    writeAtomic(this.path, JSON.stringify({ ...this.sealed(), [name]: sealed[name] }, null, 2) + "\n", { mode: 0o600, dirMode: 0o700 });
    this.load()[name] = value;
    if (this.file.get(name) !== null) this.file.delete(name);
  }

  delete(name: string): void {
    const all = this.sealed();
    if (name in all) {
      delete all[name];
      writeAtomic(this.path, JSON.stringify(all, null, 2) + "\n", { mode: 0o600, dirMode: 0o700 });
    }
    if (this.plain) delete this.plain[name];
    if (this.file.get(name) !== null) this.file.delete(name);
  }
}

/** Plain JSON file, 0600 in a 0700 dir — the fallback where no OS store is reachable, and for tests. */
class FileStore implements SecretStore {
  readonly kind: string;
  constructor(private path: string) {
    this.kind = `file (${path})`;
  }
  private load(): Record<string, string> {
    return readJson(this.path) ?? {};
  }
  get(name: string) {
    return this.load()[name] ?? null;
  }
  private save(all: Record<string, string>) {
    writeAtomic(this.path, JSON.stringify(all, null, 2) + "\n", { mode: 0o600, dirMode: 0o700 });
  }
  set(name: string, value: string) {
    assertSafe(name, value);
    const all = this.load();
    all[name] = value;
    this.save(all);
  }
  delete(name: string) {
    const all = this.load();
    delete all[name];
    this.save(all);
  }
}

/**
 * The session bus secret-tool talks over: the environment's, else the user's standard socket
 * (a cron job or a service started without one still reaches the keyring of a logged-in desktop).
 */
function dbusEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv | null {
  if (env.DBUS_SESSION_BUS_ADDRESS) return env;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const sock = uid === null ? null : join(env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`, "bus");
  return sock && existsSync(sock) ? { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${sock}` } : null;
}

const onPath = (cmd: string, env: NodeJS.ProcessEnv) => (env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, cmd)));

/** Which store this machine uses: ZEROBRIDGE_SECRET_STORE (file, keychain, libsecret, dpapi) wins, else the OS's own. */
export function secretStoreKind(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): "keychain" | "libsecret" | "dpapi" | "file" {
  const mode = env.ZEROBRIDGE_SECRET_STORE;
  if (mode === "file" || mode === "keychain" || mode === "libsecret" || mode === "dpapi") return mode;
  if (platform === "darwin") return "keychain";
  if (platform === "win32") return "dpapi";
  if (platform === "linux" && onPath("secret-tool", env) && dbusEnv(env)) return "libsecret";
  return "file";
}

export function openSecretStore(storeDir: string): SecretStore {
  const file = new FileStore(join(storeDir, "secrets.json"));
  switch (secretStoreKind()) {
    case "keychain":
      return new KeychainStore();
    case "libsecret":
      return new LibsecretStore(file, dbusEnv(process.env) ?? process.env);
    case "dpapi":
      return new DpapiStore(join(storeDir, "secrets.dpapi.json"), file);
    default:
      return file;
  }
}

const REF = /\$\{(secret|env):([^}]+)\}/g;

/** Replace `${secret:X}` / `${env:X}` refs with real values. Missing refs are collected, not thrown. */
export function resolveRefs(value: string, store: SecretStore, missing?: Set<string>): string {
  return value.replace(REF, (m, kind: string, name: string) => {
    const v = kind === "secret" ? store.get(name) : process.env[name];
    if (v == null) {
      missing?.add(`${kind}:${name}`);
      return m;
    }
    return v;
  });
}

export function secretRef(name: string): string {
  return `\${secret:${name}}`;
}

const SECRET_KEY = /(key|token|secret|passw|auth|pat$|credential|cookie|session)/i;

/** Heuristic: should this env/header value move into the secret store on import? */
export function looksSecret(key: string, value: string): boolean {
  if (!value || value.startsWith("${")) return false;
  if (SECRET_KEY.test(key)) return true;
  // Long opaque tokens without path separators or spaces.
  return value.length >= 24 && !/[\s/:]/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
}
