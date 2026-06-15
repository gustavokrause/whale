import type { NextRequest } from "next/server";
import { getTeam } from "@/lib/team";
import { onboard } from "@/lib/pipeline";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.key) return fail("key required");
    return json(await onboard(await getTeam(), b.key));
  } catch (e) {
    return fail(e);
  }
}
