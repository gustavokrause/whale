// whale — orchestration + gates/dials. Ties the stages to krill, enforces the
// human gates (new-project always gated; high-risk never auto-pushes).

import { homedir } from "node:os";
import { config } from "./config";
import {
  getProposed, updateProposed, projectKeys, setEntryLane, rawEntries, listProposed, getEntry,
} from "@/db/queries";
import { distill, plan, route, triage, refineProposal, flowPreview } from "./stages";
import { auditComplete } from "./runner";
import { writeContext } from "./context-store";
import * as krill from "./krill-client";
import type { Team } from "./persona-loader";
import type { ProposedTask } from "@/db/schema";

const expandHome = (p: string) => (p?.startsWith("~") ? p.replace(/^~/, homedir()) : p);

/** Onboarding (B5): make whale aware of a project via a read-only audit, or flag seed-needed. */
export async function onboard(team: Team, key: string) {
  const meta = await krill.getProjectMeta(key);
  if (!meta) return { ok: false, needsSeed: true, note: `"${key}" not found in krill — seed its CONTEXT by hand (idea project)` };
  if (!meta.has_repo) return { ok: false, needsSeed: true, note: `"${key}" has no repo — seed its CONTEXT by hand` };

  const caio = team.personas.find((p) => p.name === "Caio");
  const system =
    `${caio?.systemPrompt || ""}\n\nYou are onboarding the project "${key}". Read the codebase ` +
    `(read-only) and produce its CONTEXT.md. Be concrete and accurate — this becomes whale's memory ` +
    `of the project.\nOUTPUT CONTRACT: return ONLY the markdown, starting with "# CONTEXT — ${key}". ` +
    `Sections: Goals, Stack, Structure, Current state, Open questions. No preamble, no code fences.`;
  const user = `Audit the repository in the working directory and output the full CONTEXT.md.`;
  const md = await auditComplete({ system, user, model: config.models.plan, cwd: expandHome(meta.folder_path) });
  writeContext(key, md);
  return { ok: true, key, chars: md.length };
}

export async function distillAll(team: Team) {
  await autoRouteUntagged(team);
  return distill(team);
}

// Route raw entries that have no project yet, so a clearly-about-X dump lands in X.
async function autoRouteUntagged(team: Team) {
  const untagged = rawEntries().filter((e) => !(e.project_hint || "").trim() && !e.lane);
  if (!untagged.length) return;
  const keys = await knownKeys();
  for (const e of untagged) {
    try {
      const r = await route(team, e, keys);
      setEntryLane(e.id, { lane: r.dest, projectHint: r.dest === "task" ? r.projectKey || null : null });
    } catch {
      /* leave for manual routing */
    }
  }
}

/** Real project targets the router can pick from: whale's own keys + krill's. */
async function knownKeys(): Promise<string[]> {
  return [...new Set([...projectKeys(), ...(await krill.projectKeys())])];
}

/** Move a proposed task to a different project and re-triage it. */
export function reassign(team: Team, id: string, projectKey: string): ProposedTask {
  const t = getProposed(id);
  if (!t) throw new Error("proposed task not found");
  const tri = triage(team, { name: t.name, description: t.description, project_key: projectKey });
  return updateProposed(id, {
    project_key: projectKey,
    risk_tier: tri.risk_tier,
    bypass: tri.bypass,
    priority: tri.priority,
    mode: tri.mode,
    rationale: tri.rationale,
    status: "proposed",
    push_error: null,
  });
}

export const planProject = (team: Team, key: string) => plan(team, key);

export async function routeEntry(team: Team, entryId: string) {
  const e = getEntry(entryId);
  if (!e) throw new Error("entry not found");
  const r = await route(team, e, await knownKeys());
  const entry = setEntryLane(entryId, { lane: r.dest, projectHint: r.projectKey || null });
  if (r.dest === "new_project") {
    return { ...r, lane: r.dest, entry, gated: true, note: "held — review and create the krill project yourself before this becomes work" };
  }
  return { ...r, lane: r.dest, entry };
}

/** Batch push (B2): push pushable tasks for a project in dependency order. */
export async function pushBatch(team: Team, projectKey: string, { confirm = false }: { confirm?: boolean } = {}) {
  void team;
  if ((projectKey || "").toLowerCase() === "global")
    return { ok: false, error: "'global' is not a project — reassign tasks first" };

  const items = listProposed().filter(
    (t) => t.project_key === projectKey && ["proposed", "approved", "push_failed"].includes(t.status),
  );
  if (!items.length) return { ok: true, pushed: 0, results: [] };

  const autoFin = items.filter((t) => t.auto_publish && t.risk_tier === "low");
  if (autoFin.length && !confirm) {
    return {
      ok: false,
      needsConfirm: true,
      autoFinish: autoFin.length,
      message: `${autoFin.length} of ${items.length} task(s) will run to DONE unattended (auto-merge, no review). Re-confirm to arm.`,
    };
  }

  if (!(await krill.ping())) return { ok: false, error: "krill unreachable" };
  const projectId = await krill.resolveProjectId(projectKey);
  if (!projectId) return { ok: false, error: `no krill project for "${projectKey}" (create it first)` };

  const byName = new Map(items.map((t) => [t.name, t]));
  const ordered = topoByDeps(items, byName);
  const nameToId: Record<string, string | null> = {};
  const results: { name: string; id?: string | null; depends_on?: string[]; error?: string }[] = [];
  for (const t of ordered) {
    const depIds = (JSON.parse(t.deps || "[]") as string[]).map((n) => nameToId[n]).filter(Boolean) as string[];
    try {
      const created = await krill.createTask({
        project_id: projectId,
        name: t.name, description: t.description, priority: t.priority, mode: t.mode,
        skip_plan_review: t.bypass && t.risk_tier !== "high",
        auto_publish: !!t.auto_publish && t.risk_tier === "low",
        depends_on: depIds,
      });
      const kid = created?.task?.id || created?.id || null;
      nameToId[t.name] = kid;
      updateProposed(t.id, { status: "pushed", krill_task_id: kid, push_error: null });
      results.push({ name: t.name, id: kid, depends_on: depIds });
    } catch (err) {
      updateProposed(t.id, { status: "push_failed", push_error: (err as Error).message });
      results.push({ name: t.name, error: (err as Error).message });
    }
  }
  return { ok: true, pushed: results.filter((r) => r.id).length, total: items.length, results };
}

