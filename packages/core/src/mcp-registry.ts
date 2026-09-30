/**
 * The official MCP registry (registry.modelcontextprotocol.io), searched for a service's MCP
 * server. Shared by the gateway, the dashboard and the CLI: the registry doesn't answer requests
 * from Cloudflare Workers, so the browser and the CLI ask it themselves and add what they find to
 * the gateway's discovery (D41). An entry is the service's own ("official") when its namespace or
 * its server's domain is the service's; the rest are other people's servers, never picked on
 * their own.
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

const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";

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
  const j = (await res.json()) as { servers?: { server: any; _meta?: any }[] };
  const out: RegistryCandidate[] = [];
  const seen = new Set<string>();
  for (const { server, _meta } of j.servers ?? []) {
    const meta = _meta?.["io.modelcontextprotocol.registry/official"];
    if (meta && (meta.isLatest === false || meta.status !== "active")) continue;
    const remotes: { type?: string; url?: string }[] = server.remotes ?? [];
    const remote = remotes.find((r) => r.type === "streamable-http") ?? remotes.find((r) => r.type === "sse");
    if (!remote?.url || seen.has(remote.url) || /[{}]/.test(remote.url)) continue;
    let host: string;
    try {
      const u = new URL(remote.url);
      if (u.protocol !== "https:") continue;
      host = u.hostname;
    } catch {
      continue;
    }
    seen.add(remote.url);
    // "app.linear/linear" is published by linear.app.
    const ns = String(server.name ?? "").split("/")[0]!.split(".");
    const official = ns.includes(service) || siteName(host) === service;
    out.push({ kind: "mcp", service, title: oneLine(server.title || server.name, 80), url: remote.url, source: "registry", official, ...(server.description ? { description: oneLine(server.description, 200) } : {}) });
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
