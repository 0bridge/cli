import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  CloudError,
  DEFAULT_ENV,
  ENV_NAME,
  GLOBAL_SCOPE,
  MAX_VALUE_BYTES,
  PROTECTED_ENVS,
  SECRET_NAME,
  vaultKeyName,
  accountName,
  accountSlot,
  loadAccounts,
  loadCloud,
  formatRecoveryKey,
  generateVaultKey,
  guessKind,
  itemsFor,
  loadVaultCache,
  maskNote,
  noteHasCredential,
  openNote,
  openSecretStore,
  openValue,
  parseDotenv,
  parseRecoveryKey,
  pointsAtThisMachine,
  repoOf,
  saveVaultCache,
  sealNote,
  sealValue,
  vaultKeyId,
  writeAtomic,
  type CloudClient,
  type Context,
  type GrantAsk,
  type VaultItem,
  type VaultKind,
  type VaultState,
} from "@0bridge/core";
import { openFromApprover, pairingCode, sealForDevice } from "@0bridge/core/vault-crypto";
import { cloudClient, openBrowser } from "./cloud.ts";
import { c } from "./ui.ts";

/**
 * The secrets vault on this machine: values are encrypted here with the vault key, which
 * lives in the OS keychain and never goes to the server. Agents use values by name through
 * `0b exec`; they never need to read one.
 */

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

/** Where secrets for the current directory live: its repo (by remote, so every clone shares them), or global outside a repo. */
export function scopeHere(cwd = process.cwd()): string | null {
  const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" }).stdout?.trim() === "true";
  if (!inRepo) return null;
  const r = repoOf(cwd);
  return r.remote ?? r.path;
}

/** The agent this runs under, from the variables each sets in the shells it starts; null at a person's own terminal. */
export function agentHere(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLAUDECODE === "1") return "claude-code";
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED || env.CODEX_THREAD_ID) return "codex";
  if (env.CURSOR_AGENT === "1") return "cursor";
  if (env.GEMINI_CLI === "1") return "gemini";
  return null;
}

/** The last two segments of a path, as the session board keeps them (no home folder). */
const lastTwo = (p: string) => p.split(/[\\/]+/).filter(Boolean).slice(-2).join("/");

/**
 * What the approval page shows about a prod request besides the command: the agent's own sentence
 * (`--why`), which agent and checkout it runs in, so the dashboard can find its session, and the
 * names of the values it will read.
 */
