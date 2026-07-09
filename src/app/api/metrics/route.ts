import type { NextRequest } from "next/server";
import { overrideRate } from "@/lib/metrics";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

// Crude override-rate readout (PLAN.md §9) — read-only, computed off
// proposed_tasks. See src/lib/metrics.ts for the known under-counts.
export function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!key) return fail("key required");
  return json(overrideRate(key));
}
