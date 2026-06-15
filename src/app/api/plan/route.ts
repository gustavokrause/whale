import type { NextRequest } from "next/server";
import { getTeam } from "@/lib/team";
import { planProject } from "@/lib/pipeline";
import { startJob, isRunning } from "@/lib/jobs";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

// Plan runs real Claude — kick off as a tracked job; survives reloads, UI shows it.
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.key) return fail("key required");
    if (isRunning("plan", b.key)) return json({ running: true, key: b.key, note: "already planning" });
    const team = await getTeam();
    startJob("plan", b.key, async () => {
      const proposed = await planProject(team, b.key);
      return { ok: true, note: `${proposed.length} proposed task(s)` };
    });
    return json({ running: true, key: b.key });
  } catch (e) {
    return fail(e);
  }
}
