import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@0bridge/core";
import type { EventKind, EventData } from "./protocol.ts";

/**
 * What each task did, on this machine: one JSONL file per task in `~/.0bridge/agent/tasks/`,
 * a `meta` line first and then every event as it was sent to the hub. `0b agent log` reads them.
 * The newest 200 tasks are kept.
 */

export interface TaskMeta {
  task: string;
  agent: string;
  repo: string;
  cwd: string;
  mode: string;
  branch?: string;
  createdAt: number;
}
export interface LoggedEvent {
  seq: number;
  at: number;
  kind: EventKind;
  data: EventData;
}

const KEEP = 200;
export const tasksDir = (ctx: Context) => join(ctx.storeDir, "agent", "tasks");
const file = (ctx: Context, task: string) => join(tasksDir(ctx), `${task.replace(/[^A-Za-z0-9_-]/g, "")}.jsonl`);

function append(ctx: Context, task: string, line: object): void {
  mkdirSync(tasksDir(ctx), { recursive: true, mode: 0o700 });
  appendFileSync(file(ctx, task), JSON.stringify(line) + "\n", { mode: 0o600 });
}

export function logMeta(ctx: Context, meta: TaskMeta): void {
  append(ctx, meta.task, { meta });
  prune(ctx);
}

export const logEvent = (ctx: Context, task: string, ev: LoggedEvent) => append(ctx, task, ev);

export function readTask(ctx: Context, task: string): { meta: TaskMeta | null; events: LoggedEvent[] } | null {
  let text: string;
  try {
    text = readFileSync(file(ctx, task), "utf8");
  } catch {
    return null;
  }
  let meta: TaskMeta | null = null;
  const events: LoggedEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.meta) meta = o.meta;
      else events.push(o);
    } catch {}
  }
  return { meta, events };
}

/** Tasks newest first, with their last state. */
export function listTasks(ctx: Context): { meta: TaskMeta; state: string; updatedAt: number }[] {
  let names: string[];
  try {
    names = readdirSync(tasksDir(ctx)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return names
    .flatMap((f) => {
      const t = readTask(ctx, f.slice(0, -6));
      if (!t?.meta) return [];
      const states = t.events.filter((e) => e.data.state);
      return [{ meta: t.meta, state: states.at(-1)?.data.state ?? "starting", updatedAt: t.events.at(-1)?.at ?? t.meta.createdAt }];
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function prune(ctx: Context): void {
  try {
    const all = readdirSync(tasksDir(ctx))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, at: statSync(join(tasksDir(ctx), f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const { f } of all.slice(KEEP)) rmSync(join(tasksDir(ctx), f), { force: true });
  } catch {}
}
