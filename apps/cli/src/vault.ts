import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  CloudError,
  vaultKeyName,
  accountName,
  accountSlot,
  loadAccounts,
  loadCloud,
  formatRecoveryKey,
  generateVaultKey,
  loadVaultCache,
  openSecretStore,
  parseRecoveryKey,
  saveVaultCache,
  vaultKeyId,
  writeAtomic,
  type CloudClient,
  type Context,
  type VaultState,
} from "@0bridge/core";
import { openFromApprover, pairingCode, sealForDevice } from "@0bridge/core/vault-crypto";
import { cloudClient, openBrowser } from "./cloud.ts";
import { c } from "./ui.ts";

/**
 * The vault key on this machine: made here, kept in the OS keychain, and handed to the
 * user's other machines sealed, so the server never has it. End-to-end history is
 * encrypted with it. The vault held secret values for `0b exec` until D86; only the key is left.
 */

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

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

  Save it in your password manager. It's the only way to open your end-to-end encrypted history
  on a new machine when no other signed-in machine is around, and 0bridge can't recover it for you.

`;
  if (writeToTerminal(text)) console.log(c.dim("Recovery key shown in your terminal (not in this command's output). Save it now: it isn't shown again."));
  else {
    const file = join(ctx.storeDir, `vault-recovery-key${accountSlot(ctx)}.txt`);
    writeAtomic(file, `${formatRecoveryKey(key)}\n`, { mode: 0o600, dirMode: 0o700 });
    console.log(`Your vault recovery key is in ${c.bold(file)}. Move it to your password manager, then delete the file.`);
  }
}

interface OpenVault {
  client: CloudClient;
  key: Uint8Array;
  keyId: string;
}

/**
 * The vault key, checked against the account's. `create`: make the vault when the account has none
 * (`0b vault create`, `0b history mode e2e`): a new key here, its id recorded on the server, and the
 * recovery key shown once. Throws with what to do when this device can't open the account's vault.
 */
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
    state = { keyId: r.keyId };
    saveVaultCache(ctx, state);
    console.log(`${c.green("✓")} created your vault key. It stays on your machines; 0bridge stores only its id.`);
    showRecoveryKey(ctx, key, "shown once");
  }
  if (!key) throw new Error("this machine doesn't have your vault key yet. Run `0b vault unlock` and approve it in your browser with your passkey");
  const keyId = vaultKeyId(key);
  if (keyId !== state.keyId) throw new Error("this machine has a different vault key than your account. Run `0b vault unlock` with your recovery key");
  return { client, key, keyId };
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
 * picks up the same one instead of asking again.
 */
export async function requestUnlock(ctx: Context, opts: { waitMs: number; quiet?: boolean; browser?: boolean }): Promise<UnlockResult> {
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
      say(`${c.green("✓")} this machine can open your vault now.`);
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
  say(c.dim(`Approve it in your browser (passkey), or run ${"0b vault approve"} on a machine that has the vault.`));
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
      if (!state.keyId) return console.log(`No vault yet. ${c.cyan("0b vault create")} makes one (${c.cyan("0b history mode e2e")} does too).`);
      const ok = key && vaultKeyId(key) === state.keyId;
      console.log(`Vault ${c.dim(state.keyId)}`);
      console.log(ok ? `${c.green("✓")} this machine can open it` : c.yellow(`✗ this machine can't open it: run ${c.cyan("0b vault unlock")} and approve it in your browser`));
      return;
    }
    case "create":
      return create(ctx);
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
      fail(`unknown subcommand "vault ${sub}". Try: status, create, unlock, approve, recovery-key`);
  }
}

/** `0b vault create`: the vault key for an account that has none (before D86 the first `0b secret set` made it). */
async function create(ctx: Context): Promise<void> {
  const { client } = cloudClient(ctx);
  const { state } = await fetchVault(ctx, client);
  if (state.keyId) {
    const key = localKey(ctx);
    return console.log(
      key && vaultKeyId(key) === state.keyId
        ? `${c.green("✓")} you have a vault already, and this machine can open it.`
        : `You have a vault already. To open it on this machine: ${c.cyan("0b vault unlock")}`,
    );
  }
  try {
    await openVault(ctx, { create: true });
  } catch (e) {
    fail((e as Error).message);
  }
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
  if (!state.keyId) fail("your account has no vault yet; `0b vault create` makes one");
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
    // The same request as an earlier `requestUnlock` made, if one is still open.
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
  console.log(`${c.green("✓")} this machine can open your vault now.`);
}

/**
 * After `0b login` (T-039): the vault key its approval sealed to this machine's key pair, if one
 * came with it. `ctx` is the account that just signed in. Says whether this machine can open the
 * vault now; quiet when the account has no vault.
 */
export async function receiveLoginKey(ctx: Context, deviceCode: string, pair: { privateKey: CryptoKey; publicKey: string }): Promise<void> {
  const { client } = cloudClient(ctx);
  const { state } = await fetchVault(ctx, client);
  if (!state.keyId) return;
  const have = localKey(ctx);
  if (have && vaultKeyId(have) === state.keyId) return;
  const take = () =>
    client.loginKey(deviceCode).catch((e) => {
      if (e instanceof CloudError && e.status === 404) return null;
      throw e;
    });
  let sealed = await take();
  // The approval saves it before it approves; a slow write may still land just after the poll.
  for (let i = 0; !sealed && i < 2; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    sealed = await take();
  }
  let key: Uint8Array | null = null;
  if (sealed) {
    try {
      key = await openFromApprover(pair.privateKey, pair.publicKey, sealed.ephemeralPub, sealed.ct);
    } catch {
      key = null;
    }
  }
  // Only the key id is checked. This used to also open one of the vault's values with the key, so a
  // server that sealed a key of its own here (and reported its id) was caught; the vault keeps no
  // values since D86 (GET /api/vault answers { keyId, items: [] }), so there is nothing to open.
  if (key && vaultKeyId(key) === state.keyId) {
    saveLocalKey(ctx, key);
    dropPending(ctx);
    console.log(`${c.green("✓")} this machine can open your vault too.`);
    return;
  }
  console.log(c.dim(`This machine can't open your vault yet: run ${"0b vault unlock"} and approve it in your browser.`));
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
