import * as p from "@clack/prompts";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getAdapters,
  BRIDGE_SKILL,
  SECRETS_SKILL,
  CloudClient,
  CloudError,
  DEFAULT_SERVER,
  API_CONNECTORS,
  CLIS,
  DIRECT_ONLY,
  PROFILE_NAME,
  loadProfiles,
  GATEWAY_NAME,
  PRESETS,
  appSetupFor,
  accountName,
  clearCloud,
  defaultAccount,
  deviceTokenKey,
  emptyManifest,
  findAccount,
  loadAccounts,
  saveAccounts,
  executePlan,
  gatewayEntry,
  loadManifest,
  loadCloud,
  loadState,
  openSecretStore,
  paths,
  planApply,
  readText,
  requireManifest,
  resolveServer,
  saveCloud,
  saveManifest,
  writeAtomic,
  type CloudAccount,
  type AppSetup,
  type CloudConnection,
  type Manifest,
  type OAuthClient,
  type Context,
} from "@0bridge/core";
import { searchRegistry, withRegistry } from "@0bridge/core/mcp-registry";
import { c, canOpenBrowser, planSummary, spinner, where } from "./ui.ts";
import { loginInto } from "./profile.ts";
import { unlinkAccount } from "./project.ts";

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");

/**
 * The `0bridge` skill (add MCPs and services through `0b`) and `0bridge-secrets` (use the vault
 * through `0b exec`), for every tool's agent. Kept current on each sign-in.
 */
export function installBridgeSkill(ctx: Context, m: Manifest): void {
  for (const [name, text] of [
    ["0bridge", BRIDGE_SKILL],
    ["0bridge-secrets", SECRETS_SKILL],
  ] as const) {
    const file = join(paths(ctx).skills, name, "SKILL.md");
    if (readText(file) !== text) writeAtomic(file, text);
    m.skills[name] ??= {};
  }
}

/**
 * After an update of 0b: bring the 0bridge skills up to date, in 0bridge's store and in each AI
 * tool that has them (the background sync runs this). Only those two skills are touched.
 */
export function refreshBridgeSkills(ctx: Context): number {
  let changed = 0;
  for (const [name, text] of [
    ["0bridge", BRIDGE_SKILL],
    ["0bridge-secrets", SECRETS_SKILL],
  ] as const) {
    const files = [join(paths(ctx).skills, name, "SKILL.md"), ...Object.values(getAdapters(ctx)).flatMap((a) => (a.skillsDir && existsSync(join(a.skillsDir, name)) ? [join(a.skillsDir, name, "SKILL.md")] : []))];
    for (const file of files)
      if (existsSync(dirname(file)) && readText(file) !== text) {
        writeAtomic(file, text);
        changed++;
      }
  }
  return changed;
}

/** Open a URL in the user's browser. `$BROWSER` overrides (also used by tests). */
export function openBrowser(url: string): void {
  const [cmd, args] = process.env.BROWSER
    ? [process.env.BROWSER, [url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {}
}

export function cloudClient(ctx: Context): { cfg: CloudAccount; client: CloudClient } {
  const cfg = loadCloud(ctx);
  const token = cfg && openSecretStore(ctx.storeDir).get(deviceTokenKey(cfg));
  if (!cfg || !token) throw new Error("Not signed in. Run `0b login` first.");
  return { cfg, client: new CloudClient(cfg.server, token) };
}

/**
 * Sign in like any OAuth native app: dynamic registration, PKCE, loopback redirect.
 * The short-lived OAuth token is only used to mint this device's gateway token.
 */
async function oauthSignIn(server: string): Promise<string> {
  const meta = (await (await fetch(`${server}/.well-known/oauth-authorization-server`)).json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
  };

  let resolveCode!: (code: string) => void;
  let rejectCode!: (e: Error) => void;
  const codePromise = new Promise<string>((res, rej) => ((resolveCode = res), (rejectCode = rej)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const http = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") return void res.writeHead(404).end();
    const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
    res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>0bridge</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh">` +
        (ok ? "<p>Signed in to 0bridge. You can close this tab and return to the terminal.</p>" : "<p>Sign-in failed. Return to the terminal.</p>"),
    );
    if (ok) resolveCode(u.searchParams.get("code")!);
    else rejectCode(new Error(u.searchParams.get("error_description") ?? u.searchParams.get("error") ?? "sign-in failed"));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as { port: number }).port;
  const redirect = `http://127.0.0.1:${port}/callback`;

  try {
    const reg = await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: `0bridge CLI (${hostname()})`, redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    });
    if (!reg.ok) throw new Error(`client registration failed: ${reg.status}`);
    const { client_id } = (await reg.json()) as { client_id: string };

    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const auth = new URL(meta.authorization_endpoint);
    auth.search = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "openid profile email offline_access",
      resource: `${server}/mcp`,
    }).toString();

    p.log.info(`Opening your browser to sign in.\n${c.dim(`If it doesn't open: ${auth.href}`)}`);
    openBrowser(auth.href);
    const timeout = setTimeout(() => rejectCode(new Error("timed out waiting for sign-in")), 5 * 60_000);
    const code = await codePromise.finally(() => clearTimeout(timeout));

    const tok = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id, code_verifier: verifier }),
    });
    const body = (await tok.json()) as { access_token?: string; error_description?: string };
    if (!body.access_token) throw new Error(body.error_description ?? "token exchange failed");
    return body.access_token;
  } finally {
    http.close();
  }
}

const CLI_CLIENT_ID = "0b-cli";

/**
 * Device authorization grant (RFC 8628), like `gh auth login`: works on this machine, over SSH,
 * in containers — approve from any browser, even a phone. Returns a short-lived session token.
 */