export function grantAsk(cwd: string, why: string | undefined, names: string[], env: NodeJS.ProcessEnv = process.env): GrantAsk {
  const git = (...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout?.trim() || undefined;
  const top = git("rev-parse", "--show-toplevel");
  // Empty on a detached HEAD; works before the first commit too.
  const branch = top ? git("branch", "--show-current") : undefined;
  return {
    ...(why?.trim() ? { why: why.trim().slice(0, 300) } : {}),
    context: {
      ...(agentHere(env) ? { agent: agentHere(env)! } : {}),
      ...(top ? { repo: basename(top) } : {}),
      ...(branch ? { branch } : {}),
      cwd: lastTwo(cwd),
      ...(top ? { root: lastTwo(top) } : {}),
      names: [...new Set(names)].slice(0, 50),
    },
  };
}

const scopeLabel = (scope: string) => (scope === GLOBAL_SCOPE ? "global" : scope);

/**
 * Write to the person at the keyboard, bypassing stdout (which an agent may be reading). Unix: the
 * controlling terminal, /dev/tty. Windows has none: when stdin is the console (a person typing,
 * not a program), its screen (CONOUT$). False when there's no terminal to write to.
 */
export function writeToTerminal(text: string, platform: NodeJS.Platform = process.platform, stdinIsTTY = Boolean(process.stdin.isTTY)): boolean {
  if (platform === "win32" && !stdinIsTTY) return false;
  try {
    const fd = openSync(platform === "win32" ? "\\\\.\\CONOUT$" : "/dev/tty", "w");
    writeSync(fd, platform === "win32" ? text.replace(/\r?\n/g, "\r\n") : text);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export const localKey = (ctx: Context): Uint8Array | null => {
  const raw = openSecretStore(ctx.storeDir).get(vaultKeyName(ctx));
  return raw ? new Uint8Array(Buffer.from(raw, "base64url")) : null;
};
/** The vault's values this machine can open, to mask them wherever they appear (a synced conversation, an agent task's events). */
export function vaultValues(ctx: Context): string[] {
  const key = localKey(ctx);
  const cache = loadVaultCache(ctx);
  if (!key || !cache?.keyId || vaultKeyId(key) !== cache.keyId) return [];
  return cache.items.flatMap((i) => {
    if (!i.ct || i.kind === "variable") return [];
    try {
      return [openValue(key, i)];
    } catch {
      return [];
    }
  });
}

const saveLocalKey = (ctx: Context, key: Uint8Array) => openSecretStore(ctx.storeDir).set(vaultKeyName(ctx), Buffer.from(key).toString("base64url"));

/** The vault as the server has it, kept offline too; falls back to the offline copy when the server can't be reached. */
async function fetchVault(ctx: Context, client: CloudClient): Promise<{ state: VaultState; offline: boolean }> {
  try {
    const state = await client.vault();
    saveVaultCache(ctx, state);
    return { state, offline: false };
  } catch (e) {
    const cached = loadVaultCache(ctx);
    if (!cached || e instanceof CloudError) throw e;
    return { state: cached, offline: true };
  }
}

/**
 * Show the recovery key to the person at the keyboard only: straight to the terminal, bypassing
 * stdout, which an agent may be reading. With no terminal, it goes to a 0600 file instead.
 */
function showRecoveryKey(ctx: Context, key: Uint8Array, why: string): void {
  const text = `
  ${c.bold("Your 0bridge vault recovery key")} (${why})${loadAccounts(ctx).accounts.length > 1 ? `
  for ${accountName(loadCloud(ctx)!)}` : ""}

      ${c.cyan(formatRecoveryKey(key))}

  Save it in your password manager. It's the only way to open your secrets on a new
  machine when no other signed-in machine is around, and 0bridge can't recover it for you.

`;
  if (writeToTerminal(text)) console.log(c.dim("Recovery key shown in your terminal (not in this command's output)."));
  else {
    const file = join(ctx.storeDir, `vault-recovery-key${accountSlot(ctx)}.txt`);
    writeAtomic(file, `${formatRecoveryKey(key)}\n`, { mode: 0o600, dirMode: 0o700 });
    console.log(`Your vault recovery key is in ${c.bold(file)}. Move it to your password manager, then delete the file.`);
  }
}

/**
 * Ask the user to approve this device for a protected env (prod) and wait for the answer. The
 * approval happens in the browser with a passkey, so nothing on this machine can give it.
 * Messages go to stderr: a command's own output stays clean.
 */
async function requestApproval(client: CloudClient, scope: string, env: string, reason?: string, ask?: GrantAsk): Promise<void> {
  const g = await client.requestGrant(scope, env, reason, ask);
  console.error(`${c.yellow("●")} ${c.bold(env)} secrets need your approval. Code ${c.bold(g.code)}. Approve in your browser:\n  ${c.cyan(g.url)}`);
  openBrowser(g.url);
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const { status, until } = await client.grant(g.id);
    if (status === "approved") {
      const mins = until ? Math.round((until - Date.now()) / 60_000) : 0;
      console.error(`${c.green("✓")} approved${mins ? ` for ${mins} minutes` : ""}`);
      return;
    }
    if (status === "denied") throw new Error(`${env} access was denied in the browser`);
    if (status === "expired" || Date.now() > g.expiresAt) throw new Error(`the ${env} approval wasn't given in time; run the command again`);
  }
}

/** Run a write; for a protected env the server first wants an approval, then the write is tried again. */
async function withApproval<T>(client: CloudClient, at: { scope: string; env: string }, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof CloudError) || e.code !== "APPROVAL_REQUIRED") throw e;
    await requestApproval(client, at.scope, at.env, "change secrets");
    return run();
  }
}

interface OpenVault {
  client: CloudClient;
  key: Uint8Array;
  keyId: string;
  state: VaultState;
}

/** The vault, ready to read and write. `create`: make one on first use. Throws with what to do when this device can't open it. */
export async function openVault(ctx: Context, opts: { create?: boolean } = {}): Promise<OpenVault | null> {
  const { client } = cloudClient(ctx);
  let { state } = await fetchVault(ctx, client);
  let key = localKey(ctx);
  if (!state.keyId) {
    if (!opts.create) return null;
    key ??= generateVaultKey();
    const r = await client.createVault(vaultKeyId(key));
    if (r.error) throw new Error(`${r.error}. Run \`0b vault unlock\` with that vault's recovery key.`);
    saveLocalKey(ctx, key);
    state = { keyId: r.keyId, items: [] };
    saveVaultCache(ctx, state);
    console.log(`${c.green("✓")} created your vault. Values are encrypted on this machine; 0bridge stores only ciphertext.`);
    showRecoveryKey(ctx, key, "shown once");
  }
  if (!key) throw new Error("this machine doesn't have your vault key yet. Run `0b vault unlock` and approve it in your browser with your passkey");
  const keyId = vaultKeyId(key);
  if (keyId !== state.keyId) throw new Error("this machine has a different vault key than your account. Run `0b vault unlock` with your recovery key");
  return { client, key, keyId, state };
}

function checkValue(name: string, value: string) {
  if (!SECRET_NAME.test(name)) fail(`"${name}" isn't a valid name (letters, digits and _, not starting with a digit)`);
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) fail(`${name} is over 32 KiB`);
}

async function askValue(name: string): Promise<string> {
  if (!process.stdin.isTTY) return readFileSync(0, "utf8").replace(/\r?\n$/, "");
  const { password, isCancel } = await import("@clack/prompts");
  const v = await password({ message: `Value for ${name}`, mask: "•", validate: (x) => (x ? undefined : "required") });
  if (isCancel(v)) process.exit(0);
  return v;
}

