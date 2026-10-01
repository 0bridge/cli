import type { HistoryMessage, HistorySession } from "./history.ts";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { Context, McpServer } from "./types.ts";
import { readJson, writeAtomic } from "./util.ts";
import { secretRef } from "./secrets.ts";
import type { VaultState } from "./vault.ts";

export const DEFAULT_SERVER = "https://0bridge.dev";
/** Secret-store key of this device's gateway token. */
export const DEVICE_TOKEN = "cloud.device-token";
/** Manifest name of the gateway entry written into every tool. */
export const GATEWAY_NAME = "0bridge";

export { API_CONNECTORS, DIRECT_ONLY, PRESETS } from "./presets.ts";
export { APP_SETUP, appSetupFor, type AppSetup } from "./apps.ts";

export interface RemoteFile {
  repo: string;
  path: string;
  version: number;
  kind: "file" | "symlink";
  ct: string | null;
  hash: string;
  size: number;
  device: string | null;
  at: number;
}
export interface HistoryStats {
  mode: "server" | "e2e";
  sessions: number;
  messages: number;
  bytes: number;
  tools: Record<string, number>;
}
export interface HistoryFilter {
  repo?: string;
  tool?: string;
  since?: number;
  limit?: number;
}
export interface HistorySessionMeta {
  id: string;
  tool: string;
  device: string | null;
  cwd: string | null;
  repo: string | null;
  title: string | null;
  startedAt: number;
  updatedAt: number;
  messages: number;
  enc: boolean;
}
export interface HistoryHit {
  session: HistorySessionMeta;
  seq: number;
  role: string;
  at: number;
  snippet: string;
}
const historyQuery = (f: HistoryFilter & { q?: string }) =>
  new URLSearchParams(Object.entries(f).flatMap(([k, v]) => (v === undefined || v === "" ? [] : [[k, String(v)]]))).toString();

export interface CloudConfig {
  server: string;
  userId: string;
  login: string;
  tokenId: string | null;
  /** Missing on sign-ins from older versions. */
  email?: string | null;
}

/**
 * A 0bridge account signed in on this machine. Several can be at once, like a company's and
 * your own: AI tools get one 0bridge entry, for the default account, and a checkout linked to a
 * project (`0b project link`) uses the account the project belongs to.
 */
export interface CloudAccount extends CloudConfig {
  /**
   * Suffix of this account's keys in the secret store (device token, vault key) and of its vault
   * copy: "" for one account (the names versions before several accounts used), "@<userId>" for the others.
   */
  slot: string;
}

export interface CloudAccounts {
  /** User id of the account AI tools use, and commands outside a linked checkout. */
  default: string | null;
  accounts: CloudAccount[];
}

const cloudPath = (ctx: Context) => join(ctx.storeDir, "cloud.json");
const accountsPath = (ctx: Context) => join(ctx.storeDir, "accounts.json");

/** Every account signed in here. A single sign-in from before several accounts (cloud.json) becomes the first. */
export function loadAccounts(ctx: Context): CloudAccounts {
  const all = readJson<CloudAccounts>(accountsPath(ctx));
  if (all) return all;
  const legacy = readJson<CloudConfig>(cloudPath(ctx));
  return legacy ? { default: legacy.userId, accounts: [{ ...legacy, slot: "" }] } : { default: null, accounts: [] };
}

