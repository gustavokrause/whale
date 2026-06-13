// baleia -> krill over HTTP (never its DB). Tolerant: surfaces errors so the
// pipeline can mark push_failed instead of crashing when krill is down.

import { config } from "./config.mjs";
import { keyToSlug } from "./context-store.mjs";

const base = () => config.krill.baseUrl.replace(/\/$/, "");

async function call(method, pathname, body) {
  const res = await fetch(base() + pathname, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`krill ${method} ${pathname} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export async function ping() {
  try {
    await call("GET", "/api/health");
    return true;
  } catch {
    return false;
  }
}

export async function listProjects() {
  const r = await call("GET", "/api/projects");
  return Array.isArray(r) ? r : r?.projects || [];
}

/** Normalized project keys from krill (so the router can pick real targets). */
export async function projectKeys() {
  try {
    return (await listProjects()).map((p) => keyToSlug(p.name));
  } catch {
    return [];
  }
}

/** Resolve a baleia project_key to a krill project id by slug/name match. */
export async function resolveProjectId(projectKey) {
  const want = keyToSlug(projectKey);
  const projects = await listProjects();
  const hit = projects.find(
    (p) => p.slug === want || keyToSlug(p.name) === want
  );
  return hit?.id || null;
}

/** Create a BACKLOG task. skip_plan_review carries baleia's bypass decision. */
export async function createTask({ project_id, name, description, priority, mode, skip_plan_review }) {
  return call("POST", "/api/tasks", {
    project_id,
    name,
    description,
    priority,
    mode,
    skip_plan_review: !!skip_plan_review,
  });
}

export async function patchTask(id, fields) {
  return call("PATCH", `/api/tasks/${id}`, fields);
}
