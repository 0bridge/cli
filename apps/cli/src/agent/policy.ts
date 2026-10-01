import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readJson, writeAtomic, type Context } from "@0bridge/core";

/**
 * What coding agents may do on this machine, in `~/.0bridge/agent.json`: nothing until the
 * user turns it on and allows a repo. Each allowed repo has a mode (plan, edit or auto; never more
 * than the user set here, whatever a request asks), runs each task in its own git worktree by
 * default, and refuses the commands below outright (push to main, force push, merge, deploy,
 * publish), on top of the repo's own rules.
 */

export type Mode = "plan" | "edit" | "auto";
export const MODES: Mode[] = ["plan", "edit", "auto"];
export type AgentId = "claude" | "codex" | "gemini";
export const AGENT_IDS: AgentId[] = ["claude", "codex", "gemini"];

export interface RepoPolicy {
  /** Absolute path; tasks run here or in a subfolder (or in a worktree of it). */
  root: string;
  /** Agents allowed here; unset: all. */
  agents?: AgentId[];
  mode: Mode;
  /** Each task in its own worktree on branch 0b/<task>. */
  worktree: boolean;
  /** Command globs refused here, in addition to DEFAULT_DENY. */
  deny: string[];
  /** Let the tmux adapter type into terminal sessions in this repo. */
  keys?: boolean;
}

export interface AgentConfig {
  enabled: boolean;
  repos: RepoPolicy[];
  /** Named accounts per agent (K13): a task can start under one; never picked automatically. */
  profiles?: { claude?: Record<string, { CLAUDE_CONFIG_DIR: string }>; codex?: Record<string, { CODEX_HOME: string }> };
}

/**
 * Refused in every repo, whatever its own rules or mode say: `*` is any text (a `*` right after a
 * `/` stays within one path segment), and a rule also matches with more arguments after it.
 * Commands are matched as commandParts() spells them: a `git push` names the branches it pushes
 * to (`HEAD:refs/heads/main` is `main`, `+feature` is `--force feature`), and a push that names
 * none pushes `HEAD`, which is the task's own branch when the daemon knows it and refused otherwise.
 */
export const DEFAULT_DENY = [
  "git push * main",
  "git push * master",
  "git push *:main",
  "git push *:master",
  "git push * HEAD",
  "git push *--all*",
  "git push *--mirror*",
  "git push --force*",
  "git push -f*",
  "git push * --force*",
  "git push * -f",
  "git push * +*",
  "git merge*",
  "gh pr merge*",
  "gh api *pulls/*/merge*",
  "gh api graphql*mergePullRequest*",
  "gh release create*",
  "wrangler deploy*",
  "wrangler publish*",
  "wrangler versions deploy*",
  "vercel --prod*",
  "vercel deploy --prod*",
  "vercel * --prod*",
  "fly deploy*",
  "flyctl deploy*",
  "npm publish*",
  "bun publish*",
  "pnpm publish*",
  "yarn publish*",
  "yarn npm publish*",
  "cargo publish*",
  "npm run deploy*",
  "bun run deploy*",
  "pnpm run deploy*",
  "pnpm deploy*",
  "yarn deploy*",
  "yarn run deploy*",
  "rm -rf /*",
  "rm -fr /*",
  "rm -rf ~",
  "rm -rf ~/",
  "rm -rf $HOME",
];

const configPath = (ctx: Context) => join(ctx.storeDir, "agent.json");

export function loadAgentConfig(ctx: Context): AgentConfig {
  const cfg = readJson<Partial<AgentConfig>>(configPath(ctx));
  return {
    enabled: cfg?.enabled === true,
    repos: (cfg?.repos ?? []).map((r) => ({ ...r, mode: MODES.includes(r.mode) ? r.mode : "edit", worktree: r.worktree !== false, deny: Array.isArray(r.deny) ? r.deny : [] })),
    ...(cfg?.profiles ? { profiles: cfg.profiles } : {}),
  };
}