export function saveAccounts(ctx: Context, all: CloudAccounts): void {
  writeAtomic(accountsPath(ctx), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  // cloud.json keeps describing the account in the unsuffixed slot, the one older versions read.
  const plain = all.accounts.find((a) => a.slot === "");
  if (plain) {
    const { slot: _, ...cfg } = plain;
    writeAtomic(cloudPath(ctx), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  } else rmSync(cloudPath(ctx), { force: true });
}

/** An account by email, name or user id (case doesn't matter). */
export function findAccount(all: CloudAccounts, who: string): CloudAccount | null {
  const w = who.trim().toLowerCase();
  return all.accounts.find((a) => a.userId === who || a.email?.toLowerCase() === w || a.login.toLowerCase() === w) ?? null;
}

export const defaultAccount = (all: CloudAccounts): CloudAccount | null => all.accounts.find((a) => a.userId === all.default) ?? all.accounts[0] ?? null;

/** What to call an account in messages: its email, else its name. */
export const accountName = (a: Pick<CloudConfig, "email" | "login">): string => a.email || a.login;

/** The account a command uses: `ctx.account` if set (it has to be signed in), else the default. */
export function loadCloud(ctx: Context): CloudAccount | null {
  const all = loadAccounts(ctx);
  if (!ctx.account) return defaultAccount(all);
  const a = findAccount(all, ctx.account);
  if (!a) throw new Error(`${ctx.account} isn't signed in on this machine. Run \`0b login\` to add it (\`0b account\` lists who is).`);
  return a;
}

/** Secret-store name of an account's device token. */
export const deviceTokenKey = (a: Pick<CloudAccount, "slot">): string => DEVICE_TOKEN + a.slot;

/** The slot (see CloudAccount) of the account this context uses; "" when nobody is signed in. */
export function accountSlot(ctx: Context): string {
  try {
    return loadCloud(ctx)?.slot ?? "";
  } catch {
    return "";
  }
}

/**
 * Record a sign-in: updates the account if it's already here, else adds it (the first account
 * becomes the default). Returns the account, with the slot its keys go in.
 */
export function saveCloud(ctx: Context, c: CloudConfig): CloudAccount {
  const all = loadAccounts(ctx);
  const known = all.accounts.find((a) => a.userId === c.userId);
  const account: CloudAccount = { ...c, email: c.email ?? known?.email ?? null, slot: known?.slot ?? (all.accounts.some((a) => a.slot === "") ? `@${c.userId}` : "") };
  all.accounts = known ? all.accounts.map((a) => (a.userId === c.userId ? account : a)) : [...all.accounts, account];
  if (!all.default || !all.accounts.some((a) => a.userId === all.default)) all.default = c.userId;
  saveAccounts(ctx, all);
  return account;
}

/** Forget an account (the one this context uses, unless given); the next one becomes the default. Returns what's left. */
export function clearCloud(ctx: Context, userId = loadCloud(ctx)?.userId): CloudAccounts {
  const all = loadAccounts(ctx);
  all.accounts = all.accounts.filter((a) => a.userId !== userId);
  if (all.default === userId) all.default = all.accounts[0]?.userId ?? null;
  if (all.accounts.length) saveAccounts(ctx, all);
  else {
    rmSync(accountsPath(ctx), { force: true });
    rmSync(cloudPath(ctx), { force: true });
  }
  return all;
}

/** The gateway entry every tool gets, with the device token of the account in `slot` (the default one's). */
export function gatewayEntry(server: string, slot = ""): McpServer {
  return { transport: "http", url: `${server.replace(/\/+$/, "")}/mcp`, headers: { Authorization: `Bearer ${secretRef(deviceTokenKey({ slot }))}` } };
}

export interface CloudConnection {
  /** Stable internal id. */
  id: string;
  /** "mcp" (a remote MCP server) or "api" (an HTTP API the gateway calls with your key or sign-in). Missing from older servers: mcp. */
  kind?: "mcp" | "api";
  /** Service name, the first part of every tool name (linear). */
  service: string;
  /** Account label within the service (acme), or null for a single account. */
  label: string | null;
  /** "linear" or "linear › acme". */
  display: string;
  /** Tool-name prefix: `linear` or `linear__acme`. */
  prefix: string;
  url: string;
  state: string;
  authUrl: string | null;
  error: string | null;
  tools: number;
  /** Project ids it's limited to; empty (or missing, from older servers) for everywhere. */
  projects?: string[];
  /** Projects an everywhere connection is hidden in. */
  hidden?: string[];
  /** An API with a key: what to type in, one name per key (state "needs_key" until then). */
  keys?: string[];
  /** An API connected from its OpenAPI document. */
  openapi?: { url: string; ops: number; write: boolean };
}

/** How to connect a service (the gateway's discover.ts): polished, MCP, OpenAPI. */
export type Candidate =
  | { kind: "preset"; service: string; title: string; auth: string; keys?: string[] }
  | { kind: "mcp"; service: string; title: string; url: string; source: "0bridge" | "registry" | "probe"; official?: boolean; description?: string }
  | { kind: "openapi"; service: string; title: string; specUrl: string; source: "url" | "probe" | "apis.guru"; description?: string };
export interface Discovery {
  query: string;
  service: string;
  best: Candidate | null;
  candidates: Candidate[];
}

/** A repo or named project (projects.ts on the gateway). */
export interface CloudProject {
  id: string;
  repo: string;
  /** Agents in it see only its own connections. */
  strict: boolean;
  createdAt: number;
}

export interface CloudProjects {
  projects: (CloudProject & { secrets: number; connections: string[] })[];
  connections: { id: string; display: string; projects: string[]; hidden?: string[] }[];
  /** Repos with secrets, personal files or conversations that aren't projects yet. */
  suggestions: string[];
}

type Named = { id: string; service: string; label: string | null; display: string; prefix: string };
export type LabelConflict = { state: "conflict"; error: string; suggestion: string };
/** The service takes no self-registered apps: connect again with an OAuth app the user registered (see apps.ts). */
export type NeedsApp = { state: "needs_app"; error: string };
/** An OAuth app registered with the service ahead of time, for services without dynamic client registration. */
export type OAuthClient = { clientId: string; clientSecret?: string };
type ApiExtras = { openapi?: { title: string; ops: number; write: boolean }; keyUrl?: string };
export type ConnectResult =
  | (Named & ApiExtras & { state: "ready" })
  | (Named & ApiExtras & { state: "authenticating"; authUrl: string })
  | (Named & ApiExtras & { state: "needs_key"; keys: string[] })
  | LabelConflict
  | NeedsApp;

export class CloudError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The server's machine-readable reason, e.g. APPROVAL_REQUIRED. */
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Thin client for the gateway's /api. */
/** Network errors where the request never reached the server, so sending it again is safe. */
const NOT_SENT = new Set(["ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * A request, tried again when the network drops it (a flaky connection's "fetch failed"): up to
 * three times, and for anything but a GET only when it can't have reached the server.
 */
async function retrying(send: () => Promise<Response>, idempotent: boolean, server: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code ?? "";
      const again = attempt < 3 && (NOT_SENT.has(code) || (idempotent && (code === "ECONNRESET" || code === "UND_ERR_SOCKET")));
      if (!again) throw new CloudError(`couldn't reach ${server.replace(/^https?:\/\//, "")}${code ? ` (${code})` : ""}: check the connection and try again`, 0);
      await new Promise((r) => setTimeout(r, attempt * 700));
    }
  }
}

export class CloudClient {
  constructor(
    readonly server: string,
    private token: string,
  ) {}

  private async req<T>(path: string, init: RequestInit = {}, allow: number[] = []): Promise<T> {
    const res = await retrying(() =>
      fetch(`${this.server}/api${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      }),
      (init.method ?? "GET") === "GET",
      this.server,
    );
    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok && !allow.includes(res.status)) throw new CloudError(body.error ?? `${res.status} ${res.statusText}`, res.status, body.code);
    return body as T;
  }

  me() {
    return this.req<{ userId: string; login: string; email?: string | null; tokenId: string | null; mcpUrl: string }>("/me");
  }
  createToken(label: string) {
    return this.req<{ id: string; token: string }>("/tokens", { method: "POST", body: JSON.stringify({ label }) });
  }
  deleteToken(id: string) {
    return this.req<void>(`/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  connections() {
    return this.req<CloudConnection[]>("/connections");
  }
  /** Where a connection can be used (scope.ts); `hidden` left out keeps it as it is. */
  setConnectionProjects(id: string, projects: string[], hidden?: string[]) {
    return this.req<{ display: string; projects: string[]; hidden: string[] }>(`/connections/${encodeURIComponent(id)}/projects`, { method: "PUT", body: JSON.stringify({ projects, ...(hidden ? { hidden } : {}) }) });
  }
  // ── Clipboard relay ──
  /** Send something for an agent to read once (bridge__clipboard), within 10 minutes. */
  sendClip(item: { name: string; mime: string; data: string; from?: string; sync?: boolean }) {
    return this.req<{ id: string; name: string; mime: string; size: number; at: number }>("/clip", { method: "POST", body: JSON.stringify(item) });
  }
  clipsWaiting() {
    return this.req<{ id: string; name: string; mime: string; size: number; at: number; from?: string }[]>("/clip");
  }
  clearClips() {
    return this.req<{ deleted: number }>("/clip", { method: "DELETE" });
  }
  /** Take what's waiting (each item once, like an agent's read), with its data in base64. */
  takeClips() {
    return this.req<{ id: string; name: string; mime: string; size: number; at: number; from?: string; data: string }[]>("/clip/take", { method: "POST" });
  }
  // ── Projects ──
  /** With `suggest`, also repos you work in that aren't projects yet (slower). */
  projects(suggest = false) {
    return this.req<CloudProjects>(suggest ? "/projects?suggest=1" : "/projects");
  }
  /** Create it, or get the existing one for this repo. */
  createProject(repo: string, strict?: boolean) {
    return this.req<CloudProject>("/projects", { method: "POST", body: JSON.stringify({ repo, strict }) });
  }
  updateProject(id: string, strict: boolean) {
    return this.req<CloudProject>(`/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ strict }) });
  }
  deleteProject(id: string) {
    return this.req<{ deleted: string; orphaned: string[] }>(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  /** A token for the project's MCP endpoint only, and that endpoint's URL. */
  projectToken(id: string, label: string) {
    return this.req<{ id: string; token: string; url: string }>(`/projects/${encodeURIComponent(id)}/token`, { method: "POST", body: JSON.stringify({ label }) });
  }
  // ── Personal files kept out of git ──
  files(repo?: string) {
    return this.req<RemoteFile[]>(`/files${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`);
  }
  fileVersions(repo: string, path: string) {
    return this.req<(Omit<RemoteFile, "ct"> & { deleted: boolean })[]>(`/files/versions?${new URLSearchParams({ repo, path })}`);
  }
  fileVersion(repo: string, path: string, version: number) {
    return this.req<RemoteFile>(`/files/version?${new URLSearchParams({ repo, path, version: String(version) })}`);
  }
  /** A 409 comes back as `{ code: "CONFLICT", latest }`: another machine changed the file since `base`. */
  putFile(f: { repo: string; path: string; kind: "file" | "symlink"; ct: string | null; hash: string; size: number; device: string; base: number }) {
    return this.req<{ ok: true; version: number } | { code: "CONFLICT"; error: string; latest: RemoteFile }>("/files", { method: "PUT", body: JSON.stringify(f) }, [409]);
  }
  purgeFiles(repo?: string, path?: string) {
    return this.req<{ deleted: number }>(`/files?${new URLSearchParams({ ...(repo ? { repo } : {}), ...(path ? { path } : {}) })}`, { method: "DELETE" });
  }
  // ── Conversation history ──
  historyStats() {
    return this.req<HistoryStats>("/history");
  }
  setHistoryMode(mode: "server" | "e2e") {
    return this.req<{ mode: string }>("/history/mode", { method: "PUT", body: JSON.stringify({ mode }) });
  }
  uploadHistory(sessions: (Omit<HistorySession, "messages"> & { enc: boolean; messages: HistoryMessage[] })[]) {
    return this.req<{ sessions: number; messages: number }>("/history/sessions", { method: "POST", body: JSON.stringify({ sessions }) });
  }
  historySearch(q: string, f: HistoryFilter = {}) {
    return this.req<HistoryHit[]>(`/history/search?${historyQuery({ q, ...f })}`);
  }
  historySessions(f: HistoryFilter = {}) {
    return this.req<HistorySessionMeta[]>(`/history/sessions?${historyQuery(f)}`);
  }
  historySession(id: string, from = 0, limit = 200) {
    return this.req<{ session: HistorySessionMeta; messages: HistoryMessage[] }>(`/history/sessions/${encodeURIComponent(id)}?from=${from}&limit=${limit}`);
  }
  forgetHistory(id?: string) {
    return this.req<{ deleted: number }>(id ? `/history/sessions/${encodeURIComponent(id)}` : "/history", { method: "DELETE" });
  }
  /** A name clash comes back as `{ state: "conflict", suggestion }`, never replacing the existing connection. */
  /** `hosted`: sign in with 0bridge's own app for the service (Slack), even before it's the default. */
  connect(service: string, label: string | undefined, url: string, headers?: Record<string, string>, oauthClient?: OAuthClient, hosted?: boolean) {
    return this.req<ConnectResult>("/connections", { method: "POST", body: JSON.stringify({ service, label, url, headers, oauthClient, ...(hosted ? { hosted: true } : {}) }) }, [409, 422]);
  }
  /**
   * A connection of kind "api": a known connector (`preset`, e.g. google-calendar), or any HTTP API by
   * base URL, auth style and key. The key goes to the gateway (sealed there), never to agents.
   */
  connectApi(body: { service?: string; label?: string; preset?: string; spec?: string; baseUrl?: string; auth?: { type: "bearer" | "basic" | "header" | "query"; name?: string }; key?: string; allowWrite?: boolean }) {
    return this.req<ConnectResult>("/connections", { method: "POST", body: JSON.stringify({ kind: "api", ...body }) }, [409]);
  }
  /** How to connect a service from its name or an address. */
  discover(q: string) {
    return this.req<Discovery>(`/connectors/discover?q=${encodeURIComponent(q)}`);
  }
  /** Give an API connection its key; several keys one per line. */
  setKey(id: string, key: string) {
    return this.req<{ ok: true; display: string }>(`/connections/${encodeURIComponent(id)}/key`, { method: "PUT", body: JSON.stringify({ key }) });
  }
  /** Let an OpenAPI connection change data, or stop it. */
  setWrite(id: string, write: boolean) {
    return this.req<{ ok: true; display: string; write: boolean }>(`/connections/${encodeURIComponent(id)}/write`, { method: "PUT", body: JSON.stringify({ write }) });
  }
  /** Whether a new connection to `service` needs an account label (it's already connected), and a free one. */
  suggestLabel(service: string) {
    return this.req<{ label: string; needed: boolean }>(`/connections/suggest?service=${encodeURIComponent(service)}`);
  }
  /** Set the account label; "" clears it. */
  rename(id: string, label: string) {
    return this.req<Named | LabelConflict>(
      `/connections/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify({ label }) },
      [409],
    );
  }
  disconnect(id: string) {
    return this.req<void>(`/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  /** The vault's key id and every ciphertext. */
  vault() {
    return this.req<VaultState>("/vault");
  }
  /** Record the key a new vault is encrypted with. 409 (with the existing keyId) if there's already one. */
  createVault(keyId: string) {
    return this.req<{ keyId: string; error?: string }>("/vault", { method: "POST", body: JSON.stringify({ keyId }) }, [409]);
  }
  putSecret(keyId: string, item: { scope: string; env: string; name: string; ct: string; kind?: "secret" | "variable"; note?: string | null; enabled?: boolean }) {
    return this.req<void>("/vault/items", { method: "PUT", body: JSON.stringify({ keyId, ...item }) });
  }
  /** Several puts, patches and deletes in one request, all or nothing. */
  vaultBatch(keyId: string | null, ops: ({ op: "put"; scope: string; env: string; name: string; ct: string; kind?: "secret" | "variable"; note?: string | null } | { op: "delete"; scope: string; env: string; name: string })[]) {
    return this.req<{ applied: number }>("/vault/batch", { method: "POST", body: JSON.stringify({ keyId, ops }) });
  }
  /** Switch a value on or off, change its kind, or set its (sealed) note, without the value. 404 when there's no such value. */
  patchSecret(item: { scope: string; env: string; name: string; kind?: "secret" | "variable"; note?: string | null; enabled?: boolean }) {
    return this.req<{ error?: string } | undefined>("/vault/items", { method: "PATCH", body: JSON.stringify(item) }, [404]);
  }
  /** Ask the user (in the browser) to let this device use a protected env for a while. */
  requestGrant(scope: string, env: string, reason?: string) {
    return this.req<{ id: string; code: string; url: string; expiresAt: number }>("/vault/grants", { method: "POST", body: JSON.stringify({ scope, env, reason }) });
  }
  grant(id: string) {
    return this.req<{ status: "pending" | "approved" | "denied" | "expired"; until: number | null }>(`/vault/grants/${encodeURIComponent(id)}`);
  }
  /** A new machine asks for the vault key, sending the public key it should be encrypted to. */
  requestPairing(devicePub: string) {
    return this.req<{ id: string; url: string; expiresAt: number }>("/vault/pairings", { method: "POST", body: JSON.stringify({ devicePub }) });
  }
  pairing(id: string) {
    return this.req<{ status: "pending" | "approved" | "denied" | "expired" | "delivered"; ephemeralPub?: string; ct?: string }>(`/vault/pairings/${encodeURIComponent(id)}`);
  }
  /** Open requests from other machines, for `0b vault approve`. */
  pairings() {
    return this.req<{ id: string; devicePub: string; device: string | null; createdAt: number }[]>("/vault/pairings");
  }
  decidePairing(id: string, sealed: { ephemeralPub: string; ct: string } | null) {
    return this.req<void>(`/vault/pairings/${encodeURIComponent(id)}/${sealed ? "approve" : "deny"}`, { method: "POST", body: JSON.stringify(sealed ?? {}) });
  }
  deleteSecret(item: { scope: string; env: string; name: string }) {
    return this.req<{ error?: string } | undefined>(`/vault/items?${new URLSearchParams(item)}`, { method: "DELETE" }, [404]);
  }
}
