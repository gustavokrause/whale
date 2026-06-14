// baleia — orchestration + gates/dials. Ties the stages to krill, enforces the
// human gates (new-project always gated; high-risk never auto-pushes).

import { homedir } from "node:os";
import { config } from "./config.mjs";
import { getProposed, updateProposed, projectKeys, setEntryLane, rawEntries, listProposed } from "./db.mjs";
import { distill, plan, route, triage, refineProposal, flowPreview } from "./stages.mjs";
import { auditComplete } from "./runner.mjs";
import { writeContext } from "./context-store.mjs";
import * as krill from "./krill-client.mjs";

const expandHome = (p) => (p?.startsWith("~") ? p.replace(/^~/, homedir()) : p);

/**
 * Onboarding (B5): make baleia aware of a project. Code projects → read-only
 * audit (cwd = the project's real folder) → CONTEXT. Idea projects (no repo /
 * not in krill) → tell the user to seed. Awareness != autonomy: auditing
 * baleia/krill is fine; the self-edit guard still gates their execution.
 */
export async function onboard(team, key) {
  const meta = await krill.getProjectMeta(key);
  if (!meta) return { ok: false, needsSeed: true, note: `"${key}" not found in krill — seed its CONTEXT by hand (idea project)` };
  if (!meta.has_repo) return { ok: false, needsSeed: true, note: `"${key}" has no repo — seed its CONTEXT by hand` };

  const caio = team.personas.find((p) => p.name === "Caio");
  const system =
    `${caio?.systemPrompt || ""}\n\nYou are onboarding the project "${key}". Read the codebase ` +
    `(read-only) and produce its CONTEXT.md. Be concrete and accurate — this becomes baleia's memory ` +
    `of the project.\nOUTPUT CONTRACT: return ONLY the markdown, starting with "# CONTEXT — ${key}". ` +
    `Sections: Goals, Stack, Structure, Current state, Open questions. No preamble, no code fences.`;
  const user = `Audit the repository in the working directory and output the full CONTEXT.md.`;
  const md = await auditComplete({ system, user, model: config.models.plan, cwd: expandHome(meta.folder_path) });
  writeContext(key, md);
  return { ok: true, key, chars: md.length };
}

export async function distillAll(team, db) {
  await autoRouteUntagged(team, db); // give untagged entries a project before they pile into 'global'
  return distill(team, db);
}

// Route raw entries that have no project yet, so a clearly-about-X dump lands in
// X instead of the unpushable 'global' bucket. Only acts when the router finds a
// real project; ambiguous ones stay for manual routing.
async function autoRouteUntagged(team, db) {
  const untagged = rawEntries(db).filter((e) => !(e.project_hint || "").trim() && !e.lane);
  if (!untagged.length) return;
  const keys = await knownKeys(db);
  for (const e of untagged) {
    try {
      const r = await route(team, e, keys);
      setEntryLane(db, e.id, { lane: r.dest, projectHint: r.dest === "task" ? r.projectKey || null : null });
    } catch { /* leave for manual routing */ }
  }
}

/** Real project targets the router can pick from: baleia's own keys + krill's. */
async function knownKeys(db) {
  return [...new Set([...projectKeys(db), ...(await krill.projectKeys())])];
}

/** Move a proposed task to a different project and re-triage it (risk may change
 *  — e.g. reassigning to baleia/krill triggers the self-edit guard). */
export function reassign(team, db, id, projectKey) {
  const t = getProposed(db, id);
  if (!t) throw new Error("proposed task not found");
  const tri = triage(team, { name: t.name, description: t.description, project_key: projectKey });
  return updateProposed(db, id, {
    project_key: projectKey,
    risk_tier: tri.risk_tier, bypass: tri.bypass ? 1 : 0,
    priority: tri.priority, mode: tri.mode, rationale: tri.rationale,
    status: "proposed", push_error: null,
  });
}

export const planProject = (team, db, key) => plan(team, db, key);

export async function routeEntry(team, db, entryId) {
  const e = db.prepare(`SELECT * FROM inbox_entries WHERE id = ?`).get(entryId);
  if (!e) throw new Error("entry not found");
  const r = await route(team, e, await knownKeys(db));

  // Act on the decision (no longer preview-only): persist the lane so the entry
  // is filed.  task -> tagged to a project for distill/plan;  context -> memory
  // only;  new_project -> HELD (creating a krill project stays a human step);
  // ask -> flagged for the user to clarify.
  const entry = setEntryLane(db, entryId, { lane: r.dest, projectHint: r.projectKey || null });

  if (r.dest === "new_project") {
    return { ...r, lane: r.dest, entry, gated: true, note: "held — review and create the krill project yourself before this becomes work" };
  }
  return { ...r, lane: r.dest, entry };
}

/**
 * Batch push (B2): push all pushable tasks for a project to krill in dependency
 * order, wiring krill `depends_on` from the planner's sibling-name deps so "new
 * builds on finished". Topo-sorted; cycles fall back to insertion order.
 */
