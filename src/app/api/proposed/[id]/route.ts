import { deleteProposed, getProposed, updateProposed, listProposed } from "@/db/queries";
import { json, fail } from "@/lib/api";
import { config } from "@/lib/config";
import { canonicalizeProjectDeps } from "@/lib/stages";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteProposed(id);
  return json({ ok: true });
}

// Override the suggested settings before pushing to krill (pre-send edit).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getProposed(id);
  if (!task) return fail("proposed task not found", 404);
  // Self-edit guard, enforced server-side (not just in the UI): protected
  // (whale/krill) tasks can never skip planning or auto-finish — clamp those to
  // false even if a raw API call asks for true, so the stored row never lies
  // about what krill will do. skip_plan_review (plan-review step) is opt-in even
  // for self-edits; the deliverable still gets a human review (auto_publish off).
  const prot = config.autonomy.protected.includes((task.project_key || "").toLowerCase());
  const b = (await req.json()) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (b.mode === "dev" || b.mode === "non-dev") out.mode = b.mode;
  if (typeof b.priority === "string" && /^P[0-3]$/.test(b.priority)) out.priority = b.priority;
  // Impact hypothesis is free text; blank means "no articulable impact" → null.
  if ("expected_impact" in b)
    out.expected_impact =
      typeof b.expected_impact === "string" && b.expected_impact.trim() ? b.expected_impact.trim() : null;
  if ("bypass" in b) out.bypass = !!b.bypass;
  if ("skip_plan" in b) out.skip_plan = !!b.skip_plan && !prot;
  if ("auto_publish" in b) out.auto_publish = !!b.auto_publish && !prot;
  if ("skip_ai_review" in b) out.skip_ai_review = !!b.skip_ai_review;
  // null = inherit krill's mode default; true/false = explicit override.
  if ("skip_verify" in b) out.skip_verify = b.skip_verify == null ? null : !!b.skip_verify;
  if ("disabled" in b) out.disabled = !!b.disabled;

  // Graph metadata — editable because the planner can get it wrong and because
  // every dump distilled before dep_types existed reads as all-order. Without
  // this the only way to tag a gate or fix a premise is a direct DB write.
  //
  // premise: one sentence naming the assumption the task rests on. "" = the
  // task is unconditional. Stored trimmed; never null (re-evaluation reads it).
  if ("premise" in b && typeof b.premise === "string") out.premise = b.premise.trim();

  // deps: FULL replacement edge list. Removal is the point — when an upstream is
  // rejected, whale tells the operator to rewrite the dep, and this is the only
  // endpoint that can actually drop the dead edge. Names must be real proposals
  // in the same project: a dep on something that doesn't exist reads as blocked
  // forever with nothing to unblock it.
  let deps = JSON.parse(task.deps || "[]") as string[];
  if ("deps" in b) {
    if (!Array.isArray(b.deps) || b.deps.some((d) => typeof d !== "string"))
      return fail("deps must be an array of task names", 400);
    const next = [...new Set((b.deps as string[]).map((d) => d.trim()).filter(Boolean))];
    if (next.includes(task.name)) return fail("a task cannot depend on itself", 400);
    const siblings = new Set(
      listProposed()
        .filter((t) => t.project_key === task.project_key && t.id !== task.id)
        .map((t) => t.name),
    );
    // Names already on the task stay valid even if their proposal is gone — the
    // dangling edge is what the operator came here to look at and remove.
    const unknown = next.filter((d) => !siblings.has(d) && !deps.includes(d));
    if (unknown.length)
      return fail(`deps reference unknown task(s) in ${task.project_key}: ${unknown.join(", ")}`, 400);
    deps = next;
    out.deps = JSON.stringify(next);
    // An edge that no longer exists can't carry a type.
    const types = JSON.parse(task.dep_types || "{}") as Record<string, string>;
    out.dep_types = JSON.stringify(
      Object.fromEntries(Object.entries(types).filter(([k]) => next.includes(k))),
    );
  }

  // dep_types: FULL replacement map depName -> "order" | "gate" for this task
  // (the editor always submits every dep, so an omitted edge means "order").
  // Only names in the task's OWN deps are accepted — a type on a non-existent
  // edge would be invisible in the UI and silently wrong at push time. "order"
  // is the default and is stored as an absent key, keeping the column minimal.
  // Validated against the INCOMING deps when both are sent in one PATCH.
  if ("dep_types" in b) {
    if (b.dep_types === null) out.dep_types = "{}";
    else if (typeof b.dep_types === "object") {
      const incoming = b.dep_types as Record<string, unknown>;
      const unknown = Object.keys(incoming).filter((k) => !deps.includes(k));
      if (unknown.length)
        return fail(`dep_types references non-dependency edge(s): ${unknown.join(", ")}`, 400);
      const bad = Object.entries(incoming).filter(
        ([, v]) => v !== "order" && v !== "gate",
      );
      if (bad.length)
        return fail(`dep_types values must be "order" or "gate" (got: ${bad.map(([k, v]) => `${k}=${String(v)}`).join(", ")})`, 400);
      const next: Record<string, "gate"> = {};
      for (const [k, v] of Object.entries(incoming)) if (v === "gate") next[k] = "gate";
      out.dep_types = JSON.stringify(next);
    }
  }

  const updated = updateProposed(id, out);
  // Keep the project's edge names canonical after a graph edit, exactly as the
  // refine path does.
  if ("deps" in out) canonicalizeProjectDeps(task.project_key);
  return json({ task: getProposed(id) ?? updated });
}