export interface SecretOptions {
  env?: string;
  global?: boolean;
  delete?: boolean;
  yes?: boolean;
  /** Store as a plain variable (shown, not masked) or force secret, instead of guessing. */
  variable?: boolean;
  secret?: boolean;
  /** A note to store with the value (`set --note`). */
  note?: string;
  /** Read the value from this file (`set --file key.pem`): for values of several lines. */
  file?: string;
  /** `import --only A,B`: move just these names from the file, leave the rest where they are. */
  only?: string;
  /** `import --dry-run`: list what would be stored (names, kind, replaces, local-looking), store nothing. */
  dryRun?: boolean;
}

const kindOf = (opts: SecretOptions, name: string, value: string): VaultKind =>
  opts.variable ? "variable" : opts.secret ? "secret" : guessKind(name, value);

function target(opts: SecretOptions): { scope: string; env: string } {
  const env = opts.env ?? DEFAULT_ENV;
  if (!ENV_NAME.test(env)) fail(`"${env}" isn't a valid environment name (lowercase letters, digits, -)`);
  return { scope: opts.global ? GLOBAL_SCOPE : (scopeHere() ?? GLOBAL_SCOPE), env };
}

async function put(v: OpenVault, at: { scope: string; env: string; name: string }, value: string, kind: VaultKind, note?: string) {
  const extra = note === undefined ? {} : { note: note.trim() ? sealNote(v.key, at, note.trim()) : null };
  await withApproval(v.client, at, () => v.client.putSecret(v.keyId, { ...at, kind, ct: sealValue(v.key, at, value), ...extra }));
}

/** Change a value's switch, kind or note in place (a protected env asks for approval first). */
async function patch(ctx: Context, at: { scope: string; env: string; name: string }, change: { enabled?: boolean; kind?: VaultKind; note?: string | null }) {
  const { client } = cloudClient(ctx);
  const r = await withApproval(client, at, () => client.patchSecret({ ...at, ...change }));
  if (r?.error) fail(`no ${at.name} for ${scopeLabel(at.scope)} (${at.env}). See 0b secret list`);
}

