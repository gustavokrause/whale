// whale — orchestration + gates/dials. Ties the stages to krill, enforces the
// human gates (new-project always gated; high-risk never auto-pushes).

import { homedir } from "node:os";
import { config, isReal } from "./config";
import {
  getProposed, updateProposed, projectKeys, setEntryLane, listProposed, getEntry,
} from "@/db/queries";
import { plan, route, triage, refineProposal, flowPreview, canonicalizeProjectDeps } from "./stages";
import { auditComplete } from "./runner";
import {
  writeContext, listContextKeys, readContext, keyToSlug,
  writeContextMeta, readContextMeta, gitHead, commitsSince,
} from "./context-store";
import * as krill from "./krill-client";
import type { Team } from "./persona-loader";
import type { ProposedTask } from "@/db/schema";

const expandHome = (p: string) => (p?.startsWith("~") ? p.replace(/^~/, homedir()) : p);

// Self-edit floor: protected projects (whale/krill + env) never auto/bypass at
// push, even if triage said so — defense in depth for the runaway-loop guard.
const isProtected = (key?: string | null) =>
  config.autonomy.protected.includes((key || "").toLowerCase());

// Single source of truth for the krill create payload — used by BOTH the single
// and group push paths so the two can't drift (the exact gap that let group push
// silently drop skip-plan-review). The self-edit guard is enforced HERE, last:
// protected (whale/krill) tasks can never skip planning (skip_plan) or auto-finish
// (auto_publish) — planning always runs and the deliverable always gets a human
// review before merge. skip_plan_review (skip the plan-review step), skip_ai_review,
// and skip_verify are opt-in even for self-edits — the deliverable gate still holds.
function buildCreateArgs(
  t: ProposedTask,
  projectId: string,
  depIds: string[],
  medians: Record<string, number> = {},
): krill.CreateTaskArgs {
  const prot = isProtected(t.project_key);
  const args: krill.CreateTaskArgs = {
    project_id: projectId,
    name: t.name,
    description: t.description,
    priority: t.priority,
    mode: t.mode,
    skip_plan: !!t.skip_plan && !prot,
    skip_plan_review: !!t.bypass,
    skip_ai_review: !!t.skip_ai_review,
    skip_verify: t.skip_verify == null ? undefined : !!t.skip_verify,
    auto_publish: !!t.auto_publish && !prot,
    depends_on: depIds,
    acceptance: t.acceptance ?? null,
  };
  args.est_tokens = estimateTokens(args, medians);
  return args;
}

// Sum the krill stage medians for the stages this task will actually run, given
// its resolved flags. Mirrors krill's POST defaulting (skip_verify omitted ⇒
// dev verifies, non-dev skips). Returns null when there's no median data yet (a
// fresh fleet) so the board shows "no estimate" instead of a misleading 0.
function estimateTokens(
  a: krill.CreateTaskArgs,
  medians: Record<string, number>,
): number | null {
  const m = (s: string) => medians[s] ?? 0;
  let est = 0;
  if (!a.skip_plan) est += m("planning");
  est += m("implementing"); // always runs
  if (!a.skip_ai_review) est += m("ai_review");
  const verifies = a.skip_verify === undefined ? a.mode === "dev" : !a.skip_verify;
  if (verifies) est += m("verify");
  est += m("publishing"); // always runs
  return est > 0 ? est : null;
}

// Warn (don't patch): tasks armed for auto-finish are inert in krill unless the
// project has allow_auto_finish ON. Surface it so the human flips it in krill.
async function autoFinishWarning(
  projectId: string,
  projectKey: string,
  count: number,
): Promise<string | undefined> {
  const proj = await krill.getProject(projectId);
  if (proj && proj.allow_auto_finish === false) {
    return `${count} task(s) armed for auto-finish, but krill project "${projectKey}" has allow_auto_finish OFF — they'll stop at deliverable review instead of running unattended. Enable it on the project in krill.`;
  }
  return undefined;
}

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
  const folder = expandHome(meta.folder_path);
  const md = await auditComplete({ system, user, model: config.models.plan, cwd: folder });
  writeContext(key, md);
  // Record the HEAD we audited against, so we can flag drift later.
  writeContextMeta(key, { head: gitHead(folder), at: Date.now() });
  return { ok: true, key, chars: md.length };
}

/** Real project targets the router can pick from: whale's own keys + krill's. */
async function knownKeys(): Promise<string[]> {
  return [...new Set([...projectKeys(), ...(await krill.projectKeys())])];
}

