import { loadCloud, loadManifest, readInstructions, type Context, type CloudConnection } from "@0bridge/core";
import { cloudClient, connectionLine } from "./cloud.ts";
import { c, where } from "./ui.ts";

/** `note`: a remark under a list (what's hidden), not one of the things it lists. */
export type Node = { text: string; children?: Node[]; note?: boolean };

export function render(nodes: Node[], prefix = ""): string[] {
  return nodes.flatMap((n, i) => {
    const last = i === nodes.length - 1;
    const line = `${prefix}${c.dim(last ? "└─ " : "├─ ")}${n.text}`;
    return [line, ...render(n.children ?? [], prefix + c.dim(last ? "   " : "│  "))];
  });
}

/** Everything 0bridge manages, as one tree: cloud connections, local MCP servers, skills, instructions. */
export async function printTree(ctx: Context): Promise<void> {
  const nodes: Node[] = [];

  const cloud = loadCloud(ctx);
  if (!cloud) {
    nodes.push({ text: `${c.bold("Cloud")} ${c.dim(`not signed in — ${c.cyan("0b login")}`)}` });
  } else {
    let conns: CloudConnection[] | null = null;
    try {
      conns = await cloudClient(ctx).client.connections();
    } catch (e) {
      nodes.push({ text: `${c.bold("Cloud")} ${c.red(`unreachable: ${e instanceof Error ? e.message : e}`)}` });
    }
    if (conns) {
      const width = Math.max(12, ...conns.map((x) => x.display.length)) + 2;
      nodes.push({
        text: `${c.bold("Cloud")} ${c.dim(`· ${cloud.login} · ${cloud.server}/mcp`)}`,
        children: conns.length ? conns.map((x) => ({ text: connectionLine(x, width) })) : [{ text: c.dim(`no services yet — ${c.cyan("0b connect linear")}`) }],
      });
    }
  }

  const m = loadManifest(ctx);
  if (!m) {
    nodes.push({ text: `${c.bold("Local")} ${c.dim(`not set up — ${c.cyan("0b init")}`)}` });
  } else {
    const servers = Object.entries(m.mcpServers).sort(([a], [b]) => a.localeCompare(b));
    const width = Math.max(12, ...servers.map(([n]) => n.length)) + 2;
    nodes.push({
      text: `${c.bold("MCP servers")} ${c.dim(`· ${servers.length}, synced into your tools`)}`,
      children: servers.map(([n, s]) => {
        const tags = [s.enabled === false && c.yellow("off"), s.targets && c.yellow(`${s.targets.join(",")} only`)].filter(Boolean).join(" ");
        return { text: `${n.padEnd(width)}${c.dim(s.transport.padEnd(6))} ${c.dim(where(s, 44))} ${tags}`.trimEnd() };
      }),
    });
    const skills = Object.entries(m.skills).sort(([a], [b]) => a.localeCompare(b));
    nodes.push({
      text: `${c.bold("Skills")} ${c.dim(`· ${skills.length}`)}`,
      children: skills.map(([n, s]) => ({ text: `${n}${s.enabled === false ? ` ${c.yellow("off")}` : ""}${s.targets ? ` ${c.yellow(`${s.targets.join(",")} only`)}` : ""}` })),
    });
    const ins = readInstructions(ctx).trim();
    nodes.push({ text: `${c.bold("Instructions")} ${c.dim(ins ? `· AGENTS.md, ${ins.split("\n").length} lines` : "· none")}` });
  }

  console.log(c.bold("0bridge"));
  for (const line of render(nodes)) console.log(line);
}