export function saveAgentConfig(ctx: Context, cfg: AgentConfig): void {
  writeAtomic(configPath(ctx), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/**
 * `p` resolved, symlinks followed, and on Windows with its long names: the native realpath turns
 * an 8.3 name (C:\Users\RUNNER~1, as %TEMP% often is) into the one git and the shell report.
 */
export function realPath(p: string): string {
  try {
    return realpathSync.native(resolve(p));
  } catch {
    return resolve(p);
  }
}
const real = realPath;
const fold = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);

/** `path` is `root` or inside it. */
export function inside(root: string, path: string): boolean {
  const r = fold(real(root));
  const p = fold(real(path));
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** The allowed repo `path` is in (the innermost one), or null: agents never run anywhere else. */
export function repoFor(cfg: AgentConfig, path: string): RepoPolicy | null {
  const hits = cfg.repos.filter((r) => inside(r.root, path));
  return hits.sort((a, b) => b.root.length - a.root.length)[0] ?? null;
}

/** Why `path` can't be allowed as a repo (too broad), or null. */
export function tooBroad(ctx: Context, path: string): string | null {
  const p = real(path);
  for (const [what, dir] of [
    ["your home folder", ctx.home],
    ["your home folder", homedir()],
    ["0bridge's own folder", ctx.storeDir],
  ] as const) {
    if (inside(p, dir)) return `${p} contains ${what}; allow a repo instead`;
    if (what === "0bridge's own folder" && inside(dir, p)) return `${p} is inside 0bridge's own folder`;
  }
  return null;
}

/** The mode a task gets: what it asked for, never more than the repo allows. */
export function clampMode(asked: string | undefined, allowed: Mode): Mode {
  const want = MODES.includes(asked as Mode) ? (asked as Mode) : allowed;
  return MODES.indexOf(want) <= MODES.indexOf(allowed) ? want : allowed;
}

/** The environment of a named account (`profiles` in agent.json); throws for an unknown one. */
export function profileEnv(cfg: AgentConfig, agent: string, name: string | undefined): Record<string, string> {
  if (!name) return {};
  const p = (cfg.profiles as Record<string, Record<string, Record<string, string>>> | undefined)?.[agent]?.[name];
  if (!p) throw new Error(`no ${agent} profile "${name}" on this machine (agent.json profiles)`);
  return { ...p };
}

// ── Command rules ─────────────

/**
 * The words of each simple command in a shell line (quotes removed), split at ; && || | & and
 * subshells. `head`: the branch checked out where it runs, when known (a task's own worktree).
 */
export function commandParts(cmd: string, head?: string): string[][] {
  const parts: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quoted = false;
  const endWord = () => {
    if (word || quoted) words.push(word);
    word = "";
    quoted = false;
  };
  const endPart = () => {
    endWord();
    if (words.length) parts.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === "'") {
      const j = cmd.indexOf("'", i + 1);
      word += cmd.slice(i + 1, j < 0 ? cmd.length : j);
      quoted = true;
      i = j < 0 ? cmd.length : j;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) word += cmd[j] === "\\" && j + 1 < cmd.length ? cmd[++j] : cmd[j];
      quoted = true;
      i = j;
    } else if (ch === "\\" && i + 1 < cmd.length) word += cmd[++i];
    else if (/\s/.test(ch)) ch === "\n" ? endPart() : endWord();
    else if (";&|()`".includes(ch)) endPart();
    else if (ch === "$" && cmd[i + 1] === "(") {
      endPart();
      i++;
    } else word += ch;
  }
  endPart();
  return parts.flatMap((w) => unwrap(w, head));
}

const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "nice", "npx", "bunx", "pnpx", "doas", "xargs"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);