/** Read what was pasted or piped in: a whole .env, until end of input (Ctrl-D in a terminal). */
async function readPasted(): Promise<string> {
  if (process.stdin.isTTY) console.error(c.dim("Paste KEY=value lines, then press Ctrl-D on an empty line:"));
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** `--only A,B`: just those names, each of which must be in what was read. */
export function pick(entries: [string, string][], only: string | undefined, from: string): [string, string][] {
  if (only === undefined) return entries;
  const names = only.split(",").map((n) => n.trim()).filter(Boolean);
  const missing = names.filter((n) => !entries.some(([k]) => k === n));
  if (!names.length) fail("--only needs names: --only STRIPE_KEY,OPENAI_API_KEY");
  if (missing.length) fail(`not in ${from}: ${missing.join(", ")}`);
  return entries.filter(([k]) => names.includes(k));
}

/** Names already stored where this import would write (names only; no key needed). */
async function existingNames(ctx: Context, client: CloudClient, t: { scope: string; env: string }): Promise<Set<string>> {
  const { state } = await fetchVault(ctx, client);
  return new Set(state.items.filter((i) => i.scope === t.scope && i.env === t.env).map((i) => i.name));
}

/**
 * `import --dry-run`: what would be stored, so the person picks before anything moves. Names and
 * tags only, never values. An agent shows this and asks; a whole .env is rarely all vault material
 * (a local database address or a key made on this machine belongs to this machine).
 */
async function previewImport(ctx: Context, entries: [string, string][], opts: SecretOptions, from: string, again: string) {
  const t = target(opts);
  const existing = await existingNames(ctx, cloudClient(ctx).client, t);
  console.log(`${entries.length} values in ${from} for ${scopeLabel(t.scope)} (${t.env}). ${c.yellow("Nothing stored")} (--dry-run).`);
  for (const [k, val] of entries) {
    const tags = [
      kindOf(opts, k, val),
      existing.has(k) ? c.yellow("replaces the one in the vault") : null,
      pointsAtThisMachine(val) ? c.yellow("points at this machine: every other machine would get the same address") : null,
    ].filter(Boolean);
    console.log(`  ${k}  ${c.dim("·")} ${tags.join(c.dim(" · "))}`);
  }
  console.log(c.dim(`Store the ones you pick: ${again} --only NAME,NAME`));
}

async function importEntries(ctx: Context, entries: [string, string][], opts: SecretOptions, from: string) {
  const t = target(opts);
  const v = (await openVault(ctx, { create: true }))!;
  const existing = await existingNames(ctx, v.client, t);
  const kinds: Record<VaultKind, string[]> = { secret: [], variable: [] };
  const ops = entries.map(([k, val]) => {
    checkValue(k, val);
    const kind = kindOf(opts, k, val);
    kinds[kind].push(k);
    const at = { ...t, name: k };
    return { op: "put" as const, ...at, kind, ct: sealValue(v.key, at, val) };
  });
  // One request for the whole file, all or nothing.
  for (let i = 0; i < ops.length; i += 500) await withApproval(v.client, t, () => v.client.vaultBatch(v.keyId, ops.slice(i, i + 500)));
  console.log(`${c.green("✓")} ${entries.length} values from ${from} stored for ${scopeLabel(t.scope)} (${t.env})`);
  if (kinds.secret.length) console.log(`  secrets    ${c.dim(kinds.secret.join(", "))}  ${c.dim("(hidden, masked in agents' output)")}`);
  if (kinds.variable.length) console.log(`  variables  ${c.dim(kinds.variable.join(", "))}  ${c.dim("(shown as is)")}`);
  if (kinds.variable.length && !opts.variable) console.log(c.dim(`  Wrong guess? ${"0b secret mark <NAME> --secret"} (or --variable). --secret on import hides them all.`));
  const replaced = entries.map(([k]) => k).filter((k) => existing.has(k));
  if (replaced.length) console.log(`  ${c.yellow("replaced")}   ${c.dim(replaced.join(", "))}  ${c.dim("(the vault had these; the file's values are stored now)")}`);
  const local = entries.filter(([, val]) => pointsAtThisMachine(val)).map(([k]) => k);
  if (local.length) console.log(`  ${c.yellow("local")}      ${c.dim(local.join(", "))}  ${c.dim(`(point at this machine; other machines get the same address. Remove: 0b secret rm <NAME>)`)}`);
}

export async function secretCommand(ctx: Context, args: string[], opts: SecretOptions): Promise<void> {
  const [sub, name, value] = args;
  switch (sub) {
    case "set": {
      if (!name) fail("usage: 0b secret set <NAME> [--variable] [--env dev|prod] [--global] [--file <path>]   (the value is asked for, read from stdin, or from --file for several lines)");
      if (value !== undefined && !opts.variable) fail("don't put secret values in the command line (shell history, agent transcripts). Run it without the value to be asked for it, or pipe it in. Plain settings can: 0b secret set PORT 3000 --variable");
      const at = { ...target(opts), name };
      if (opts.note && noteHasCredential(opts.note)) fail("that note looks like it holds a key or token. Notes are shown in lists, which agents read: describe the value in words.");
      const v = (await openVault(ctx, { create: true }))!;
      // --file: a value of several lines (a PEM private key, a JSON service account), read as is.
      const val = value ?? (opts.file ? readFileSync(resolve(opts.file), "utf8").replace(/\r?\n$/, "") : await askValue(name));
      checkValue(name, val);
      const kind: VaultKind = opts.variable ? "variable" : "secret";
      await put(v, at, val, kind, opts.note);
      console.log(`${c.green("✓")} ${c.bold(name)} stored as a ${kind} for ${scopeLabel(at.scope)} (${at.env}). Commands get it through ${c.cyan("0b exec -- <command>")}.`);
      return;
    }
    case "import":
    case "paste": {
      // `-`, `paste`, or piped input: read KEY=value lines from stdin (a pasted .env).
      const pasted = sub === "paste" || name === "-" || (!name && !process.stdin.isTTY && !existsSync(resolve(".env")));
      if (pasted) {
        const read = Object.entries(parseDotenv(await readPasted())).filter(([k]) => SECRET_NAME.test(k));
        if (!read.length) fail("no KEY=value lines were pasted");
        const entries = pick(read, opts.only, "what you pasted");
        if (opts.dryRun) return previewImport(ctx, entries, opts, "what you pasted", "0b secret paste");
        return importEntries(ctx, entries, opts, "what you pasted");
      }
      const file = resolve(name ?? ".env");
      if (!existsSync(file)) fail(`${relative(process.cwd(), file) || file} not found. To paste values instead: 0b secret paste`);
      const rel = relative(process.cwd(), file);
      const shown = rel && !rel.startsWith("..") ? rel : file;
      const read = Object.entries(parseDotenv(readFileSync(file, "utf8"))).filter(([k]) => SECRET_NAME.test(k));
      if (!read.length) fail(`no KEY=value lines in ${file}`);
      const entries = pick(read, opts.only, shown);
      if (opts.dryRun) return previewImport(ctx, entries, opts, shown, `0b secret import ${shown}`);
      // Part of a file moved: the rest still lives only there, so it is never deleted.
      const partial = entries.length < read.length;
      if (partial && opts.delete) fail(`--delete would lose the ${read.length - entries.length} values --only left in ${shown}`);
      await importEntries(ctx, entries, opts, shown);
      let remove = Boolean(opts.delete);
      if (!remove && !partial && process.stdin.isTTY && process.stdout.isTTY && !opts.yes) {
        const { confirm, isCancel } = await import("@clack/prompts");
        const a = await confirm({ message: `Delete ${relative(process.cwd(), file)} now that the values are in the vault?`, initialValue: false });
        remove = a === true && !isCancel(a);
      }
      if (remove) {
        rmSync(file);
        console.log(`${c.green("✓")} deleted ${relative(process.cwd(), file)}. Run commands with ${c.cyan("0b exec -- <command>")} to get the values.`);
      } else console.log(c.dim(`Kept ${relative(process.cwd(), file)}. Delete it when you're ready (or re-run with --delete); 0bridge never removes it on its own.`));
      return;
    }
    case "show":
    case "get": {
      if (!name) fail("usage: 0b secret show <NAME> [--env dev|prod] [--global]");
      return show(ctx, { ...target(opts), name });
    }
    case "mark": {
      if (!name || (!opts.variable && !opts.secret)) fail("usage: 0b secret mark <NAME> --secret|--variable [--env dev|prod] [--global]");
      const kind: VaultKind = opts.variable ? "variable" : "secret";
      await patch(ctx, { ...target(opts), name }, { kind });
      console.log(`${c.green("✓")} ${name} is now a ${kind}${kind === "secret" ? " (hidden, masked in agents' output)" : " (shown as is)"}`);
      return;
    }
    case "off":
    case "disable":
    case "on":
    case "enable": {
      const enabled = sub === "on" || sub === "enable";
      if (!name) fail(`usage: 0b secret ${sub} <NAME> [--env dev|prod] [--global]`);
      const at = { ...target(opts), name };
      await patch(ctx, at, { enabled });
      console.log(
        enabled
          ? `${c.green("✓")} ${name} is on again for ${scopeLabel(at.scope)} (${at.env})`
          : `${c.green("✓")} ${name} is off for ${scopeLabel(at.scope)} (${at.env}): kept in the vault, but commands don't get it. ${c.cyan(`0b secret on ${name}`)} brings it back.`,
      );
      return;
    }
    case "note": {
      if (!name) fail('usage: 0b secret note <NAME> "what it is" [--env dev|prod] [--global]   (no text clears the note)');
      const at = { ...target(opts), name };
      const text = args.slice(2).join(" ").trim();
      if (text.length > 1500) fail("notes are up to 1500 characters");
      if (noteHasCredential(text)) fail("that note looks like it holds a key or token. Notes are shown in lists, which agents read: keep the value in the secret itself and describe it in words.");
      const v = (await openVault(ctx)) ?? fail("no vault yet");
      await patch(ctx, at, { note: text ? sealNote(v.key, at, text) : null });
      console.log(text ? `${c.green("✓")} noted ${name}: ${c.dim(text)}` : `${c.green("✓")} cleared ${name}'s note`);
      return;
    }
    case "rm":
    case "remove":
    case "delete": {
      if (!name) fail("usage: 0b secret rm <NAME> [--env dev|prod] [--global]");
      const at = { ...target(opts), name };
      const { client } = cloudClient(ctx);
      const r = await withApproval(client, at, () => client.deleteSecret(at));
      if (r?.error) fail(`no ${name} for ${scopeLabel(at.scope)} (${at.env})`);
      console.log(`${c.green("✓")} removed ${name} from ${scopeLabel(at.scope)} (${at.env})`);
      return;
    }
    case undefined:
    case "list":
    case "ls":
      return list(ctx);
    default:
      fail(`unknown subcommand "secret ${sub}". Try: set, import, paste, list, show, mark, off, on, note, rm`);
  }
}

/** Names only, grouped by where they apply here; values are never printed. */
async function list(ctx: Context) {
  const { client } = cloudClient(ctx);
  const { state, offline } = await fetchVault(ctx, client);
  if (!state.keyId || !state.items.length) {
    console.log(`No secrets yet. ${c.cyan("0b secret set STRIPE_KEY")} stores one for this repo; ${c.cyan("0b secret import .env")} moves a whole file.`);
    return;
  }
  const here = scopeHere();
  const key = localKey(ctx);
  const canOpen = key && vaultKeyId(key) === state.keyId;
  const scopes = [...new Set(state.items.map((i) => i.scope))].sort((a, b) => (a === here ? -1 : b === here ? 1 : a === GLOBAL_SCOPE ? -1 : b === GLOBAL_SCOPE ? 1 : a.localeCompare(b)));
  for (const scope of scopes) {
    const mark = scope === here ? c.green("●") : scope === GLOBAL_SCOPE ? c.dim("◆") : " ";
    console.log(`${mark} ${c.bold(scopeLabel(scope))}${scope === here ? c.dim(" (this repo)") : ""}`);
    const envs = [...new Set(state.items.filter((i) => i.scope === scope).map((i) => i.env))].sort();
    for (const env of envs) {
      const items = state.items.filter((i) => i.scope === scope && i.env === env);
      const label = (i: VaultItem) => {
        const tags = [i.kind === "variable" ? "variable" : null, i.enabled === false ? "off" : null].filter(Boolean);
        const name = i.enabled === false ? c.dim(i.name) : i.name;
        return `${name}${tags.length ? c.dim(` (${tags.join(", ")})`) : ""}`;
      };
      const notes = canOpen ? items.map((i) => [i, openNote(key!, i)] as const).filter(([, n]) => n) : [];
      console.log(`    ${c.dim(env.padEnd(6))} ${items.map(label).join(", ")}${PROTECTED_ENVS.has(env) ? c.dim("  (needs your approval to use)") : ""}`);
      // Masked even here: a key that got into a note earlier mustn't reach an agent reading the list.
      for (const [i, n] of notes) console.log(`           ${c.dim(`${i.name}: ${maskNote(n!.replace(/\s+/g, " "))}`)}`);
    }
  }
  if (!key) console.log(c.yellow(`\nThis machine can't open them yet: run ${c.cyan("0b vault unlock")} and approve it in your browser.`));
  if (offline) console.log(c.dim("\n(offline: showing the last copy)"));
}

// ── Asking for the vault key ───────────────────────────────
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
/** `0b vault unlock` waits as long as a request lasts (10 minutes on the server). */
const PAIRING_WAIT_MS = 10 * 60_000 + 5_000;

/**
 * A vault key request that outlives this process (an agent's shell times out; the person approves
 * later): the pairing, and the private half of its key pair, in a 0600 file next to the account.
 */
interface PendingUnlock {
  userId: string;
  /** The vault this request is for: a new vault on the account makes it moot. */
  keyId: string;
  id: string;
  url: string;
  expiresAt: number;
  devicePub: string;
  /** PKCS #8, base64url. Only good for this one request. */
  privateKey: string;
}

const pendingPath = (ctx: Context) => join(ctx.storeDir, `vault-pending${accountSlot(ctx)}.json`);

function loadPending(ctx: Context, userId: string, keyId: string): PendingUnlock | null {
  try {
    const p = JSON.parse(readFileSync(pendingPath(ctx), "utf8")) as PendingUnlock;
    return p.userId === userId && p.keyId === keyId && p.expiresAt > Date.now() ? p : null;
  } catch {
    return null;
  }
}
const dropPending = (ctx: Context) => rmSync(pendingPath(ctx), { force: true });

/** A pairing key pair whose private half can be saved (pairingKeyPair's can't, by design: it lives for one process). */
async function savableKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const kp = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    privateKey: Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64url"),
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url"),
  };
}
const importPrivate = (pkcs8: string) => crypto.subtle.importKey("pkcs8", Buffer.from(pkcs8, "base64url"), ECDH, false, ["deriveBits"]);

