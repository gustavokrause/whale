import { deleteProposed } from "@/db/queries";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteProposed(id);
  return json({ ok: true });
}
