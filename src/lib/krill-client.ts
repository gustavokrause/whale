// whale -> krill over HTTP (never its DB). Tolerant: surfaces errors so the
// pipeline can mark push_failed instead of crashing when krill is down.

import { config } from "./config";
import { keyToSlug } from "./context-store";

const base = () => config.krill.baseUrl.replace(/\/$/, "");

async function call(method: string, pathname: string, body?: unknown) {
  const res = await fetch(base() + pathname, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`krill ${method} ${pathname} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export type KrillProject = {
  id: string;
  slug: string;
  name: string;
  folder_path: string;
  has_repo: boolean;
};

export async function ping(): Promise<boolean> {
  try {
    await call("GET", "/api/health");
    return true;
  } catch {
    return false;
  }
}

export async function listProjects(): Promise<KrillProject[]> {
  const r = await call("GET", "/api/projects");
  return Array.isArray(r) ? r : r?.projects || [];
}

/** Project metadata for onboarding (folder_path + has_repo), resolved by key. */
export async function getProjectMeta(key: string) {
  const want = keyToSlug(key);
  const hit = (await listProjects()).find(
    (p) => p.slug === want || keyToSlug(p.name) === want,
  );
  return hit
    ? { folder_path: hit.folder_path, has_repo: hit.has_repo, name: hit.name }
    : null;
}

/** Normalized project keys from krill (so the router can pick real targets). */
export async function projectKeys(): Promise<string[]> {
  try {
    return (await listProjects()).map((p) => keyToSlug(p.name));
  } catch {
    return [];
  }
}

/** Resolve a whale project_key to a krill project id by slug/name match. */
export async function resolveProjectId(projectKey: string): Promise<string | null> {
  const want = keyToSlug(projectKey);
  const projects = await listProjects();
  const hit = projects.find((p) => p.slug === want || keyToSlug(p.name) === want);
  return hit?.id || null;
}

export type CreateTaskArgs = {
  project_id: string;
  name: string;
  description?: string;
  priority?: string;
  mode?: string;
  skip_plan_review?: boolean;
  auto_publish?: boolean;
  depends_on?: string[];
};

/** Create a BACKLOG task. skip_plan_review carries whale's bypass decision. */
export async function createTask(args: CreateTaskArgs) {
  return call("POST", "/api/tasks", {
    project_id: args.project_id,
    name: args.name,
    description: args.description,
    priority: args.priority,
    mode: args.mode,
    skip_plan_review: !!args.skip_plan_review,
    auto_publish: !!args.auto_publish,
    depends_on: Array.isArray(args.depends_on) ? args.depends_on : [],
  });
}

export async function patchTask(id: string, fields: Record<string, unknown>) {
  return call("PATCH", `/api/tasks/${id}`, fields);
}
