import type { NextRequest } from "next/server";
import { getTeam } from "@/lib/team";
import { onboard } from "@/lib/pipeline";
import { startJob, isRunning } from "@/lib/jobs";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

// Audit runs 1-3 min — kick it off as a tracked job and return immediately, so it
// survives client reloads and the UI can show it in progress (see /api/jobs).
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.key) return fail("key required");
    if (isRunning("onboard", b.key)) return json({ running: true, key: b.key, note: "already auditing" });
    const team = await getTeam();
    startJob("onboard", b.key, async () => {
      const r = await onboard(team, b.key);
      return { ok: !!r.ok, note: r.ok ? `${r.chars} chars of context` : r.note || "failed" };
    });
    return json({ running: true, key: b.key });
  } catch (e) {
    return fail(e);
  }
}