async function deviceSignIn(server: string): Promise<string> {
  const res = await fetch(`${server}/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLI_CLIENT_ID }),
  });
  if (!res.ok) throw new Error(`could not start sign-in (${res.status})`);
  const dc = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; interval?: number };
  const code = dc.user_code.length === 8 ? `${dc.user_code.slice(0, 4)}-${dc.user_code.slice(4)}` : dc.user_code;
  const verifyUrl = new URL(dc.verification_uri, server).href;
  const completeUrl = new URL(dc.verification_uri_complete, server).href;

  p.note(`${c.bold(code)}\n\n${c.dim("Approve at")} ${c.cyan(verifyUrl)}`, "Your one-time code");
  if (canOpenBrowser()) {
    openBrowser(completeUrl);
    p.log.info(`Opened your browser. ${c.dim("Check the code matches, then approve.")}`);
  } else {
    p.log.info("Open the link on any device (your laptop or phone) and enter the code.");
  }

  const spin = spinner();
  spin.start("Waiting for approval");
  let interval = (dc.interval ?? 5) * 1000;
  const deadline = Date.now() + 10 * 60_000;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      const t = await fetch(`${server}/auth/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dc.device_code, client_id: CLI_CLIENT_ID }),
      });
      const body = (await t.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
      if (body.access_token) {
        spin.stop("Approved");
        return body.access_token;
      }
      if (body.error === "authorization_pending") continue;
      if (body.error === "slow_down") {
        interval += 5000;
        continue;
      }
      throw new Error(body.error === "access_denied" ? "sign-in was denied" : body.error === "expired_token" ? "the code expired — run `0b login` again" : (body.error_description ?? `sign-in failed (${t.status})`));
    }
    throw new Error("the code expired — run `0b login` again");
  } catch (e) {
    spin.error("Sign-in failed");
    throw e;
  }
}