/** `none`: the account has no vault yet, so there's nothing to ask for (the caller says so). */
type UnlockResult = "unlocked" | "already" | "none" | "pending" | "denied" | "expired";

/**
 * Ask for the vault key without blocking forever: prints the approval link (and code) and waits up
 * to `waitMs` (0 = don't wait). The request is saved, so a later call (or `0b vault unlock`)
 * picks up the same one instead of asking again. `agentVm`: say plainly that this computer isn't
 * the user's own (the approval page warns too).
 */
export async function requestUnlock(ctx: Context, opts: { waitMs: number; quiet?: boolean; agentVm?: boolean; browser?: boolean }): Promise<UnlockResult> {
  const say = (s: string) => opts.quiet || console.log(s);
  const { cfg, client } = cloudClient(ctx);
  const { state } = await fetchVault(ctx, client);
  if (!state.keyId) return "none";
  const have = localKey(ctx);
  if (have && vaultKeyId(have) === state.keyId) {
    dropPending(ctx);
    return "already";
  }
  let pending = loadPending(ctx, cfg.userId, state.keyId);
  // What the request says now; a request that's gone (answered elsewhere, expired) makes way for a new one.
  const check = async (p: PendingUnlock): Promise<UnlockResult | null> => {
    const r = await client.pairing(p.id).catch((e) => {
      if (e instanceof CloudError && e.status === 404) return { status: "expired" as const };
      throw e;
    });
    if (r.status === "approved" && r.ephemeralPub && r.ct) {
      let key: Uint8Array;
      try {
        key = await openFromApprover(await importPrivate(p.privateKey), p.devicePub, r.ephemeralPub, r.ct);
      } catch {
        dropPending(ctx);
        throw new Error("the approval couldn't be opened here; run `0b vault unlock` again");
      }
      dropPending(ctx);
      if (vaultKeyId(key) !== state.keyId) throw new Error("that key is for a different vault");
      saveLocalKey(ctx, key);
      say(`${c.green("✓")} this machine can open your vault now (${state.items.length} values).`);
      return "unlocked";
    }
    if (r.status === "denied") {
      dropPending(ctx);
      say(c.yellow("✗ the vault key was denied for this machine."));
      return "denied";
    }
    if (r.status === "pending" && Date.now() < p.expiresAt) return null;
    dropPending(ctx);
    return "expired";
  };
  if (pending) {
    const now = await check(pending);
    if (now === "unlocked" || now === "denied") return now;
    if (now === "expired") pending = null;
  }
  if (!pending) {
    const pair = await savableKeyPair();
    const req = await client.requestPairing(pair.publicKey);
    pending = { userId: cfg.userId, keyId: state.keyId, id: req.id, url: req.url, expiresAt: req.expiresAt, devicePub: pair.publicKey, privateKey: pair.privateKey };
    writeAtomic(pendingPath(ctx), JSON.stringify(pending), { mode: 0o600, dirMode: 0o700 });
  }
  // The link first and alone, like the sign-in link: an agent relays it as is.
  say(`Approve the vault key: ${pending.url}`);
  say(`Code: ${await pairingCode(pending.devicePub)} ${c.dim("(the approval page shows the same code)")}`);
  if (opts.agentVm) say(c.dim("This is an AI agent's computer: anything running on it can use every secret the vault opens. Approve only if you want that."));
  else say(c.dim(`Approve it in your browser (passkey), or run ${"0b vault approve"} on a machine that has the vault.`));
  if (opts.browser) openBrowser(pending.url);
  const until = Date.now() + Math.max(0, opts.waitMs);
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, Math.min(2000, Math.max(0, until - Date.now()))));
    const now = await check(pending);
    if (now) return now;
  }
  if (Date.now() >= pending.expiresAt) {
    dropPending(ctx);
    return "expired";
  }
  say(c.dim(`Not approved yet. Run ${"0b vault unlock"} after approving (the request lasts until ${new Date(pending.expiresAt).toLocaleTimeString()}).`));
  return "pending";
}

