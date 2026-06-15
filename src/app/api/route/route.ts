import type { NextRequest } from "next/server";
import { getTeam } from "@/lib/team";
import { routeEntry } from "@/lib/pipeline";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.id) return fail("id required");
    return json(await routeEntry(await getTeam(), b.id));
  } catch (e) {
    return fail(e);
  }
}
