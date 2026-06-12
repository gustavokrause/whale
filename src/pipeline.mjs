// baleia — orchestration + gates/dials. Ties the stages to krill, enforces the
// human gates (new-project always gated; high-risk never auto-pushes).

import { config } from "./config.mjs";
import { getProposed, updateProposed, projectKeys, setEntryLane } from "./db.mjs";
import { distill, plan, route } from "./stages.mjs";
import * as krill from "./krill-client.mjs";

export const distillAll = (team, db) => distill(team, db);

export const planProject = (team, db, key) => plan(team, db, key);

export async function routeEntry(team, db, entryId) {
  const e = db.prepare(`SELECT * FROM inbox_entries WHERE id = ?`).get(entryId);
  if (!e) throw new Error("entry not found");
  const r = await route(team, e, projectKeys(db));

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

export async function approve(team, db, id) {
  let t = getProposed(db, id);
  if (!t) throw new Error("proposed task not found");
  t = updateProposed(db, id, { status: "approved" });
  if (config.autonomy.autoPush) return push(db, id);
  return { task: t, pushed: false, note: "approved; auto-push off — push manually" };
}

export function reject(db, id) {
  return updateProposed(db, id, { status: "rejected" });
}

/** Push an approved task to krill. High-risk tasks are never silently bypassed. */
export async function push(db, id) {
  const t = getProposed(db, id);
  if (!t) throw new Error("proposed task not found");
  if (!(await krill.ping())) {
    const f = updateProposed(db, id, { status: "push_failed", push_error: "krill unreachable" });
    return { task: f, pushed: false, error: "krill unreachable" };
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
    });
    const done = updateProposed(db, id, { status: "pushed", krill_task_id: created?.id || created?.task?.id || null });
    return { task: done, pushed: true, krill: created };
  } catch (err) {
    const f = updateProposed(db, id, { status: "push_failed", push_error: err.message });
    return { task: f, pushed: false, error: err.message };
  }
}