export async function vaultCommand(ctx: Context, args: string[], opts: { recoveryKey?: boolean } = {}): Promise<void> {
  const [sub] = args;
  switch (sub) {
    case undefined:
    case "status": {
      const { client } = cloudClient(ctx);
      const { state } = await fetchVault(ctx, client);
      const key = localKey(ctx);
      if (!state.keyId) return console.log(`No vault yet. The first ${c.cyan("0b secret set")} creates it.`);
      const ok = key && vaultKeyId(key) === state.keyId;
      console.log(`Vault ${c.dim(state.keyId)}: ${state.items.length} values`);
      console.log(ok ? `${c.green("✓")} this machine can open it` : c.yellow(`✗ this machine can't open it: run ${c.cyan("0b vault unlock")} and approve it in your browser`));
      return;
    }
    case "unlock":
      return unlock(ctx, Boolean(opts.recoveryKey));
    case "approve":
      return approvePairings(ctx);
    case "recovery-key": {
      const key = localKey(ctx) ?? fail("this machine doesn't have the vault key");
      showRecoveryKey(ctx, key, "keep it private");
      return;
    }
    default:
      fail(`unknown subcommand "vault ${sub}". Try: status, unlock, approve, recovery-key`);
  }
}

/**
 * Show one value to the person at this machine. A secret goes straight to the terminal
 * (/dev/tty), never to stdout, so an agent running this doesn't receive it; a variable prints normally.
 */
