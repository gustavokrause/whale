// whale -> krill over HTTP (never its DB). Tolerant: surfaces errors so the
// pipeline can mark push_failed instead of crashing when krill is down.

import { config } from "./config";
import { keyToSlug } from "./context-store";

const base = () => config.krill.baseUrl.replace(/\/$/, "");

async function call(method: string, pathname: string, body?: unknown, timeoutMs = 15000) {
  // Always bound the request: a krill that is down refuses fast, but one that
  // is restarting can accept the socket and never respond — without a timeout
  // that hangs the caller forever (e.g. /api/status stuck on "connecting…").
  const res = await fetch(base() + pathname, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
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
  allow_auto_finish?: boolean;
};

export async function ping(): Promise<boolean> {
  try {
    await call("GET", "/api/health", undefined, 2500);
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

/** Fetch one krill project (incl. allow_auto_finish). Tolerant: null on error. */
export async function getProject(id: string): Promise<KrillProject | null> {
  try {
    const r = await call("GET", `/api/projects/${id}`);
    return r?.project || r || null;
  } catch {
    return null;
  }
}

export type CreateTaskArgs = {
  project_id: string;
  name: string;
  description?: string;
  priority?: string;
  mode?: string;
  skip_plan?: boolean;
  skip_plan_review?: boolean;
  skip_ai_review?: boolean;
  // undefined = let krill apply its mode default (dev verifies, non-dev skips);
  // true/false = explicit override.
  skip_verify?: boolean;
  auto_publish?: boolean;
  depends_on?: string[];
  acceptance?: string | null;
};

/** Create a BACKLOG task. skip_plan_review carries whale's bypass decision. */
export async function createTask(args: CreateTaskArgs) {
  return call("POST", "/api/tasks", {
    project_id: args.project_id,
    name: args.name,
    description: args.description,
    priority: args.priority,
    mode: args.mode,
    skip_plan: !!args.skip_plan,
    skip_plan_review: !!args.skip_plan_review,
    skip_ai_review: !!args.skip_ai_review,
    // Only send when explicit — omitting lets krill's POST route default by mode.
    ...(args.skip_verify === undefined ? {} : { skip_verify: !!args.skip_verify }),
    auto_publish: !!args.auto_publish,
    depends_on: Array.isArray(args.depends_on) ? args.depends_on : [],
    // Definition-of-done for krill's VERIFYING stage (null when not authored).
    acceptance: args.acceptance ?? null,
  });
}

export async function patchTask(id: string, fields: Record<string, unknown>) {
  return call("PATCH", `/api/tasks/${id}`, fields);
}

export type KrillFollowup = {
  id: string;
  task_id: string | null;
  project_slug: string;
  project_name: string;
  title: string;
  description: string;
};

/** Open follow-ups krill's stages flagged, for whale to ingest. Tolerant: []. */
export async function listFollowups(): Promise<KrillFollowup[]> {
  try {
    const r = await call("GET", "/api/followups");
    return Array.isArray(r) ? r : r?.followups || [];
  } catch {
    return [];
  }
}

export async function consumeFollowup(id: string): Promise<void> {
  await call("POST", `/api/followups/${id}/consume`);
}

/** All krill tasks (id + status), for plan-time in-flight awareness. Tolerant: []. */
export async function listTasks(): Promise<{ id: string; status?: string }[]> {
  try {
    const r = await call("GET", "/api/tasks");
    return Array.isArray(r) ? r : r?.tasks || [];
  } catch {
    return [];
  }
}

/** Fetch a krill task (for status sync-back). Tolerant: null if missing/unreachable. */
export async function getTask(id: string): Promise<{ status?: string } | null> {
  try {
    const r = await call("GET", `/api/tasks/${id}`);
    return r?.task || r || null;
  } catch {
    return null;
  }
}