/** Known project keys for the UI's project picker: krill projects + onboarded contexts. */
export async function knownProjects(): Promise<string[]> {
  return [...new Set([...(await krill.projectKeys()), ...listContextKeys()])].sort();
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

/**
 * Plan a project. Auto-derives context on first plan: if a real-runner project
 * has no cached context yet, run the audit once (cached after) so strategy is
 * grounded without a manual onboard step. Best-effort — idea projects (no repo)
 * just return needsSeed and we plan blind. Stub mode never audits.
 */
export async function planProject(
  team: Team,
  key: string,
  report?: (text: string) => void,
): Promise<ProposedTask[]> {
  if (isReal() && !readContext(key)) {
    report?.("Onboarding project (reading repo)…");
    await onboard(team, key).catch(() => {});
  }
  return plan(team, key, report);
}

/**
 * Staleness per onboarded context: how many commits the repo has moved since the
 * audit. Read-only, tolerant — krill down or non-git repos just drop out of the map.
 * Powers the "context stale — re-audit" hint in the UI.
 */
export async function contextStatus(): Promise<Record<string, { behind: number }>> {
  const keys = listContextKeys();
  if (!keys.length) return {};
  const projects = await krill.listProjects().catch(() => []);
  const byKey = new Map(projects.map((p) => [keyToSlug(p.name), p]));
  const out: Record<string, { behind: number }> = {};
  for (const k of keys) {
    const p = byKey.get(keyToSlug(k));
    if (!p?.has_repo) continue;
    const head = readContextMeta(k).head;
    if (!head) continue;
    out[k] = { behind: commitsSince(expandHome(p.folder_path), head) };
  }
  return out;
}

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

/** Batch push (B2): push all pushable tasks for a project in dependency order. */
export async function pushBatch(team: Team, projectKey: string, { confirm = false }: { confirm?: boolean } = {}) {
  void team;
  const items = listProposed().filter(
    (t) => t.project_key === projectKey && !t.disabled && ["proposed", "approved", "push_failed"].includes(t.status),
  );
  return pushItems(projectKey, items, { confirm });
}

/** Group push: push one dump's tasks (a plan run's source_entry_id), dep-ordered. */
export async function pushGroup(
  projectKey: string,
  sourceEntryId: string,
  { confirm = false }: { confirm?: boolean } = {},
) {
  const items = listProposed().filter(
    (t) =>
      t.project_key === projectKey &&
      t.source_entry_id === sourceEntryId &&
      !t.disabled &&
      ["proposed", "approved", "push_failed"].includes(t.status),
  );
  return pushItems(projectKey, items, { confirm });
}

// Push a set of proposed tasks, dependency-ordered. Deps resolve against this
// batch AND any already-pushed sibling (by name → krill_task_id), so cross-dump
// deps hold when the upstream was pushed earlier; unresolved ones are warned.
async function pushItems(
  projectKey: string,
  items: ProposedTask[],
  { confirm = false }: { confirm?: boolean } = {},
) {
  if ((projectKey || "").toLowerCase() === "global")
    return { ok: false, error: "'global' is not a project — reassign tasks first" };
  if (!items.length) return { ok: true, pushed: 0, results: [] };

  const autoFin = items.filter((t) => t.auto_publish && !isProtected(t.project_key));
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
  const warning = autoFin.length
    ? await autoFinishWarning(projectId, projectKey, autoFin.length)
    : undefined;

  // Already-pushed siblings in this project (for cross-batch/dump dep resolution).
  const pushedByName = new Map(
    listProposed()
      .filter((t) => t.project_key === projectKey && t.krill_task_id)
      .map((t) => [t.name, t.krill_task_id as string]),
  );

  const byName = new Map(items.map((t) => [t.name, t]));
  const ordered = topoByDeps(items, byName);
  const nameToId: Record<string, string> = {};
  const results: { name: string; id?: string | null; depends_on?: string[]; error?: string; deferred?: boolean; blockedBy?: string[] }[] = [];
  const deferredNames = new Set<string>();
  // Fetch krill's stage medians once for the whole batch (tolerant: {} on error).
  const medians = await krill.getUsageMedians();
  for (const t of ordered) {
    const deps = JSON.parse(t.deps || "[]") as string[];
    const depIds: string[] = [];
    const missing: string[] = [];
    for (const n of deps) {
      const id = nameToId[n] ?? pushedByName.get(n);
      if (id) depIds.push(id);
      else missing.push(n); // upstream not in krill (or itself deferred above)
    }
    // Defer rather than push with deps stripped. Same-batch deps resolve via
    // topo order (nameToId fills as we go); a genuinely unresolved dep — or one
    // whose upstream we just deferred — cascades the defer downstream. The task
    // stays "proposed" so it can be pushed once its deps land.
    if (missing.length) {
      deferredNames.add(t.name);
      results.push({ name: t.name, deferred: true, blockedBy: missing });
      continue;
    }
    try {
      const created = await krill.createTask(buildCreateArgs(t, projectId, depIds, medians));
      const kid = created?.task?.id || created?.id || null;
      if (kid) { nameToId[t.name] = kid; pushedByName.set(t.name, kid); }
      updateProposed(t.id, { status: "pushed", krill_task_id: kid, push_error: null });
      results.push({ name: t.name, id: kid, depends_on: depIds });
    } catch (err) {
      updateProposed(t.id, { status: "push_failed", push_error: (err as Error).message });
      results.push({ name: t.name, error: (err as Error).message });
    }
  }
  const depWarning = deferredNames.size
    ? `${deferredNames.size} task(s) deferred — dependencies not in krill yet; push those first: ${[...deferredNames].slice(0, 3).join(", ")}`
    : undefined;
  return {
    ok: true,
    pushed: results.filter((r) => r.id).length,
    deferred: deferredNames.size,
    total: items.length,
    results,
    warning: warning ?? depWarning,
  };
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
    owner_persona: r.owner_persona ?? t.owner_persona,
    owner_area: r.owner_area ?? t.owner_area,
    // Keep acceptance in lockstep with the refined scope: a refine that changes
    // the deliverable must re-state acceptance, else VERIFYING checks the wrong
    // bar. Fall back to the current value when the refiner returned none (never
    // null out a good acceptance).
    acceptance: r.acceptance?.trim() || t.acceptance,
    status: "proposed",
  });
  canonicalizeProjectDeps(t.project_key); // map handle-deps → task names
  return { task: getProposed(id) ?? updated, flow: flowPreview(updated) };
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
  // One bulk fetch → id→status map, instead of an N-task getTask fan-out.
  const statusById = new Map(
    (await krill.listTasks()).map((t) => [t.id, t.status ?? null]),
  );
  return items.map((t) =>
    t.krill_task_id && (t.status === "pushed" || t.status === "push_failed")
      ? { ...t, krill_status: statusById.get(t.krill_task_id) ?? null }
      : t,
  );
}