export async function login(ctx: Context, server = process.env.ZEROBRIDGE_SERVER ?? DEFAULT_SERVER, opts: { web?: boolean; embedded?: boolean } = {}): Promise<void> {
  server = server.replace(/\/+$/, "");
  if (!opts.embedded) p.intro(c.bold(" 0bridge login "));
  const before = loadAccounts(ctx);
  // Already signed in: this adds an account (or signs one in again). The browser shows which
  // account it approves with, and switches or adds one right there (D42).
  const current = defaultAccount(before);
  if (current && !opts.embedded)
    p.log.info(`Signed in as ${c.bold(accountName(current))}${before.accounts.length > 1 ? ` and ${before.accounts.length - 1} more` : ""}. Signing in with another account adds it; pick the account in the browser.`);
  // Either flow yields a short-lived credential that is used once, to mint this device's long-lived token.
  const bootstrap = opts.web ? await oauthSignIn(server) : await deviceSignIn(server);
  const spin = spinner();
  spin.start("Creating a token for this device");
  const { token } = await new CloudClient(server, bootstrap).createToken(`${hostname()} · 0b CLI`);
  if (!opts.web) {
    // Drop the web session the device flow created; the device token replaces it.
    await fetch(`${server}/auth/sign-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bootstrap}`, Origin: server, "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
  }
  const store = openSecretStore(ctx.storeDir);
  const me = await new CloudClient(server, token).me();
  // The same account again: its old token on this device is replaced, so revoke it.
  const known = before.accounts.find((a) => a.userId === me.userId);
  const old = known && store.get(deviceTokenKey(known));
  if (known?.tokenId && old && known.tokenId !== me.tokenId) await new CloudClient(known.server, old).deleteToken(known.tokenId).catch(() => {});
  const account = saveCloud(ctx, { server, userId: me.userId, login: me.login, email: me.email ?? null, tokenId: me.tokenId });
  store.set(deviceTokenKey(account), token);
  const main = defaultAccount(loadAccounts(ctx))!;

  // One entry that every tool gets: the gateway, authenticated with the default account's device token.
  // Signing in before `0b init` is fine: start an empty manifest.
  mkdirSync(ctx.storeDir, { recursive: true, mode: 0o700 });
  const m = loadManifest(ctx) ?? emptyManifest();
  m.mcpServers[GATEWAY_NAME] = gatewayEntry(main.server, main.slot);
  installBridgeSkill(ctx, m);
  saveManifest(ctx, m);
  spin.stop(`Signed in as ${c.bold(me.login)} · device token saved to ${store.kind}`);
  if (main.userId === account.userId) p.log.info(`Every tool will reach your cloud connections through ${c.cyan(me.mcpUrl)}`);
  else {
    const name = accountName(account);
    p.log.info(
      `Added ${c.bold(name)}. Your AI tools keep using ${c.bold(accountName(main))} (the default).\n` +
        `${c.dim(`A repo for ${name}: run this in it, and its agents and 0b commands there use ${name}:`)} ${c.cyan(`0b project link --account ${name}`)}\n` +
        `${c.dim("Make it the default:")} ${c.cyan(`0b account use ${name}`)}`,
    );
  }
}

/**
 * Sign out: revoke this device's token for the account and forget it here. With several accounts
 * signed in, say which (or --all). Checkouts linked to its projects go back to the global endpoint.
 */
export async function logout(ctx: Context, who?: string, opts: { all?: boolean } = {}): Promise<void> {
  const all = loadAccounts(ctx);
  if (!all.accounts.length) return console.log(c.dim("Not signed in."));
  const names = all.accounts.map(accountName).join(", ");
  let targets = all.accounts;
  if (who) {
    const a = findAccount(all, who);
    if (!a) throw new Error(`${who} isn't signed in here (signed in: ${names})`);
    targets = [a];
  } else if (!opts.all && all.accounts.length > 1) throw new Error(`signed in to ${all.accounts.length} accounts (${names}). Say which: 0b logout <email>, or 0b logout --all`);
  const store = openSecretStore(ctx.storeDir);
  const wasDefault = defaultAccount(all)!.userId;
  for (const a of targets) {
    const token = store.get(deviceTokenKey(a));
    const client = token ? new CloudClient(a.server, token) : null;
    const unlinked = await unlinkAccount(ctx, a.userId, client);
    if (client && a.tokenId) await client.deleteToken(a.tokenId).catch(() => {});
    store.delete(deviceTokenKey(a));
    clearCloud(ctx, a.userId);
    console.log(`${c.green("✓")} Signed out of ${c.bold(accountName(a))}; this device's token is revoked.${unlinked.length ? c.dim(` ${unlinked.length} linked checkout(s) use the global endpoint again.`) : ""}`);
  }
  const main = defaultAccount(loadAccounts(ctx));
  const m = loadManifest(ctx);
  if (m) {
    if (main) m.mcpServers[GATEWAY_NAME] = gatewayEntry(main.server, main.slot);
    else delete m.mcpServers[GATEWAY_NAME];
    saveManifest(ctx, m);
  }
  if (!main) console.log(`Run ${c.cyan("0b apply")} to remove the gateway from your tools.`);
  else if (main.userId !== wasDefault) console.log(`Your AI tools now use ${c.bold(accountName(main))}: run ${c.cyan("0b apply")} to update them.`);
}

/** Make an account the default, the one every AI tool's 0bridge entry uses. False if it already was. */
export function useAccount(ctx: Context, who: string): boolean {
  const all = loadAccounts(ctx);
  const a = findAccount(all, who);
  if (!a) throw new Error(`${who} isn't signed in here (${all.accounts.length ? `signed in: ${all.accounts.map(accountName).join(", ")}; ` : ""}add it with 0b login)`);
  if (all.default === a.userId) return false;
  saveAccounts(ctx, { ...all, default: a.userId });
  mkdirSync(ctx.storeDir, { recursive: true, mode: 0o700 });
  const m = loadManifest(ctx) ?? emptyManifest();
  m.mcpServers[GATEWAY_NAME] = gatewayEntry(a.server, a.slot);
  saveManifest(ctx, m);
  return true;
}

/** Connect one service in the cloud, walking the user through its sign-in if needed. */
/**
 * Account label for a new connection. Optional for a service's first account (Enter skips);
 * required once the service is already connected, with "2", "3", … suggested.
 * Non-interactive runs take the suggestion.
 */
export async function askLabel(ctx: Context, service: string, given?: string): Promise<string | undefined> {
  if (given !== undefined) return given.trim() || undefined;
  const s = await cloudClient(ctx).client.suggestLabel(service);
  if (!process.stdin.isTTY) return s.label || undefined;
  const v = await p.text({
    message: s.needed
      ? `${c.bold(service)} is already connected. Name this account ${c.dim("(e.g. the org or workspace)")}`
      : `Account label for ${c.bold(service)} ${c.dim("(optional, e.g. your org — Enter to skip)")}`,
    placeholder: s.needed ? s.label : "Enter to skip",
    defaultValue: s.needed ? s.label : "",
  });
  if (p.isCancel(v)) process.exit(0);
  return String(v).trim() || (s.needed ? s.label : undefined);
}
/** Connect one service in the cloud under `label`, walking the user through its sign-in if needed. */
export async function connectService(
  ctx: Context,
  service: string,
  label: string | undefined,
  url: string,
  headers?: Record<string, string>,
  log: (s: string) => void = (s) => p.log.info(s),
  oauthClient?: OAuthClient,
  hosted?: boolean,
): Promise<{ id: string; display: string; prefix: string }> {
  const { client } = cloudClient(ctx);
  const r = await client.connect(service, label, url, headers, oauthClient, hosted);
  if (r.state === "conflict") throw new CloudError(`${r.error} — try the label "${r.suggestion}"`, 409);
  if (r.state === "needs_app") {
    const setup = appSetupFor(url);
    if (oauthClient || !setup || !process.stdin.isTTY) throw new CloudError(`${r.error} (0b connect ${service} --client-id … --client-secret …)`, 422);
    return connectService(ctx, service, label, url, headers, log, await setUpApp(ctx, setup, log));
  }
  if (r.state === "ready") return r;
  if (r.state === "needs_key") throw new CloudError(`${r.display} needs a key: 0b key ${r.prefix}`, 400);
  log(`Opening ${c.bold(r.display)} sign-in in your browser.\n${c.dim(`If it doesn't open: ${r.authUrl}`)}`);
  openBrowser(r.authUrl);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 2000));
    const conn = (await client.connections()).find((x) => x.id === r.id);
    if (conn?.state === "ready") return r;
    if (conn?.state === "failed")
      throw new Error(
        hosted
          ? `${r.display}: ${setupName(url)} didn't accept 0bridge's app yet (it takes only Marketplace apps and a workspace's own). The install still counts toward the listing. To use it now: 0b disconnect ${service}${label ? ` --label ${label}` : ""} && 0b connect ${service}${label ? ` --label ${label}` : ""} --app own`
          : (conn.error ?? `${r.display} connection failed`),
      );
  }
  throw new Error(`timed out waiting for ${r.display} sign-in`);
}
/**
 * Walk the user through registering the OAuth app a service requires (Slack): open its
 * "create app" page with everything filled in, then ask for the credentials it shows.
 */
async function setUpApp(ctx: Context, setup: AppSetup, log: (s: string) => void): Promise<OAuthClient> {
  const { cfg } = cloudClient(ctx);
  const callbackUrl = `${cfg.server.replace(/\/+$/, "")}/upstream/callback/${cfg.userId}`;
  const meta = (await fetch(setup.scopesUrl).then((r) => r.json())) as { scopes_supported?: string[] };
  if (!meta.scopes_supported?.length) throw new Error(`couldn't read the scopes ${setup.name} asks for (${setup.scopesUrl})`);
  const url = setup.createUrl(callbackUrl, meta.scopes_supported);
  log(
    `${setup.name} only lets apps registered with it in, so 0bridge needs one in your workspace. It takes a minute:\n` +
      setup.steps(cfg.server.replace(/\/+$/, "")).map((s, i) => `  ${i + 1}. ${s}`).join("\n") +
      `\n${c.dim(`If the page doesn't open: ${url}`)}`,
  );
  openBrowser(url);
  const clientId = await p.text({ message: "Client ID", validate: (v) => (v?.trim() ? undefined : "required") });
  if (p.isCancel(clientId)) process.exit(0);
  const clientSecret = await p.password({ message: "Client Secret", validate: (v) => (v?.trim() ? undefined : "required") });
  if (p.isCancel(clientSecret)) process.exit(0);
  return { clientId: String(clientId).trim(), clientSecret: String(clientSecret).trim() };
}

