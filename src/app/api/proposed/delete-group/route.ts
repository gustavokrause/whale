import type { NextRequest } from "next/server";
import { deleteProposedByGroup } from "@/db/queries";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.key) return fail("key required");
    if (!b.source_entry_id) return fail("source_entry_id required");
    const { deleted } = deleteProposedByGroup(b.key, b.source_entry_id);
    return json({ ok: true, deleted });
  } catch (e) {
    return fail(e);
  }
}
