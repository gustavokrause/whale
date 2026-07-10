import type { NextRequest } from "next/server";
import { overrideRate, shippedImpact } from "@/lib/metrics";
import * as krill from "@/lib/krill-client";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

// Crude override-rate readout (PLAN.md §9) — read-only, computed off
// proposed_tasks — plus the shipped-impact block (value ledger): DONE tasks
// with their impact hypotheses and any verify-observed measurements. krill
// unreachable → shipped is null rather than failing the whole readout.
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!key) return fail("key required");
  const base = overrideRate(key);
  let shipped = null;
  if (await krill.ping()) {
    shipped = shippedImpact(key, await krill.listTasks());
  }
  return json({ ...base, shipped });
}