async function show(ctx: Context, at: { scope: string; env: string; name: string }): Promise<void> {
  const v = (await openVault(ctx)) ?? fail("no vault yet");
  const find = (st: VaultState) => st.items.find((i) => i.scope === at.scope && i.env === at.env && i.name === at.name);
  let item = find(v.state) ?? fail(`no ${at.name} for ${scopeLabel(at.scope)} (${at.env}). See 0b secret list`);
  if (!item.ct) {
    await requestApproval(v.client, at.scope, at.env, `show ${at.name}`);
    item = find(await v.client.vault()) ?? fail(`${at.name} is gone`);
  }
  const value = openValue(v.key, item);
  if (item.kind === "variable") return console.log(value);
  if (!writeToTerminal(`${value}\n`))
    fail("secrets are shown only in your own terminal (or the dashboard's Secrets page), never to a program reading this output");
}

/**
 * Give this machine the vault key. By default it asks for it: the dashboard (after a passkey) or
 * another signed-in machine (`0b vault approve`) encrypts the key to a key pair made here, and the
 * gateway only relays it. Both sides show a code from this machine's public key to compare.
 * Nothing secret is printed, so an agent may run this. `--recovery-key` types the key instead.
 */
async function unlock(ctx: Context, withRecoveryKey: boolean): Promise<void> {
  const { client } = cloudClient(ctx);
  const { state } = await fetchVault(ctx, client);
  if (!state.keyId) fail("your account has no vault yet; `0b secret set` creates one");
  const have = localKey(ctx);
  if (have && vaultKeyId(have) === state.keyId) return console.log(`${c.green("✓")} this machine can already open your vault.`);
  let key: Uint8Array;
  if (withRecoveryKey) {
    if (!process.stdin.isTTY) fail("run `0b vault unlock --recovery-key` in your own terminal; the recovery key shouldn't pass through an agent");
    const { password, isCancel } = await import("@clack/prompts");
    const v = await password({ message: "Recovery key (0B-XXXX-…)", mask: "•" });
    if (isCancel(v)) return;
    try {
      key = parseRecoveryKey(v);
    } catch (e) {
      fail((e as Error).message);
    }
  } else {
    // The same request as an earlier `0b setup --agent-vm` or `requestUnlock` made, if one is still open.
    let r: UnlockResult;
    try {
      r = await requestUnlock(ctx, { waitMs: PAIRING_WAIT_MS, browser: true });
    } catch (e) {
      fail((e as Error).message);
    }
    if (r === "unlocked" || r === "already" || r === "none") return;
    fail(r === "denied" ? "denied" : "not approved in time; run `0b vault unlock` again, or use --recovery-key");
  }
  if (vaultKeyId(key) !== state.keyId) fail("that key is for a different vault");
  saveLocalKey(ctx, key);
  console.log(`${c.green("✓")} this machine can open your vault now (${state.items.length} values).`);
}