export async function pushBatch(team, db, projectKey, { confirm = false } = {}) {
  if ((projectKey || "").toLowerCase() === "global")
    return { ok: false, error: "'global' is not a project — reassign tasks first" };

  const items = listProposed(db).filter(
    (t) => t.project_key === projectKey && ["proposed", "approved", "push_failed"].includes(t.status)
  );
  if (!items.length) return { ok: true, pushed: 0, results: [] };

  // B4 arm-time double-confirm: a batch that will auto-finish runs to DONE
  // unattended — require a distinct second confirmation before arming.
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
  const nameToId = {};
  const results = [];
  for (const t of ordered) {
    const depIds = JSON.parse(t.deps || "[]").map((n) => nameToId[n]).filter(Boolean);
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
      updateProposed(db, t.id, { status: "pushed", krill_task_id: kid, push_error: null });
      results.push({ name: t.name, id: kid, depends_on: depIds });
    } catch (err) {
      updateProposed(db, t.id, { status: "push_failed", push_error: err.message });
      results.push({ name: t.name, error: err.message });
    }
  }
  return { ok: true, pushed: results.filter((r) => r.id).length, total: items.length, results };
}

function topoByDeps(items, byName) {
  const visited = new Set();
  const out = [];
  const visit = (t) => {
    if (visited.has(t.name)) return;
    visited.add(t.name);
    for (const d of JSON.parse(t.deps || "[]")) {
      const dep = byName.get(d);
      if (dep) visit(dep);
    }
    out.push(t);
  };
  for (const t of items) visit(t);
  return out;
}

export async function approve(team, db, id) {
  let t = getProposed(db, id);
  if (!t) throw new Error("proposed task not found");
  t = updateProposed(db, id, { status: "approved" });
  // autoPush is itself the deliberate arm, so it bypasses the per-push confirm.
  if (config.autonomy.autoPush) return push(db, id, { confirm: true });
  return { task: t, pushed: false, note: "approved; auto-push off — push manually" };
}

export function reject(db, id) {
  return updateProposed(db, id, { status: "rejected" });
}

/**
 * Refine a proposed task from user Input (B3). Input is a turn: re-evaluate the
 * task with the input, re-triage (flags may change), append to the refine log,
 * and re-open it as 'proposed'. Returns the updated task + flow preview so the
 * UI can show the next Approve/Decline/Input.
 */
export async function refine(team, db, id, input) {
  const t = getProposed(db, id);
  if (!t) throw new Error("proposed task not found");
  const r = await refineProposal(team, t, input);
  const tri = triage(team, { name: r.name, description: r.description, project_key: t.project_key });
  const log = JSON.parse(t.refine_log || "[]");
  log.push({ input, at: Date.now() });
  const updated = updateProposed(db, id, {
    name: r.name,
    description: r.description || "",
    priority: r.priority || tri.priority,
    mode: r.mode || tri.mode,
    risk_tier: tri.risk_tier,
    bypass: tri.bypass ? 1 : 0,
    auto_publish: tri.auto_publish ? 1 : 0,
    deps: JSON.stringify(Array.isArray(r.depends_on) ? r.depends_on : JSON.parse(t.deps || "[]")),
    rationale: tri.rationale,
    refine_log: JSON.stringify(log),
    status: "proposed",
  });
  return { task: updated, flow: flowPreview(updated) };
}

export const previewFlow = flowPreview;

/** Push an approved task to krill. High-risk tasks are never silently bypassed. */
export async function push(db, id, { confirm = false } = {}) {
  const t = getProposed(db, id);
  if (!t) throw new Error("proposed task not found");
  // B4: an auto-finishing task runs to DONE unattended — require a distinct confirm.
  if (t.auto_publish && t.risk_tier === "low" && !confirm) {
    return { task: t, pushed: false, needsConfirm: true, message: "This task auto-finishes (auto-merge to main, no review). Re-confirm to arm." };
  }
  if (!(await krill.ping())) {
    const f = updateProposed(db, id, { status: "push_failed", push_error: "krill unreachable" });
    return { task: f, pushed: false, error: "krill unreachable" };
  }
  if ((t.project_key || "").toLowerCase() === "global") {
    const f = updateProposed(db, id, {
      status: "push_failed",
      push_error: `"global" is a cross-cutting bucket, not a project — reassign this task to a real project before pushing`,
    });
    return { task: f, pushed: false, error: f.push_error };
  }
  try {
    const projectId = await krill.resolveProjectId(t.project_key);
    if (!projectId) {
      const f = updateProposed(db, id, {
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
      // hard guard: only low/medium may bypass; high always gets human review
      skip_plan_review: t.bypass && t.risk_tier !== "high",
      // auto-finish only for low risk (krill also requires project.allow_auto_finish)
      auto_publish: !!t.auto_publish && t.risk_tier === "low",
    });
    const done = updateProposed(db, id, { status: "pushed", krill_task_id: created?.id || created?.task?.id || null });
    return { task: done, pushed: true, krill: created };
  } catch (err) {
    const f = updateProposed(db, id, { status: "push_failed", push_error: err.message });
    return { task: f, pushed: false, error: err.message };
  }
}