export async function connectCommand(
  ctx: Context,
  service: string | undefined,
  urlArg: string | undefined,
  opts: { headers?: Record<string, string>; label?: string; clientId?: string; clientSecret?: string; api?: string; auth?: string; spec?: string; allowWrite?: boolean; yes?: boolean; app?: string } = {},
) {
  if (!service) {
    console.log(
      `usage: 0b connect <service> [url] [--label name]\n       0b connect <service> --api <base url> [--auth bearer|basic|header:<Name>|query:<param>]\n\nKnown services: ${[...Object.keys(PRESETS), ...Object.keys(API_CONNECTORS)].sort().join(", ")}`,
    );
    return;
  }
  if (opts.spec) return connectSpecCommand(ctx, service, opts.spec, opts);
  // In the user's own terminal with nothing decided on the command line: show every way in and let them pick.
  let url = urlArg;
  if (!opts.api && !urlArg && !opts.clientId && !opts.headers && !opts.yes && process.stdin.isTTY) {
    const way = await chooseWay(ctx, service);
    if (way.kind === "cli") return connectCli(ctx, way.cli, opts.label);
    if (way.kind === "preset") return connectApiCommand(ctx, way.service, opts);
    if (way.kind === "openapi") return connectSpecCommand(ctx, way.service, way.specUrl, opts);
    if (way.kind === "api") return connectApiCommand(ctx, way.service, { ...opts, api: way.baseUrl });
    url = way.url;
    service = way.service;
    // Picked the MCP server over 0bridge's app (listed above it): the workspace's own app, no second question.
    if (API_CONNECTORS[service.toLowerCase()] && appSetupFor(url)) opts = { ...opts, app: opts.app ?? "own" };
  }
  // A name that's both an MCP server and an API connector (slack) means the MCP server.
  if (opts.api || (API_CONNECTORS[service.toLowerCase()] && !PRESETS[service.toLowerCase()] && !url)) return connectApiCommand(ctx, service, opts);
  url ??= PRESETS[service.toLowerCase()];
  if (!url) {
    // Not one 0bridge knows by name: find its MCP server or its API document.
    // The MCP registry is slow to answer 0bridge's server, so ask it from here at the same time.
    const plain = /[./]/.test(service) ? "" : service.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    const [found, reg] = await Promise.all([cloudClient(ctx).client.discover(service), plain ? searchRegistry(service, plain, { timeoutMs: 10_000 }).catch(() => []) : Promise.resolve([])]);
    let d = withRegistry(found, reg);
    if (!plain) d = withRegistry(d, await searchRegistry(d.service, d.service, { timeoutMs: 6000 }).catch(() => []));
    const best = d.best;
    const others = d.candidates.filter((x) => x !== best);
    if (!best) {
      const theirs = d.candidates.filter((x) => x.kind === "mcp");
      throw new Error(
        theirs.length
          ? `no MCP server or API document of ${service}'s own found. Other people's servers (they'd see the data passing through):\n${theirs.map((x) => `  0b connect ${service} ${(x as { url: string }).url}`).join("\n")}`
          : `couldn't find ${service}'s MCP server or API document. Pass one: 0b connect ${service} <MCP URL>, 0b connect ${service} --spec <OpenAPI URL>, or 0b connect ${service} --api <base URL>`,
      );
    }
    const where = best.kind === "mcp" ? `MCP server ${best.url}${best.source === "registry" ? " (official registry)" : ""}` : best.kind === "openapi" ? `OpenAPI document ${best.specUrl}` : `0bridge's ${best.title} connector`;
    console.log(`${c.cyan("→")} Found ${where}`);
    if (others.length) console.log(c.dim(`  Also: ${others.slice(0, 3).map((x) => (x.kind === "mcp" ? x.url : x.kind === "openapi" ? `--spec ${x.specUrl}` : x.service)).join(", ")}`));
    if (best.kind === "preset") return connectApiCommand(ctx, best.service, opts);
    if (best.kind === "openapi") return connectSpecCommand(ctx, d.service, best.specUrl, opts);
    url = best.url;
    service = d.service;
  }
  const direct = DIRECT_ONLY[service.toLowerCase()];
  // With an OAuth app of the user's own (--client-id), try the bridge anyway: the service may accept it.
  if (direct && !urlArg && !opts.clientId) return connectDirect(ctx, service.toLowerCase(), url, direct);
  const label = await askLabel(ctx, service, opts.label);
  const oauthClient = opts.clientId ? { clientId: opts.clientId, clientSecret: opts.clientSecret } : undefined;
  // A service that needs a registered app (Slack): the workspace's own, or 0bridge's.
  const hosted = oauthClient ? false : await chooseApp(url, opts.app, Boolean(opts.yes));
  // 0bridge's app, before the service's MCP server takes it (Slack): its API, through that app.
  if (hosted && API_CONNECTORS[service.toLowerCase()]) return connectApiCommand(ctx, service, { ...opts, label: label ?? "" });
  let r: Awaited<ReturnType<typeof connectService>>;
  try {
    r = await connectService(ctx, service, label, url, opts.headers, (s) => console.log(s), oauthClient, hosted);
  } catch (e) {
    // Any other server that only accepts reviewed apps: the same way out.
    if (/only accepts sign-in from approved apps/.test((e as Error).message)) return connectDirect(ctx, service.toLowerCase(), url, (e as Error).message);
    throw e;
  }
  const conn = (await cloudClient(ctx).client.connections()).find((x) => x.id === r.id);
  console.log(`${c.green("✓")} ${r.display} connected${conn ? ` · ${conn.tools} tools as ${c.cyan(`${conn.prefix}__*`)}` : ""}. Every tool using your 0bridge can use it now.`);
}

