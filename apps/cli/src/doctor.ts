/**
 * `0b status`: is this machine, and the repo it's run in, set up with 0bridge? One checklist, each
 * item done (✓) or not (●) with the command that fixes it, marked for who runs it: [agent] is safe
 * for an AI agent to run as is, [you] needs the user (a browser sign-in, a key, a choice).
 * Agents are told (the 0bridge skill) to run the [agent] fixes and hand the rest to the user in one
 * summary, so setting up a repo on a new machine reads the same from any tool.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_SCOPE, computeStatus, loadCloud, loadHistoryConfig, loadManifest, openSecretStore, parseDotenv, vaultKeyId, type Context } from "@0bridge/core";
import { backgroundInstalled } from "./background.ts";
import { cloudClient } from "./cloud.ts";
import { skillsToAsk } from "./context.ts";
import { HOME_REPO, filesHere, repoHere } from "./files.ts";
import { connectionTree, loadLinks, projectOf, toolStates } from "./project.ts";
import { render } from "./tree.ts";
import { c } from "./ui.ts";
import { localKey } from "./vault.ts";

interface Item {
  ok: boolean;
  label: string;
  detail?: string;
  fix?: string;
  /** Who runs the fix: an agent as is, or the user. */
  who?: "agent" | "you";
  /** Under the item (a project's connections as a tree). */
  more?: string[];
}

/** A few names, and how many more. */
const some = (names: string[], n = 8) => (names.length > n ? `${names.slice(0, n).join(", ")} (+${names.length - n} more)` : names.join(", "));

const line = (i: Item) => {
  const mark = i.ok ? c.green("✓") : c.yellow("●");
  const fix = i.fix ? `  ${c.cyan(i.fix)} ${c.dim(i.who === "agent" ? "[agent]" : "[you]")}` : "";
  return `  ${mark} ${i.label.padEnd(20)} ${i.detail ? c.dim(i.detail) : ""}${fix}`.trimEnd();
};

/** Env var names a repo says it needs: its .env.example (and .sample/.template) files, tracked in git. */
function neededNames(root: string): { names: Set<string>; from: string[] } {
  const r = spawnSync("git", ["ls-files", "--", "*.env*example*", "*.env*sample*", "*.env*template*"], { cwd: root, encoding: "utf8" });
  const from = (r.stdout ?? "").split("\n").filter(Boolean).slice(0, 20);
  const names = new Set<string>();
  for (const f of from) {
    try {
      for (const k of Object.keys(parseDotenv(readFileSync(join(root, f), "utf8")))) names.add(k);
    } catch {}
  }
  return { names, from };
}

