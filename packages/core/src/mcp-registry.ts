/**
 * The official MCP registry (registry.modelcontextprotocol.io), searched for a service's MCP
 * server. Shared by the gateway, the dashboard and the CLI. The registry's search is slow (it
 * scans names: 15–45 s for a query it hasn't cached, from anywhere), so the gateway keeps its own
 * index of the registry, refreshed daily from the list pages (fast), and searches that
 * (apps/gateway/src/registry.ts). The browser and the CLI search the index too (registryFirst) and
 * ask the registry themselves only while there's none, adding what they find to the gateway's
 * discovery. An entry is the service's own ("official") when its
 * namespace or its server's domain is the service's; the rest are other people's servers, never
 * picked on their own.
 */

export interface RegistryCandidate {
  kind: "mcp";
  service: string;
  title: string;
  url: string;
  source: "registry";
  official: boolean;
  description?: string;
}

/** A registry entry, as `/v0/servers` lists it (the fields used here). */
export interface RegistryEntry {
  server: { name?: string; title?: string; description?: string; remotes?: { type?: string; url?: string }[] };
  _meta?: Record<string, any>;
}

export const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";

const oneLine = (s: unknown, max: number) => {
  const t = String(s ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** "mcp.linear.app" → "linear"; "api.example.co.kr" → "example". */
function siteName(host: string): string {
  const parts = host.toLowerCase().split(".");
  const n = parts.length >= 3 && parts.at(-1)!.length === 2 && /^(co|com|or|ne|go|ac|org|net)$/.test(parts.at(-2)!) ? 3 : 2;
  return parts.slice(-n)[0] ?? "";
}

export async function searchRegistry(q: string, service: string, opts: { fetcher?: typeof fetch; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<RegistryCandidate[]> {
  const fetcher = opts.fetcher ?? fetch;
  const res = await fetcher(`${REGISTRY}?search=${encodeURIComponent(q)}&limit=30`, { headers: { Accept: "application/json", ...opts.headers }, signal: AbortSignal.timeout(opts.timeoutMs ?? 6000) });
  if (!res.ok) throw new Error(`MCP registry: ${res.status}`);
  const j = (await res.json()) as { servers?: RegistryEntry[] };
  return registryCandidates(j.servers ?? [], service);
}

/** `GET /api/connectors/registry`: the gateway's index searched, or `indexed: false` while it has none. */
export interface RegistryIndexAnswer {
  indexed: boolean;
  /** When the index's last full pass finished (0: the first is still going). */
  at?: number;
  candidates: RegistryCandidate[];
}

/**
 * Registry entries for `service`, for the dashboard and the CLI: from the gateway's index
 * (`fromIndex`, milliseconds), and from the registry's own slow search only when the gateway has
 * no index or doesn't answer (a server from before the index).
 */
export async function registryFirst(fromIndex: () => Promise<RegistryIndexAnswer>, q: string, service: string, opts: { timeoutMs?: number } = {}): Promise<RegistryCandidate[]> {
  const r = await fromIndex().catch(() => null);
  if (r?.indexed) return r.candidates;
  return searchRegistry(q, service, opts).catch(() => []);
}

/** An entry's streamable HTTP (or SSE) address: https, not a template, the latest active version. Null otherwise. */
export function remoteOf({ server, _meta }: RegistryEntry): string | null {
  const meta = _meta?.["io.modelcontextprotocol.registry/official"];
  if (meta && (meta.isLatest === false || meta.status !== "active")) return null;
  const remotes = server.remotes ?? [];
  const remote = remotes.find((r) => r.type === "streamable-http") ?? remotes.find((r) => r.type === "sse");
  if (!remote?.url || /[{}]/.test(remote.url)) return null;
  try {
    return new URL(remote.url).protocol === "https:" ? remote.url : null;
  } catch {
    return null;
  }
}

/** Entries as candidates for `service`: its own servers, then up to three of other people's. */
export function registryCandidates(entries: RegistryEntry[], service: string): RegistryCandidate[] {
  const out: RegistryCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const url = remoteOf(entry);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const { server } = entry;
    // "app.linear/linear" is published by linear.app.
    const ns = String(server.name ?? "").split("/")[0]!.split(".");
    const official = ns.includes(service) || siteName(new URL(url).hostname) === service;
    out.push({ kind: "mcp", service, title: oneLine(server.title || server.name, 80), url, source: "registry", official, ...(server.description ? { description: oneLine(server.description, 200) } : {}) });
  }
  const own = out.filter((c) => c.official);
  return [...own, ...out.filter((c) => !c.official).slice(0, 3)];
}

type AnyCandidate = { kind: string; service: string; url?: string; specUrl?: string; official?: boolean; source?: string };

/**
 * Registry results added to a discovery from the gateway: the service's own servers go after
 * 0bridge's connectors and before API documents (an MCP server is the better way in), others last.
 * `best` is the first one safe to connect without asking.
 */
export function withRegistry<D extends { service: string; best: AnyCandidate | null; candidates: AnyCandidate[] }>(d: D, found: RegistryCandidate[]): D {
  const have = new Set(d.candidates.filter((c) => c.kind === "mcp").map((c) => c.url));
  const fresh = found.filter((c) => !have.has(c.url));
  if (!fresh.length) return d;
  const own = fresh.filter((c) => c.official);
  const others = fresh.filter((c) => !c.official);
  const first = d.candidates.filter((c) => c.kind === "preset" || (c.kind === "mcp" && c.official));
  const rest = d.candidates.filter((c) => !first.includes(c));
  const candidates = [...first, ...own, ...rest, ...others].slice(0, 10);
  const best = candidates.find((c) => c.kind !== "mcp" || c.official) ?? null;
  return { ...d, candidates, best };
}