/** Drop what only wraps a command (sudo, env, VAR=x, npx, 0b exec --, git -C dir) and look inside sh -c and eval. */
function unwrap(words: string[], head?: string): string[][] {
  let w = [...words];
  for (let guard = 0; guard < 20 && w.length; guard++) {
    const [first, second] = [w[0]!, w[1]];
    const base = first.split(/[\\/]/).pop()!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) w = w.slice(1);
    else if (WRAPPERS.has(base)) {
      w = w.slice(1);
      while (w[0]?.startsWith("-")) w = w.slice(1);
    } else if ((base === "0b" || base === "0bridge") && second === "exec") w = w.slice(w.indexOf("--") >= 0 ? w.indexOf("--") + 1 : 2);
    else if ((base === "pnpm" || base === "yarn") && (second === "dlx" || second === "exec")) w = w.slice(2);
    else if (base === "npm" && second === "exec") w = w.slice(w.indexOf("--") >= 0 ? w.indexOf("--") + 1 : 2);
    else if (SHELLS.has(base) && w.includes("-c")) return commandParts(w[w.indexOf("-c") + 1] ?? "", head);
    else if (base === "eval") return commandParts(w.slice(1).join(" "), head);
    else break;
  }
  if (!w.length) return [];
  // The command's name: no folder, no version (npx wrangler@latest, bunx @scope/tool@2).
  w[0] = w[0]!.split(/[\\/]/).pop()!.replace(/^([^@]+)@.*$/, "$1");
  if (w[0] === "git") {
    // git's own options come before the subcommand: git -C dir -c k=v --no-pager push …
    let i = 1;
    while (i < w.length && w[i]!.startsWith("-")) i += w[i] === "-C" || w[i] === "-c" ? 2 : 1;
    w = ["git", ...w.slice(i)];
    if (w[1] === "push") w = pushWords(w, head);
  }
  return [w];
}

const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/**
 * `git push` as the branches it pushes to, which is what the rules look at: each refspec's
 * destination without refs/heads/ (`HEAD:refs/heads/main` → `main`, `:main` deletes `main`), a
 * leading `+` as --force, and no refspec at all as `head` (the current branch, `HEAD` if unknown).
 */
function pushWords(w: string[], head = "HEAD"): string[] {
  const opts: string[] = [];
  const pos: string[] = [];
  for (let i = 2; i < w.length; i++) {
    const a = w[i]!;
    if (a === "--") {
      pos.push(...w.slice(i + 1));
      break;
    }
    if (a.startsWith("-")) {
      opts.push(a);
      if (PUSH_VALUE_OPTIONS.has(a) && i + 1 < w.length) opts.push(w[++i]!);
    } else pos.push(a);
  }
  const [remote = "origin", ...specs] = pos;
  const dsts = (specs.length ? specs : ["HEAD"]).map((spec) => {
    let ref = spec;
    if (ref.startsWith("+")) {
      opts.push("--force");
      ref = ref.slice(1);
    }
    if (ref.includes(":")) ref = ref.slice(ref.lastIndexOf(":") + 1) || ref;
    ref = ref.replace(/^refs\/heads\//, "");
    return ref === "HEAD" ? head : ref;
  });
  return ["git", "push", ...opts, remote, ...dsts];
}

const globRe = new Map<string, RegExp>();
function compile(glob: string): RegExp {
  let re = globRe.get(glob);
  if (re) return re;
  const words = glob.trim().split(/\s+/).join(" ");
  let src = "";
  for (let i = 0; i < words.length; i++) {
    const ch = words[i]!;
    if (ch === "*") src += words[i - 1] === "/" ? "[^/ ]*" : ".*";
    else src += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  re = new RegExp(`^${src}(?: .*)?$`);
  globRe.set(glob, re);
  return re;
}

/** Whether one command (already split into words) matches a rule. */
export function matchGlob(glob: string, words: string[] | string): boolean {
  return compile(glob).test(Array.isArray(words) ? words.join(" ") : words.trim().split(/\s+/).join(" "));
}

/**
 * The rule that refuses `command` (a shell line), or null. Every simple command in it is checked.
 * `head`: the branch checked out where it runs, when known (a push that names no branch pushes it).
 */
export function deniedBy(deny: string[], command: string, head?: string): string | null {
  for (const words of commandParts(command, head)) for (const rule of deny) if (matchGlob(rule, words)) return rule;
  return null;
}

export const denyRules = (repo: RepoPolicy | null) => [...DEFAULT_DENY, ...(repo?.deny ?? [])];
