import type { NextRequest } from "next/server";
import { pushGroup } from "@/lib/pipeline";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

// Push one dump's tasks (a plan run's source_entry_id), dependency-ordered.
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.key) return fail("key required");
    if (!b.source_entry_id) return fail("source_entry_id required");
    return json(await pushGroup(b.key, b.source_entry_id, { confirm: !!b.confirm }));
  } catch (e) {
    return fail(e);
  }
}
