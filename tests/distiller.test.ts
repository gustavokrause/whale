// C2/C3 distiller — plan folds a Decisions ledger, refine/reject fold the WHY
// into Standing principles. Stub runner + test.db, no LLM, no krill. The context
// dir is pointed at a temp dir so real memory is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

process.env.WHALE_CONTEXT_DIR = join(tmpdir(), `whale-distill-${randomUUID()}`);

import { db } from "../src/db/client";
import { inboxEntries, proposedTasks } from "../src/db/schema";
import { addEntry, addProposed } from "../src/db/queries";
import { plan } from "../src/lib/stages";
import { refine, reject } from "../src/lib/pipeline";
import { readContext, writeContext } from "../src/lib/context-store";

const stubTeam = { risk: { safeWords: [] as string[] } } as const;

function resetDb() {
  db.delete(proposedTasks).run();
  db.delete(inboxEntries).run();
}

test.after(() => rmSync(process.env.WHALE_CONTEXT_DIR!, { recursive: true, force: true }));

test("C2: plan folds a Decisions ledger into the project context", async () => {
  resetDb();
  writeContext("dtest", "# CONTEXT — dtest\n\n## Goals\nship");
  const e = addEntry({ text: "add CSV export", projectHint: "dtest" });
  const proposed = await plan(stubTeam as never, "dtest");
  assert.equal(proposed.length, 1);
  const md = readContext("dtest");
  assert.match(md, /## Goals\nship/, "audit sections untouched");
  assert.match(md, new RegExp(`- \\[\\d{4}-\\d{2}-\\d{2}\\] plan-run ${proposed[0].plan_run_id}: proposed "add CSV export" \\(from dump ${e.id}, owner n/a\\)`), "ledger bullet recorded");
  resetDb();
});

test("C2: distiller never creates a context file for a never-onboarded project", async () => {
  resetDb();
  addEntry({ text: "add dark mode", projectHint: "ghost" });
  const proposed = await plan(stubTeam as never, "ghost");
  assert.equal(proposed.length, 1, "plan itself still works");
  assert.equal(readContext("ghost"), "", "no CONTEXT.md conjured from nothing");
  resetDb();
});

test("C3: refine folds the user's words (verbatim, 300-char cap) into Standing principles", async () => {
  resetDb();
  writeContext("dtest", "# CONTEXT — dtest\n\n## Goals\nship");
  const t = addProposed({ project_key: "dtest", name: "add export", description: "csv" });
  const input = `no CSV — json only, users asked. ${"x".repeat(300)}`;
  await refine(stubTeam as never, t.id, input);
  const md = readContext("dtest");
  assert.match(md, /## Standing principles/);
  assert.ok(md.includes(`refined "add export": ${input.slice(0, 300)}`), "verbatim head of the input");
  assert.ok(!md.includes(input.slice(0, 301)), "capped at 300 chars");
  resetDb();
});

test("C3: reject records the task name + description head in Standing principles", async () => {
  resetDb();
  writeContext("dtest", "# CONTEXT — dtest\n\n## Goals\nship");
  const t = addProposed({ project_key: "dtest", name: "big rewrite", description: "y".repeat(200) });
  reject(t.id);
  const md = readContext("dtest");
  assert.ok(md.includes(`rejected "big rewrite": ${"y".repeat(120)}`), "description head recorded");
  assert.ok(!md.includes("y".repeat(121)), "capped at 120 chars");
  resetDb();
});

test("C3: refine/reject skip silently when the project has no context", async () => {
  resetDb();
  const t = addProposed({ project_key: "ghost", name: "x", description: "d" });
  await refine(stubTeam as never, t.id, "steer it");
  const t2 = addProposed({ project_key: "ghost", name: "z", description: "d" });
  const rejected = reject(t2.id);
  assert.equal(rejected.status, "rejected", "reject still lands");
  assert.equal(readContext("ghost"), "", "no context file created");
  resetDb();
});
