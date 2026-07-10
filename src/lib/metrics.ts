// whale — crude override-rate metric. PLAN.md §9 calls override rate "the
// single metric that governs autonomy"; this computes it off existing
// proposed_tasks columns (no schema change): an override = a human rejecting
// or refining what the planner proposed.
//
// Known crudeness: a rejected row later refined back to "proposed" only counts
// once (its rejection is overwritten, so it under-counts); pre-push flag
// changes (priority, bypass, skips) aren't recorded anywhere so they don't
// count at all. A proper version needs an events table.

import { listProposed } from "@/db/queries";
import type { ProposedTask } from "@/db/schema";

export type OverrideStats = {
  total: number;
  rejected: number;
  refined: number;
  refine_events: number;
  override_rate: number;
};

export type OverrideRateRun = OverrideStats & { plan_run_id: string | null };

function refineCount(t: ProposedTask): number {
  try {
    const log = JSON.parse(t.refine_log || "[]");
    return Array.isArray(log) ? log.length : 0;
  } catch {
    return 0;
  }
}

function stats(rows: ProposedTask[]): OverrideStats {
  const counts = rows.map(refineCount);
  const rejected = rows.filter((t) => t.status === "rejected").length;
  const refined = counts.filter((n) => n > 0).length;
  return {
    total: rows.length,
    rejected,
    refined,
    refine_events: counts.reduce((a, b) => a + b, 0),
    override_rate: rows.length ? (rejected + refined) / rows.length : 0,
  };
}

/** Override rate for a project: per plan run + aggregate over all its rows. */
export function overrideRate(key: string): {
  key: string;
  runs: OverrideRateRun[];
  aggregate: OverrideStats;
} {
  const items = listProposed().filter((t) => t.project_key === key);
  const byRun = new Map<string | null, ProposedTask[]>();
  for (const t of items) {
    const run = t.plan_run_id ?? null;
    byRun.set(run, [...(byRun.get(run) ?? []), t]);
  }
  const runs = [...byRun.entries()].map(([plan_run_id, rows]) => ({
    plan_run_id,
    ...stats(rows),
  }));
  return { key, runs, aggregate: stats(items) };
}

export type ShippedStats = {
  done: number; // pushed tasks krill reports DONE
  with_expected: number; // of those, how many carried an impact hypothesis
  with_measured: number; // of those, how many have verify-observed numbers
  measured_ratio: number; // with_measured / done — expect this LOW; ~1.0 means someone is lying
  impacts: { name: string; expected: string | null; measured: string | null }[];
};

/**
 * Value side of the ledger: what actually shipped, with hypotheses and any
 * verify-observed measurements. Takes the krill task rows (caller fetches —
 * metrics stays sync/offline-testable).
 */
export function shippedImpact(
  key: string,
  krillTasks: {
    id: string;
    status?: string;
    expected_impact?: string | null;
    measured_impact?: string | null;
  }[],
): ShippedStats {
  const byId = new Map(krillTasks.map((t) => [t.id, t]));
  const done = listProposed().filter((t) => {
    if (t.project_key !== key || t.status !== "pushed" || !t.krill_task_id) return false;
    return byId.get(t.krill_task_id)?.status === "DONE";
  });
  const impacts = done.map((t) => {
    const k = byId.get(t.krill_task_id!)!;
    let measured: string | null = null;
    try {
      const ms = k.measured_impact ? (JSON.parse(k.measured_impact) as { metric: string; before?: string; after: string }[]) : [];
      if (ms.length) measured = ms.map((m) => `${m.metric} ${m.before ? `${m.before} → ` : ""}${m.after}`).join("; ");
    } catch { /* malformed — treat as unmeasured */ }
    return {
      name: t.name,
      expected: (k.expected_impact ?? t.expected_impact)?.trim() || null,
      measured,
    };
  });
  const with_expected = impacts.filter((i) => i.expected).length;
  const with_measured = impacts.filter((i) => i.measured).length;
  return {
    done: impacts.length,
    with_expected,
    with_measured,
    measured_ratio: impacts.length ? with_measured / impacts.length : 0,
    impacts,
  };
}
