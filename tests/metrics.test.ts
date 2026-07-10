// override-rate metric (C6) — seeded proposed_tasks rows, no LLM, no krill.

import { test } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/db/client";
import { proposedTasks } from "../src/db/schema";
import { addProposed, updateProposed } from "../src/db/queries";
import { overrideRate } from "../src/lib/metrics";

test("overrideRate: per-run and aggregate math over seeded rows", () => {
  db.delete(proposedTasks).run();
  try {
    // run1: one rejected, one refined twice, one untouched
    const a = addProposed({ project_key: "mtest", name: "a", plan_run_id: "run1" });
    const b = addProposed({ project_key: "mtest", name: "b", plan_run_id: "run1" });
    addProposed({ project_key: "mtest", name: "c", plan_run_id: "run1" });
    updateProposed(a.id, { status: "rejected" });
    updateProposed(b.id, {
      refine_log: JSON.stringify([{ input: "x", at: 1 }, { input: "y", at: 2 }]),
    });
    // run2: two untouched
    addProposed({ project_key: "mtest", name: "d", plan_run_id: "run2" });
    addProposed({ project_key: "mtest", name: "e", plan_run_id: "run2" });
    // another project — must not leak into mtest's numbers
    addProposed({ project_key: "other", name: "z", plan_run_id: "run1" });

    const r = overrideRate("mtest");
    assert.equal(r.runs.length, 2, "two plan runs");
    assert.deepEqual(
      r.runs.find((x) => x.plan_run_id === "run1"),
      { plan_run_id: "run1", total: 3, rejected: 1, refined: 1, refine_events: 2, override_rate: 2 / 3 },
    );
    assert.deepEqual(
      r.runs.find((x) => x.plan_run_id === "run2"),
      { plan_run_id: "run2", total: 2, rejected: 0, refined: 0, refine_events: 0, override_rate: 0 },
    );
    assert.deepEqual(r.aggregate, {
      total: 5, rejected: 1, refined: 1, refine_events: 2, override_rate: 2 / 5,
    });

    const empty = overrideRate("no-such-project");
    assert.equal(empty.runs.length, 0);
    assert.deepEqual(empty.aggregate, {
      total: 0, rejected: 0, refined: 0, refine_events: 0, override_rate: 0,
    });
  } finally {
    db.delete(proposedTasks).run();
  }
});

test("shippedImpact: DONE-only, measured parsing, honest ratio", async () => {
  const { shippedImpact } = await import("../src/lib/metrics");
  db.delete(proposedTasks).run();
  try {
    const a = addProposed({ project_key: "ship", name: "perf cut", expected_impact: "cut payload 40%" });
    const b = addProposed({ project_key: "ship", name: "docs fix" });
    const c = addProposed({ project_key: "ship", name: "still running" });
    updateProposed(a.id, { status: "pushed", krill_task_id: "K-1" });
    updateProposed(b.id, { status: "pushed", krill_task_id: "K-2" });
    updateProposed(c.id, { status: "pushed", krill_task_id: "K-3" });

    const s = shippedImpact("ship", [
      { id: "K-1", status: "DONE", expected_impact: "cut payload 40%", measured_impact: JSON.stringify([{ metric: "payload", before: "812 KB", after: "486 KB" }]) },
      { id: "K-2", status: "DONE", measured_impact: null },
      { id: "K-3", status: "IMPLEMENTING" },
    ]);

    assert.equal(s.done, 2, "only DONE krill tasks count");
    assert.equal(s.with_expected, 1);
    assert.equal(s.with_measured, 1);
    assert.equal(s.measured_ratio, 0.5);
    const perf = s.impacts.find((i) => i.name === "perf cut")!;
    assert.equal(perf.measured, "payload 812 KB → 486 KB");
    const docs = s.impacts.find((i) => i.name === "docs fix")!;
    assert.equal(docs.measured, null, "unmeasured stays null — never invented");
  } finally {
    db.delete(proposedTasks).run();
  }
});
