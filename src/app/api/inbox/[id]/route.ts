import type { NextRequest } from "next/server";
import { deleteEntry, setEntryProject } from "@/db/queries";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteEntry(id);
  return json({ ok: true });
}

// Reassign a request to a project (promote an unassigned dump).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  const entry = setEntryProject(id, b.project_hint ?? null);
  return entry ? json({ entry }) : fail("entry not found", 404);
}