type Way =
  | { kind: "mcp"; service: string; url: string }
  | { kind: "openapi"; service: string; specUrl: string }
  | { kind: "preset"; service: string }
  | { kind: "api"; service: string; baseUrl: string }
  | { kind: "cli"; cli: string };

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/**
 * Every way 0bridge can reach a service, to pick from: its MCP server (sign in in the browser),
 * its API (0bridge calls it with a key the user types here), or its CLI (signed in on this
 * machine, for 0b exec and agents' shells). The one 0bridge would pick is first and selected.
 */
async function chooseWay(ctx: Context, service: string): Promise<Way> {
  const plain = /[./]/.test(service) ? "" : service.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const s = p.spinner();
  s.start(`Looking for ${service}'s MCP server, API and CLI`);
  const [found, reg] = await Promise.all([
    cloudClient(ctx).client.discover(service),
    plain && !PRESETS[plain] ? searchRegistry(service, plain, { timeoutMs: 10_000 }).catch(() => []) : Promise.resolve([]),
  ]);
  const d = withRegistry(found, reg);
  s.stop(`${service}: ${d.candidates.length ? `found ${d.candidates.length} way${d.candidates.length === 1 ? "" : "s"} in` : "nothing found by name"}`);
  const name = d.service || plain || service;
  const ways: { way: Way; label: string; hint: string }[] = [];
  // Other people's MCP servers only when the service has no way in of its own (they'd see the data).
  const theirs = (x: (typeof d.candidates)[number]) => x.kind === "mcp" && x.official === false;
  const own = d.candidates.some((x) => !theirs(x));
  // With a connector 0bridge made for it, API documents from APIs.guru only add noise.
  const polished = d.candidates.some((x) => x.kind === "preset");
  for (const x of d.candidates) {
    if (polished && x.kind === "openapi" && x.source === "apis.guru") continue;
    if (x.kind === "mcp") {
      if (theirs(x) && own) continue;
      const direct = DIRECT_ONLY[name];
      const whose = theirs(x) ? "someone else's server: they'd see what passes through" : x.source === "registry" ? `${x.title}, official MCP registry` : "";
      // A service that needs a registered app (Slack) and has 0bridge's app as an API too: this is the workspace's own.
      const ownApp = appSetupFor(x.url) && API_CONNECTORS[name] ? `your own ${appSetupFor(x.url)!.name} app in the workspace: full access, a minute to set up` : "";
      ways.push({
        way: { kind: "mcp", service: name, url: x.url },
        label: `MCP · ${hostOf(x.url)}${theirs(x) ? " (not theirs)" : ""}`,
        hint: ownApp || [whose, direct ? "added to each AI tool directly" : "sign in in the browser"].filter(Boolean).join(" · "),
      });
    } else if (x.kind === "openapi") {
      ways.push({ way: { kind: "openapi", service: name, specUrl: x.specUrl }, label: `API · ${x.title}`, hint: `OpenAPI document (${hostOf(x.specUrl)}) · you type its key here` });
    } else {
      const app = PRESETS[x.service] ? appSetupFor(PRESETS[x.service]!) : null;
      ways.push({
        way: { kind: "preset", service: x.service },
        label: `API · ${x.title}`,
        hint: app
          ? `one click; search, read and post as you (channel history once a minute until 0bridge is in the ${app.name} Marketplace)`
          : x.auth === "oauth"
            ? "sign in in the browser"
            : "you type its key here",
      });
    }
  }
  for (const [id, a] of Object.entries(CLIS)) if (a.service === name) ways.push({ way: { kind: "cli", cli: id }, label: `CLI · ${a.label}`, hint: "signed in on this machine; 0b exec and agents' shells use it" });
  const other = "other";
  const picked = await p.select<number | string>({
    message: `How should your agents reach ${c.bold(name)}?`,
    options: [
      ...ways.map((w, i) => ({ value: i, label: w.label, hint: w.hint })),
      { value: other, label: "Something else", hint: "an MCP server URL, an OpenAPI document or an API's base URL" },
    ],
    initialValue: ways.length ? 0 : other,
  });
  if (p.isCancel(picked)) process.exit(0);
  if (picked !== other) return ways[picked as number]!.way;
  const kind = await p.select({
    message: "What do you have?",
    options: [
      { value: "mcp", label: "An MCP server URL", hint: "sign in in the browser" },
      { value: "openapi", label: "An OpenAPI document URL", hint: "0bridge reads its operations; you type the key" },
      { value: "api", label: "An API's base URL", hint: "you type the key; agents send requests through 0bridge" },
    ],
  });
  if (p.isCancel(kind)) process.exit(0);
  const v = await p.text({ message: "URL", placeholder: "https://…", validate: (x) => (/^https:\/\/\S+$/.test(x?.trim() ?? "") ? undefined : "an https:// address") });
  if (p.isCancel(v)) process.exit(0);
  const u = String(v).trim();
  return kind === "mcp" ? { kind: "mcp", service: name, url: u } : kind === "openapi" ? { kind: "openapi", service: name, specUrl: u } : { kind: "api", service: name, baseUrl: u };
}

/** The CLI way: sign the service's CLI into a profile of its own on this machine (0b profile). */
async function connectCli(ctx: Context, cli: string, given?: string): Promise<void> {
  const cfg = loadProfiles(ctx);
  const v =
    given ??
    (await p.text({
      message: `Name this login ${c.dim("(a profile: repos bound to it use this account)")}`,
      placeholder: "work",
      validate: (x) => (PROFILE_NAME.test(x?.trim() ?? "") ? undefined : "lowercase letters, digits, - and _"),
    }));
  if (p.isCancel(v)) process.exit(0);
  const name = String(v).trim();
  await loginInto(ctx, name, cli);
  console.log(`${c.green("✓")} ${CLIS[cli]!.label} signed in as profile ${c.bold(name)}${cfg.profiles[name] ? " (added to it)" : ""}. In a repo: ${c.cyan(`0b profile use ${name}`)}; then ${c.cyan(`0b exec -- ${cli} …`)} and agents' shells use it.`);
}