export async function doctorCommand(ctx: Context): Promise<void> {
  const machine: Item[] = [];
  const repoItems: Item[] = [];
  const cloud = loadCloud(ctx);
  const here = repoHere();

  // Local tool configs (0b init / 0b apply).
  const manifest = loadManifest(ctx);
  if (!manifest) machine.push({ ok: false, label: "AI tools", detail: "0bridge isn't set up on this machine", fix: "0b setup", who: "you" });
  else {
    const s = computeStatus(ctx, manifest, openSecretStore(ctx.storeDir));
    const drift = [...s.mcp, ...s.skills, { cells: s.instructions }].some((r) => Object.values(r.cells).some((v) => v === "missing" || v === "differs"));
    const tools = s.tools.filter((t) => t.installed && t.enabled).map((t) => t.label);
    machine.push(drift ? { ok: false, label: "AI tools", detail: `${tools.join(", ")}: settings differ from 0bridge's`, fix: "0b apply --yes", who: "agent" } : { ok: true, label: "AI tools", detail: tools.join(", ") });
  }

  if (!cloud) {
    machine.push({ ok: false, label: "Signed in", detail: "not signed in", fix: "0b login", who: "you" });
  } else {
    machine.push({ ok: true, label: "Signed in", detail: `${cloud.login} · ${cloud.server.replace(/^https?:\/\//, "")}` });
    const { client } = cloudClient(ctx);
    const [vault, conns, home, repoFiles, project] = await Promise.all([
      client.vault().catch(() => null),
      client.connections().catch(() => null),
      filesHere(client, HOME_REPO, ctx.home).catch(() => null),
      here ? filesHere(client, here.repo, here.root).catch(() => null) : Promise.resolve(null),
      here ? projectOf(client, here.repo).catch(() => null) : Promise.resolve(null),
    ]);

    // The vault, on this machine.
    const key = localKey(ctx);
    if (!vault) machine.push({ ok: false, label: "Secrets vault", detail: "couldn't reach it" });
    else if (!vault.keyId) machine.push({ ok: false, label: "Secrets vault", detail: "none yet (made with the first secret)", fix: "0b secret set <NAME>", who: "you" });
    else if (!key || vaultKeyId(key) !== vault.keyId)
      machine.push({ ok: false, label: "Secrets vault", detail: "this machine can't open it yet", fix: "0b vault unlock", who: "agent" });
    else machine.push({ ok: true, label: "Secrets vault", detail: `opens here · ${vault.items.length} values` });

    // Files in the home folder that follow the user (Claude Code's status line).
    if (home) {
      const n = home.missing.length + home.differ.length;
      machine.push(
        !home.total
          ? { ok: true, label: "Home files", detail: "none synced (0b files statusline shares the status line)" }
          : n
            ? { ok: false, label: "Home files", detail: `${n} of ${home.total} not up to date here (${[...home.missing, ...home.differ].slice(0, 3).join(", ")})`, fix: "cd ~ && 0b files pull", who: "agent" }
            : { ok: true, label: "Home files", detail: `${home.total} in sync` },
      );
    }

    const history = loadHistoryConfig(ctx);
    machine.push(history.enabled ? { ok: true, label: "Conversations", detail: "synced from this machine" } : { ok: false, label: "Conversations", detail: "not synced from this machine", fix: "0b history on", who: "you" });
    // Skills a tool brought along that were never uploaded: the user decides, once.
    const asked = await skillsToAsk(ctx).catch(() => null);
    if (asked?.length) machine.push({ ok: false, label: "Skills", detail: `${asked.length} here not on 0bridge, waiting for your call: ${some(asked)}`, fix: "0b skill share <name> | 0b skill local <name>", who: "you" });
    machine.push(backgroundInstalled(ctx) ? { ok: true, label: "Background sync", detail: "on" } : { ok: false, label: "Background sync", detail: "off: files and conversations sync only when 0b runs", fix: "0b background on", who: "agent" });

    // Connections that need the user.
    if (conns) {
      const bad = conns.filter((x) => x.state !== "ready");
      machine.push(
        bad.length
          ? {
              ok: false,
              label: "Connections",
              detail: `${conns.length - bad.length} of ${conns.length} ready`,
              more: bad.map((x) =>
                x.state === "needs_key"
                  ? `${x.display}: needs its key → ${c.cyan(`0b key ${x.prefix}`)} ${c.dim("[you]")}`
                  : x.state === "authenticating"
                    ? `${x.display}: needs sign-in → ${c.cyan(`0b connect ${x.service}${x.label ? ` --label ${x.label}` : ""}`)} ${c.dim("[you]")}`
                    : `${x.display}: ${x.state}${x.error ? ` (${x.error.slice(0, 80)})` : ""} → ${c.cyan(`0b disconnect ${x.service}${x.label ? ` --label ${x.label}` : ""}`)}, then connect again ${c.dim("[you]")}`,
              ),
            }
          : { ok: true, label: "Connections", detail: `${conns.length} ready` },
      );
    }

    // This repo.
    if (here) {
      if (!project?.project) repoItems.push({ ok: false, label: "Project", detail: "not a project: agents here see every connection", fix: "0b project link", who: "agent" });
      else {
        const p = project.project;
        const tools = toolStates(ctx, here.root, p.id);
        const linked = loadLinks(ctx).links[here.root]?.projectId === p.id && tools.every((t) => t.on);
        const tree = render(connectionTree(project.all, p)).map((l) => `  ${l}`);
        repoItems.push(
          linked
            ? { ok: true, label: "Project", detail: `linked${p.strict ? " (strict)" : ""} · agents here see:`, more: tree }
            : { ok: false, label: "Project", detail: `${tools.filter((t) => !t.on).map((t) => t.tool).join(", ") || "tools"} here use the global endpoint`, fix: "0b project link", who: "agent", more: tree },
        );
      }
      if (repoFiles) {
        const n = repoFiles.missing.length + repoFiles.differ.length;
        repoItems.push(
          !repoFiles.total
            ? { ok: true, label: "Personal files", detail: "none (0b files add AGENTS.local.md to share one)" }
            : n
              ? { ok: false, label: "Personal files", detail: `${n} of ${repoFiles.total} not up to date here`, fix: "0b files pull", who: "agent" }
              : { ok: true, label: "Personal files", detail: `${repoFiles.total} in sync` },
        );
      }
      if (vault?.keyId) {
        const mine = vault.items.filter((i) => (i.scope === here.repo || i.scope === GLOBAL_SCOPE) && i.enabled !== false);
        const inEnv = (env: string) => new Set(mine.filter((i) => i.env === env).map((i) => i.name));
        const dev = inEnv("dev");
        const prod = inEnv("prod");
        const count = (env: string) => vault.items.filter((i) => i.scope === here.repo && i.env === env).length;
        const { names, from } = neededNames(here.root);
        const missing = [...names].filter((n) => !dev.has(n));
        const prodOnly = missing.filter((n) => prod.has(n));
        const detail = `this repo: ${count("dev")} for Development, ${count("prod")} for Production`;
        if (!from.length) repoItems.push({ ok: true, label: "Secrets", detail: `${detail} (no .env.example to compare with)` });
        else if (!missing.length) repoItems.push({ ok: true, label: "Secrets", detail: `${detail} · everything ${from[0]} lists is there` });
        else
          repoItems.push({
            ok: false,
            label: "Secrets",
            detail: `${detail} · ${missing.length} of ${names.size} names in ${from.length === 1 ? from[0] : `${from.length} .env examples`} missing for Development`,
            more: [
              ...(prodOnly.length ? [`only in Production: ${some(prodOnly)} → on the dashboard (Secrets), check them and add Development ${c.dim("[you]")}`] : []),
              ...(missing.length > prodOnly.length
                ? [`not in the vault: ${some(missing.filter((n) => !prod.has(n)))} → ${c.cyan("0b secret set <NAME>")} ${c.dim("[you]")} ${c.dim("(examples list optional ones too: add what the dev server asks for)")}`]
                : []),
              `run with ${c.cyan("0b exec -- <command>")}: no .env file needed`,
            ],
          });
      }
    }
  }

  const print = (title: string, items: Item[]) => {
    console.log(c.bold(title));
    for (const i of items) {
      console.log(line(i));
      for (const m of i.more ?? []) console.log(`      ${m}`);
    }
  };
  print("This machine", machine);
  if (here) {
    console.log();
    print(here.repo, repoItems);
  }
  const todo = [...machine, ...repoItems].filter((i) => !i.ok);
  console.log(
    todo.length
      ? `\n${c.dim("[agent]: safe for an AI agent to run as is. [you]: needs you (a sign-in, a key, a choice).")}`
      : `\n${c.green("✓")} All set${here ? ` for ${here.repo}` : ""}.`,
  );
}
