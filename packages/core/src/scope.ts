// No imports: the web dashboard bundles this for the browser.

/**
 * Where a connection can be used. `projects` limits it to those projects (empty: everywhere);
 * `hidden` keeps an everywhere connection out of some projects (another company's account in
 * this repo), without taking it away from anywhere else.
 */
export interface Scoped {
  projects: string[];
  hidden?: string[];
}

/**
 * Whether agents at an endpoint see a connection: the global endpoint (no project) sees the
 * everywhere ones; a project's sees its own, plus the everywhere ones it doesn't hide unless strict.
 */
export function seenIn(c: Scoped, project?: { id: string; strict?: boolean } | null): boolean {
  if (!project) return !c.projects.length;
  if (c.projects.length) return c.projects.includes(project.id);
  return !project.strict && !(c.hidden ?? []).includes(project.id);
}