/** On a machine that has the vault: hand the key to another of the user's machines, after comparing codes. */
async function approvePairings(ctx: Context): Promise<void> {
  // Which machines wait is fine for anyone to know (an agent can pass it on); answering takes the person.
  const { cfg, client } = cloudClient(ctx);
  const waiting = await client.pairings().catch(() => []);
  if (waiting.length)
    console.log(`${waiting.length} ${waiting.length === 1 ? "machine is" : "machines are"} waiting for your vault key: approve on the dashboard, ${c.cyan(`${cfg.server.replace(/\/+$/, "")}/app/approvals`)}${process.stdin.isTTY ? c.dim(", or here") : ""}`);
  if (!process.stdin.isTTY) fail("run `0b vault approve` in your own terminal: it hands your vault key to another machine");
  const v = (await openVault(ctx)) ?? fail("no vault yet");
  const open = await v.client.pairings();
  if (!open.length) return console.log(`No machines are asking. Run ${c.cyan("0b vault unlock")} on the new machine first.`);
  const { confirm, isCancel } = await import("@clack/prompts");
  for (const r of open) {
    const code = await pairingCode(r.devicePub);
    const ok = await confirm({ message: `Give your vault key to ${c.bold(r.device ?? "a new machine")}? Its terminal must show code ${c.bold(code)}.`, initialValue: false });
    if (isCancel(ok)) return;
    await v.client.decidePairing(r.id, ok ? await sealForDevice(v.key as Uint8Array<ArrayBuffer>, r.devicePub) : null);
    console.log(ok ? `${c.green("✓")} sent to ${r.device ?? "the new machine"}` : c.dim("denied"));
  }
}

/**
 * The environment `0b exec` adds for a command in `cwd`: the vault's global values and this
 * repo's, for `env`. A protected env (prod) first asks for the user's approval in the browser.
 * Returns nothing (with a note on stderr) when there's no vault or this machine can't open it,
 * so commands still run.
 */
export async function vaultEnv(ctx: Context, cwd: string, env: string, reason?: string, why?: string): Promise<{ env: Record<string, string>; hidden: string[] }> {
  const none = { env: {}, hidden: [] };
  let client: CloudClient;
  try {
    client = cloudClient(ctx).client;
  } catch {
    if (PROTECTED_ENVS.has(env)) fail(`${env} secrets need you to be signed in (0b login)`);
    return none;
  }
  let state: VaultState;
  try {
    state = (await fetchVault(ctx, client)).state;
  } catch (e) {
    if (PROTECTED_ENVS.has(env)) fail(`${env} secrets couldn't be loaded: ${(e as Error).message}`);
    console.error(c.yellow(`0b: secrets not loaded (${(e as Error).message})`));
    return none;
  }
  if (!state.keyId) return none;
  const scope = scopeHere(cwd);
  let items: VaultItem[] = itemsFor(state, scope, env);
  if (!items.length) {
    if (PROTECTED_ENVS.has(env)) console.error(c.yellow(`0b: no ${env} secrets for ${scope ?? "global"} (0b secret set <NAME> --env ${env})`));
    return none;
  }
  const key = localKey(ctx);
  if (!key || vaultKeyId(key) !== state.keyId) {
    if (PROTECTED_ENVS.has(env)) fail("this machine can't open your vault (run `0b vault unlock`, then approve it in your browser)");
    console.error(c.yellow(`0b: secrets not loaded: this machine can't open your vault (run \`0b vault unlock\`, then approve it in your browser)`));
    return none;
  }
  if (items.some((i) => i.locked)) {
    try {
      const ask = grantAsk(cwd, why, items.filter((i) => i.locked).map((i) => i.name));
      if (!ask.why && ask.context?.agent) console.error(c.dim(`0b: agents, add --why "<what this is for>" so the approval page says why`));
      await requestApproval(client, scope ?? GLOBAL_SCOPE, env, reason, ask);
      // Held in memory for this command only; the offline copy never keeps protected values.
      state = await client.vault();
    } catch (e) {
      fail((e as Error).message);
    }
    items = itemsFor(state, scope, env);
  }
  const values = items.map((i) => [i.name, openValue(key, i), i.kind ?? "secret"] as const);
  return { env: Object.fromEntries(values.map(([n, v]) => [n, v])), hidden: values.filter(([, , k]) => k === "secret").map(([, v]) => v) };
}