/** Piped-in text, or "" when nothing is (an agent's closed or empty stdin). */
function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Ask for an API's keys, hidden, one prompt per key; only in the user's own terminal. */
async function askKeys(names: string[], title: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const values: string[] = [];
  for (const n of names.length ? names : ["API key"]) {
    const v = await p.password({ message: `${title} ${n}`, mask: "•", validate: (x) => (x?.trim() ? undefined : "required") });
    if (p.isCancel(v)) process.exit(0);
    values.push(String(v).trim());
  }
  return values.join("\n");
}

/** What's left for the user when the key isn't in yet: one command, or the dashboard. */
function keyHint(ctx: Context, r: { id: string; prefix: string; keys: string[]; keyUrl?: string }) {
  const url = r.keyUrl ?? `${cloudClient(ctx).cfg.server.replace(/\/+$/, "")}/app/connections?key=${encodeURIComponent(r.id)}`;
  console.log(`${c.yellow("●")} It needs ${r.keys.length > 1 ? `${r.keys.length} keys (${r.keys.join(", ")})` : `a key (${r.keys[0] ?? "API key"})`}. The user types it in, not an agent:`);
  console.log(`    terminal:  ${c.cyan(`0b key ${r.prefix}`)}`);
  console.log(`    browser:   ${url}`);
}

/**
 * An API from its OpenAPI document: the gateway reads its auth and operations. Asks for the keys
 * in a terminal; with --yes or without one (an agent), registers it and prints how to add them.
 */
async function connectSpecCommand(ctx: Context, service: string, specUrl: string, opts: { label?: string; allowWrite?: boolean; yes?: boolean; api?: string }): Promise<void> {
  const { client } = cloudClient(ctx);
  const named = /[./]/.test(service) ? undefined : service;
  const label = opts.yes || !process.stdin.isTTY ? opts.label : named ? await askLabel(ctx, named, opts.label) : opts.label;
  const r = await client.connectApi({ service: named, label, spec: specUrl, baseUrl: opts.api, allowWrite: opts.allowWrite });
  if (r.state === "conflict") throw new CloudError(`${r.error} — try the label "${r.suggestion}"`, 409);
  if (r.state === "needs_app") throw new CloudError(r.error, 422);
  const about = r.openapi ? `${r.openapi.title}, ${r.openapi.ops} operations, ${r.openapi.write ? "writes allowed" : "reads only (allow writes on the dashboard)"}` : "API";
  console.log(`${c.green("✓")} ${c.bold(r.display)} registered · ${about}`);
  if (r.state === "needs_key") {
    const key = opts.yes ? null : await askKeys(r.keys, r.display);
    if (!key) return keyHint(ctx, r);
    await client.setKey(r.id, key);
  }
  const conn = (await client.connections()).find((x) => x.id === r.id);
  console.log(`${c.green("✓")} ${r.display} connected${conn ? ` · ${conn.tools} tools as ${c.cyan(`${conn.prefix}__*`)} (search, describe, call${r.openapi?.write ? ", call_write" : ""})` : ""}. The key stays with 0bridge.`);
}

/** `0b key <service>`: give an API connection its key(s), typed hidden in the user's own terminal. */
export async function keyCommand(ctx: Context, name: string | undefined): Promise<void> {
  const { client } = cloudClient(ctx);
  const all = (await client.connections()).filter((x) => x.kind === "api");
  if (!name) {
    const waiting = all.filter((x) => x.state === "needs_key");
    console.log(waiting.length ? `Waiting for a key: ${waiting.map((x) => c.cyan(x.prefix)).join(", ")}\nusage: 0b key <service>` : "usage: 0b key <service>  (no API connection is waiting for a key)");
    return;
  }
  const n = name.toLowerCase();
  const matches = all.filter((x) => x.prefix === n || x.id === name || x.display.toLowerCase() === n || x.service.toLowerCase() === n);
  const conn = matches.find((x) => x.prefix === n || x.id === name) ?? (matches.length === 1 ? matches[0] : undefined);
  if (!conn) throw new Error(matches.length ? `several accounts: ${matches.map((x) => x.prefix).join(", ")} — pass one` : `no API connection "${name}" (0b cloud lists them)`);
  if (!conn.keys?.length) throw new Error(`${conn.display} signs in instead of using a key; connect it again to sign in`);
  if (!process.stdin.isTTY) {
    const url = `${cloudClient(ctx).cfg.server.replace(/\/+$/, "")}/app/connections?key=${encodeURIComponent(conn.id)}`;
    throw new Error(`keys are typed by the user, in their own terminal (0b key ${conn.prefix}) or at ${url}; not through an agent`);
  }
  const key = await askKeys(conn.keys, conn.display);
  if (!key) return;
  await client.setKey(conn.id, key);
  const after = (await client.connections()).find((x) => x.id === conn.id);
  console.log(`${c.green("✓")} ${conn.display} is ready${after ? ` · ${after.tools} tools as ${c.cyan(`${after.prefix}__*`)}` : ""}. The key stays with 0bridge; agents never see it.`);
}

const setupName = (url: string) => appSetupFor(url)?.name ?? "The service";

/**
 * For services that need a registered OAuth app (Slack): the user's own app in the workspace
 * (works now, a minute to set up), or 0bridge's app (one click; the service accepts it once it's
 * in its Marketplace, and each install counts toward that). `--app own|0bridge` picks without asking.
 */