/** Push an approved task to krill. High-risk tasks are never silently bypassed. */
export async function push(id: string, { confirm = false }: { confirm?: boolean } = {}) {
  const t = getProposed(id);
  if (!t) throw new Error("proposed task not found");
  // Idempotency guard: a task already in krill is never re-pushed. The UI never
  // offers Push on a "pushed" row and batch filters them out, but a raw push(id)
  // here would otherwise create a duplicate krill task and overwrite the id.
  if (t.status === "pushed" && t.krill_task_id) {
    return { task: t, pushed: false, alreadyPushed: true, message: `already in krill as ${t.krill_task_id}` };
  }
  if (t.auto_publish && !isProtected(t.project_key) && !confirm) {
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
    // Resolve dependencies against already-pushed siblings. Refuse rather than
    // push with deps silently dropped — a dep-blocked task landing in krill
    // with no depends_on is exactly the bug WH-11 fixes.
    const deps = JSON.parse(t.deps || "[]") as string[];
    let depIds: string[] = [];
    if (deps.length) {
      const pushedByName = new Map(
        listProposed()
          .filter((x) => x.project_key === t.project_key && x.krill_task_id)
          .map((x) => [x.name, x.krill_task_id as string]),
      );
      const missing = deps.filter((n) => !pushedByName.has(n));
      if (missing.length) {
        const f = updateProposed(id, {
          status: "push_failed",
          push_error: `dependency not in krill yet — push first: ${missing.join(", ")}`,
        });
        return { task: f, pushed: false, error: f.push_error };
      }
      depIds = deps.map((n) => pushedByName.get(n)!);
    }
    const armed = !!t.auto_publish && !isProtected(t.project_key);
    const medians = await krill.getUsageMedians();
    const created = await krill.createTask(buildCreateArgs(t, projectId, depIds, medians));
    const warning = armed
      ? await autoFinishWarning(projectId, t.project_key || "", 1)
      : undefined;
    const done = updateProposed(id, { status: "pushed", krill_task_id: created?.id || created?.task?.id || null });
    return { task: done, pushed: true, krill: created, warning };
  } catch (err) {
    const f = updateProposed(id, { status: "push_failed", push_error: (err as Error).message });
    return { task: f, pushed: false, error: (err as Error).message };
  }
}
