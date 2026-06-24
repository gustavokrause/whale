import { deleteProposed, getProposed, updateProposed } from "@/db/queries";
import { json, fail } from "@/lib/api";
import { config } from "@/lib/config";

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
  if ("bypass" in b) out.bypass = !!b.bypass;
  if ("skip_plan" in b) out.skip_plan = !!b.skip_plan && !prot;
  if ("auto_publish" in b) out.auto_publish = !!b.auto_publish && !prot;
  if ("skip_ai_review" in b) out.skip_ai_review = !!b.skip_ai_review;
  // null = inherit krill's mode default; true/false = explicit override.
  if ("skip_verify" in b) out.skip_verify = b.skip_verify == null ? null : !!b.skip_verify;
  if ("disabled" in b) out.disabled = !!b.disabled;
  return json({ task: updateProposed(id, out) });
}
