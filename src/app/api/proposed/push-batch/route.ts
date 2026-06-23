import type { NextRequest } from "next/server";
import { getTeam } from "@/lib/team";
import { pushBatch } from "@/lib/pipeline";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.key) return fail("key required");
    return json(await pushBatch(await getTeam(), b.key, { confirm: !!b.confirm }));
  } catch (e) {
    return fail(e);
  }
}