async function chooseApp(url: string, flag: string | undefined, yes: boolean): Promise<boolean> {
  const setup = appSetupFor(url);
  if (!setup) return false;
  if (flag) {
    if (flag !== "own" && flag !== "0bridge") throw new Error(`--app is own or 0bridge (got "${flag}")`);
    return flag === "0bridge";
  }
  // 0bridge's app is the default: one click, and each install counts toward its Marketplace listing.
  if (!process.stdin.isTTY || yes) return true;
  const v = await p.select({
    message: `Which ${setup.name} app signs you in?`,
    options: [
      { value: "0bridge", label: "0bridge's app", hint: `one click; search, read and post as you (channel history once a minute until 0bridge is in the ${setup.name} Marketplace)` },
      { value: "own", label: "My own app in this workspace", hint: "full access; 0b fills in the app, you copy its ID and secret" },
    ],
    initialValue: "0bridge",
  });
  if (p.isCancel(v)) process.exit(0);
  return v === "0bridge";
}

/** "bearer" (default), "basic", "header:X-API-Key", "query:api_key". */
function parseAuthStyle(s = "bearer"): { type: "bearer" | "basic" | "header" | "query"; name?: string } {
  const [type, name] = s.split(":", 2) as [string, string?];
  if (type === "bearer" || type === "basic") return { type };
  if ((type === "header" || type === "query") && name?.trim()) return { type, name: name.trim() };
  throw new Error(`--auth is bearer, basic, header:<Header-Name> or query:<param> (got "${s}")`);
}

/**
 * A connector of kind "api": a known one (google-calendar signs in with Google) or any HTTP API
 * with a key. The key is asked for (hidden) or read from stdin, never taken from the command line,
 * and goes to the gateway only: agents call the API through 0bridge without seeing it.
 */
