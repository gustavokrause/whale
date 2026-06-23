import { deleteProposed, getProposed, updateProposed } from "@/db/queries";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteProposed(id);
  return json({ ok: true });
}

// Override the suggested settings before pushing to krill (pre-send edit).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getProposed(id)) return fail("proposed task not found", 404);
  const b = (await req.json()) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (b.mode === "dev" || b.mode === "non-dev") out.mode = b.mode;
  if (typeof b.priority === "string" && /^P[0-3]$/.test(b.priority)) out.priority = b.priority;
  if ("bypass" in b) out.bypass = !!b.bypass;
  if ("auto_publish" in b) out.auto_publish = !!b.auto_publish;
  if ("disabled" in b) out.disabled = !!b.disabled;
  return json({ task: updateProposed(id, out) });
}
