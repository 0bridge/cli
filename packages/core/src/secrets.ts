import { spawnSync } from "node:child_process";
import { join } from "node:path";
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

/** Plain JSON file, 0600 in a 0700 dir — fallback for non-macOS and tests. */
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

export function openSecretStore(storeDir: string): SecretStore {
  const mode = process.env.ZEROBRIDGE_SECRET_STORE;
  if (mode === "file" || (mode !== "keychain" && process.platform !== "darwin")) {
    return new FileStore(join(storeDir, "secrets.json"));
  }
  return new KeychainStore();
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