async function connectApiCommand(ctx: Context, service: string, opts: { label?: string; api?: string; auth?: string; yes?: boolean }): Promise<void> {
  const { client } = cloudClient(ctx);
  const preset = opts.api ? undefined : service.toLowerCase();
  const asks = process.stdin.isTTY && !opts.yes;
  const label = asks ? await askLabel(ctx, service, opts.label) : opts.label;
  let key: string | undefined;
  let auth: ReturnType<typeof parseAuthStyle> | undefined;
  const keyed = preset ? API_CONNECTORS[preset] : undefined;
  if (keyed?.auth === "key") {
    // A known API with keys (Channel Talk: access key + secret): one hidden prompt each, or one per line on stdin.
    const names = keyed.keys ?? ["API key"];
    if (keyed.where) console.log(c.dim(`Keys: ${keyed.where}`));
    const values: string[] = [];
    if (asks) {
      for (const n of names) {
        const v = await p.password({ message: `${keyed.title} ${n}`, mask: "•", validate: (x) => (x?.trim() ? undefined : "required") });
        if (p.isCancel(v)) process.exit(0);
        values.push(String(v).trim());
      }
    } else if (!opts.yes) values.push(...readStdin().split("\n").map((x) => x.trim()).filter(Boolean));
    // Nothing piped in (an agent ran this): register it; the user adds the keys with `0b key`.
    if (values.length && values.length !== names.length) throw new Error(`${keyed.title} needs ${names.length} keys (${names.join(", ")}), one per line`);
    key = values.length ? values.join("\n") : undefined;
  } else if (!preset) {
    auth = parseAuthStyle(opts.auth);
    if (asks) {
      const v = await p.password({ message: `API key for ${service}${auth.type === "basic" ? " (user:password)" : ""}`, mask: "•", validate: (x) => (x?.trim() ? undefined : "required") });
      if (p.isCancel(v)) process.exit(0);
      key = String(v).trim();
    } else key = opts.yes ? undefined : readStdin().trim() || undefined;
  }
  const r = await client.connectApi({ service, label, preset, baseUrl: opts.api, auth, key });
  if (r.state === "conflict") throw new CloudError(`${r.error} — try the label "${r.suggestion}"`, 409);
  if (r.state === "needs_app") throw new CloudError(r.error, 422);
  if (r.state === "needs_key") {
    console.log(`${c.green("✓")} ${c.bold(r.display)} registered (API).`);
    return keyHint(ctx, r);
  }
  if (r.state === "authenticating") {
    console.log(`Opening ${c.bold(r.display)} sign-in in your browser.\n${c.dim(`If it doesn't open: ${r.authUrl}`)}`);
    openBrowser(r.authUrl);
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${r.display} sign-in`);
      await new Promise((res) => setTimeout(res, 2000));
      const conn = (await client.connections()).find((x) => x.id === r.id);
      if (conn?.state === "ready") break;
    }
  }
  const conn = (await client.connections()).find((x) => x.id === r.id);
  console.log(`${c.green("✓")} ${r.display} connected (API)${conn ? ` · ${conn.tools} tools as ${c.cyan(`${conn.prefix}__*`)}` : ""}. The key stays with 0bridge; agents call it through your bridge.`);
}

/**
 * For services that don't accept 0bridge's gateway (DIRECT_ONLY): add the MCP server to every AI
 * tool on this machine instead, through the local sync (files are backed up). Each tool then
 * signs in on its own, since the tools themselves are approved clients.
 */
async function connectDirect(ctx: Context, name: string, url: string, why: string): Promise<void> {
  console.log(`${c.yellow("●")} ${why}. Adding ${c.bold(name)} to each of your AI tools directly instead; each one signs in to it once.`);
  const m = loadManifest(ctx) ?? emptyManifest();
  m.mcpServers[name] = { transport: "http", url };
  saveManifest(ctx, m);
  const plan = planApply(ctx, m, loadState(ctx), openSecretStore(ctx.storeDir));
  if (plan.missing.length) throw new Error(`not synced: ${plan.missing.join(", ")} missing (0b secret set <name> --global), then 0b apply`);
  if (plan.changes.length) {
    const id = executePlan(ctx, plan);
    for (const line of planSummary(ctx, plan)) console.log(`  ${line}`);
    console.log(c.dim(`  Backed up first; undo with 0b restore ${id}`));
  } else console.log(c.dim("  Your tools already have it."));
  console.log(`${c.green("✓")} ${name} added as its own MCP server (tools appear as ${c.cyan(`mcp__${name}__*`)} in Claude Code). Sign in once per tool:
  Claude Code  run ${c.cyan("/mcp")}, pick ${name}, Authenticate
  Codex        ${c.cyan(`codex mcp login ${name}`)}
  Cursor       Settings → MCP → ${name} → Needs login`);
}

const same = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, "_") === b.toLowerCase().replace(/[^a-z0-9]+/g, "_");

/**
 * The connection `0b disconnect linear --label acme` means: a service, plus the account label
 * when the service has more than one. Never guesses between accounts; says which labels exist.
 * Also takes an id, `linear__acme` or `linear/acme`.
 */
export async function findConnection(ctx: Context, service: string, label?: string): Promise<CloudConnection> {
  const conns = await cloudClient(ctx).client.connections();
  const key = service.trim();
  const exact = conns.find((x) => x.id === key || x.prefix === key);
  if (exact && label === undefined) return exact;
  const [svc, lbl] = label !== undefined ? [key, label.trim()] : (key.split(/\s*(?:›|\/|__)\s*/) as [string, string?]);
  const accounts = conns.filter((x) => same(x.service, svc));
  if (!accounts.length) throw new Error(`no ${svc} connection — see \`0b cloud\``);
  const labels = accounts.map((x) => x.label ?? "- for no label").join(", ");
  if (lbl === undefined) {
    if (accounts.length === 1) return accounts[0]!;
    throw new Error(`${svc} has ${accounts.length} accounts (${labels}) — add --label <name>`);
  }
  const hit = accounts.find((x) => (lbl === "" || lbl === "-" ? !x.label : x.label && same(x.label, lbl)));
  if (!hit) throw new Error(`${svc} has no account labeled "${lbl}" (labels: ${labels})`);
  return hit;
}

/** Set a connection's label. Its sign-in is kept; only the label and tool prefix change. */
export async function renameConnection(ctx: Context, conn: CloudConnection, newLabel?: string): Promise<void> {
  let label = newLabel;
  if (label === undefined) {
    if (!process.stdin.isTTY) throw new Error("usage: 0b rename <service> [--label <current>] <new label>   (- clears it)");
    const v = await p.text({
      message: `Account label for ${c.bold(conn.display)} ${c.dim("(- to clear)")}`,
      placeholder: conn.label ?? "e.g. your org",
      defaultValue: conn.label ?? "",
    });
    if (p.isCancel(v)) return;
    label = String(v);
  }
  label = label.trim() === "-" ? "" : label.trim();
  if (label === (conn.label ?? "")) return console.log(c.dim("No change."));
  const r = await cloudClient(ctx).client.rename(conn.id, label);
  if ("state" in r) throw new CloudError(`${r.error} — try "${r.suggestion}"`, 409);
  console.log(`${c.green("✓")} ${conn.display} → ${c.bold(r.display)} · tools are now ${c.cyan(`${r.prefix}__*`)} (restart agent sessions to see the new names)`);
}
export async function cloudStatus(ctx: Context) {
  const { cfg, client } = cloudClient(ctx);
  const [me, conns] = await Promise.all([client.me(), client.connections()]);
  if (me.login !== cfg.login || (me.email && me.email !== cfg.email)) saveCloud(ctx, { ...cfg, login: me.login, email: me.email ?? cfg.email });
  const others = loadAccounts(ctx).accounts.length - 1;
  console.log(`${c.bold(me.login)} ${c.dim(`· ${cfg.server}${others ? ` · ${others} more signed in (0b account)` : ""}`)}`);
  console.log(`MCP endpoint ${c.cyan(me.mcpUrl)}\n`);
  if (!conns.length) return console.log(c.dim(`No services yet. Try ${c.cyan("0b connect linear")}.`));
  for (const x of conns) console.log("  " + connectionLine(x));
}

export function connectionLine(x: { display: string; prefix: string; state: string; tools: number; url: string }, width = 20): string {
  const state = x.state === "ready" ? c.green("ready") : x.state === "authenticating" ? c.yellow("needs sign-in") : c.red(x.state);
  const pad = (s: string, n: number, visible = s.length) => s + " ".repeat(Math.max(1, n - visible));
  return `${pad(x.display, width)}${pad(state, x.state === "authenticating" ? 15 : 8, x.state === "authenticating" ? 13 : x.state.length)}${String(x.tools).padStart(3)} tools  ${c.dim(`${x.prefix}__*  ${x.url}`)}`;
}

/** Move remote servers configured locally into the cloud, then stop syncing them locally. */
export async function migrateTui(ctx: Context): Promise<boolean> {
  const m = requireManifest(ctx);
  const store = openSecretStore(ctx.storeDir);
  const remote = Object.entries(m.mcpServers).filter(([n, s]) => n !== GATEWAY_NAME && s.transport !== "stdio" && s.enabled !== false);
  if (!remote.length) {
    p.log.info("No remote MCP servers to move.");
    return false;
  }
  const picked = await p.multiselect({
    message: `Move these to 0bridge cloud? ${c.dim("— sign in once, then every tool and device shares the connection")}`,
    options: remote.map(([n, s]) => ({ value: n, label: n, hint: where(s, 44) })),
    initialValues: remote.map(([n]) => n),
    required: false,
  });
  if (p.isCancel(picked) || !picked.length) return false;
  let moved = 0;
  for (const name of picked) {
    const s = resolveServer(m.mcpServers[name]!, store);
    const url = s.transport === "sse" ? s.url!.replace(/\/sse\/?$/, "/mcp") : s.url!;
    try {
      const { label } = await cloudClient(ctx).client.suggestLabel(name);
      await connectService(ctx, name, label || undefined, url, s.headers && Object.keys(s.headers).length ? s.headers : undefined);
      m.mcpServers[name]!.enabled = false; // now served by the gateway; apply removes the local copies
      saveManifest(ctx, m);
      moved++;
      p.log.success(`${name} is in the cloud`);
    } catch (e) {
      p.log.error(`${name}: ${e instanceof CloudError || e instanceof Error ? e.message : String(e)} — kept local`);
    }
  }
  return moved > 0;
}
