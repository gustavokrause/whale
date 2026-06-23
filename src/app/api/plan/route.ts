import type { NextRequest } from "next/server";
import { isRunning } from "@/lib/jobs";
import { startPlanJob } from "@/lib/plan-job";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

// Plan runs real Claude — kick off as a tracked job; survives reloads, UI shows it.
// An interactive block (unauthenticated MCP / CLI login) pauses it as a blocker.
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.key) return fail("key required");
    if (isRunning("plan", b.key)) return json({ running: true, key: b.key, note: "already planning" });
    await startPlanJob(b.key);
    return json({ running: true, key: b.key });
  } catch (e) {
    return fail(e);
  }
}
