/**
 * Tarsa-managed projects: cwds the user explicitly opened or created via the
 * `+ terminal` flow. Persisted in localStorage so the sidebar list survives
 * reloads. Distinct from CC sessions auto-discovered from hook events — a
 * project may exist without any session and vice versa.
 */

export interface Project {
  cwd: string;
  name: string;
  /** ms since epoch — used for sort order in the sidebar. */
  addedAt: number;
}

const KEY = "tarsa.projects.v1";

export function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (p): p is Project =>
        p &&
        typeof p === "object" &&
        typeof (p as Project).cwd === "string" &&
        typeof (p as Project).name === "string"
    );
  } catch {
    return [];
  }
}

function save(projects: Project[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(projects));
  } catch {
    /* quota or disabled — non-fatal */
  }
}

export function addProject(prev: Project[], p: { cwd: string; name: string }): Project[] {
  // De-dup by cwd; if it exists, refresh addedAt so it floats to the top.
  const next = prev.filter((x) => x.cwd !== p.cwd);
  next.unshift({ cwd: p.cwd, name: p.name, addedAt: Date.now() });
  save(next);
  return next;
}

export function removeProject(prev: Project[], cwd: string): Project[] {
  const next = prev.filter((p) => p.cwd !== cwd);
  save(next);
  return next;
}