function topoByDeps(items: ProposedTask[], byName: Map<string, ProposedTask>): ProposedTask[] {
  const visited = new Set<string>();
  const out: ProposedTask[] = [];
  const visit = (t: ProposedTask) => {
    if (visited.has(t.name)) return;
    visited.add(t.name);
    for (const d of JSON.parse(t.deps || "[]") as string[]) {
      const dep = byName.get(d);
      if (dep) visit(dep);
    }
    out.push(t);
  };
  for (const t of items) visit(t);
  return out;
}

export async function approve(team: Team, id: string) {
  void team;
  let t = getProposed(id);
  if (!t) throw new Error("proposed task not found");
  t = updateProposed(id, { status: "approved" });
  if (config.autonomy.autoPush) return push(id, { confirm: true });
  return { task: t, pushed: false, note: "approved; auto-push off — push manually" };
}

export function reject(id: string) {
  return updateProposed(id, { status: "rejected" });
}

/** Refine a proposed task from user Input (B3). */
export async function refine(team: Team, id: string, input: string) {
  const t = getProposed(id);
  if (!t) throw new Error("proposed task not found");
  const r = await refineProposal(team, t, input);
  const tri = triage(team, { name: r.name, description: r.description, project_key: t.project_key });
  const log = JSON.parse(t.refine_log || "[]") as { input: string; at: number }[];
  log.push({ input, at: Date.now() });
  const updated = updateProposed(id, {
    name: r.name,
    description: r.description || "",
    priority: r.priority || tri.priority,
    mode: r.mode || tri.mode,
    risk_tier: tri.risk_tier,
    bypass: tri.bypass,
    auto_publish: tri.auto_publish,
    deps: JSON.stringify(Array.isArray(r.depends_on) ? r.depends_on : JSON.parse(t.deps || "[]")),
    rationale: tri.rationale,
    refine_log: JSON.stringify(log),
    status: "proposed",
  });
  return { task: updated, flow: flowPreview(updated) };
}

export const previewFlow = flowPreview;

export type EnrichedProposed = ProposedTask & { krill_status?: string | null };

/**
 * Gap A — krill→whale status sync. whale is otherwise fire-and-forget; this reads
 * back the live krill task status for pushed tasks so the Proposed tab isn't stale
 * (e.g. a task that's already DONE in krill). Read-only, over HTTP. No-op if krill
 * is unreachable.
 */
export async function enrichPushed(items: ProposedTask[]): Promise<EnrichedProposed[]> {
  if (!(await krill.ping())) return items;
  const out: EnrichedProposed[] = [];
  for (const t of items) {
    if (t.krill_task_id && (t.status === "pushed" || t.status === "push_failed")) {
      const kt = await krill.getTask(t.krill_task_id);
      out.push({ ...t, krill_status: kt?.status ?? null });
    } else {
      out.push(t);
    }
  }
  return out;
}

/** Push an approved task to krill. High-risk tasks are never silently bypassed. */
export async function push(id: string, { confirm = false }: { confirm?: boolean } = {}) {
  const t = getProposed(id);
  if (!t) throw new Error("proposed task not found");
  if (t.auto_publish && t.risk_tier === "low" && !confirm) {
    return { task: t, pushed: false, needsConfirm: true, message: "This task auto-finishes (auto-merge to main, no review). Re-confirm to arm." };
  }
  if (!(await krill.ping())) {
    const f = updateProposed(id, { status: "push_failed", push_error: "krill unreachable" });
    return { task: f, pushed: false, error: "krill unreachable" };
  }
  if ((t.project_key || "").toLowerCase() === "global") {
    const f = updateProposed(id, {
      status: "push_failed",
      push_error: `"global" is a cross-cutting bucket, not a project — reassign this task to a real project before pushing`,
    });
    return { task: f, pushed: false, error: f.push_error };
  }
  try {
    const projectId = await krill.resolveProjectId(t.project_key);
    if (!projectId) {
      const f = updateProposed(id, {
        status: "push_failed",
        push_error: `no krill project for "${t.project_key}" (create it first — gated)`,
      });
      return { task: f, pushed: false, error: f.push_error };
    }
    const created = await krill.createTask({
      project_id: projectId,
      name: t.name,
      description: t.description,
      priority: t.priority,
      mode: t.mode,
      skip_plan_review: t.bypass && t.risk_tier !== "high",
      auto_publish: !!t.auto_publish && t.risk_tier === "low",
    });
    const done = updateProposed(id, { status: "pushed", krill_task_id: created?.id || created?.task?.id || null });
    return { task: done, pushed: true, krill: created };
  } catch (err) {
    const f = updateProposed(id, { status: "push_failed", push_error: (err as Error).message });
    return { task: f, pushed: false, error: (err as Error).message };
  }
}
