import { getTeam } from "@/lib/team";
import { distillAll } from "@/lib/pipeline";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return json(await distillAll(await getTeam()));
  } catch (e) {
    return fail(e);
  }
}
