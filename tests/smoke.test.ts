// whale smoke tests — the merge gate. Run: npm test (DB_PATH=data/test.db).
// Singleton drizzle db; resetDb() isolates the db-touching tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import { config, isReal, setConfigOverrides } from "../src/lib/config";
import { loadTeam } from "../src/lib/persona-loader";
import { db, sql as sqlite } from "../src/db/client";
import { inboxEntries, proposedTasks, config as configTable } from "../src/db/schema";
import {
  addEntry, listEntries, rawEntries, markEntries,
  addProposed, listProposed, updateProposed, getProposed, deleteProposed,
  readConfig, writeConfig, pendingRequests,
  addBlocker, listBlockers, resolveBlocker,
} from "../src/db/queries";
import { blockers } from "../src/db/schema";
import { triage, flowPreview, plan, canonicalizeProjectDeps } from "../src/lib/stages";
import { push, pushBatch, refine, enrichPushed, reject, reevaluateSubtree, reevalApply, reevalDismiss, unresolvedGates, withGateState } from "../src/lib/pipeline";
import { classifyBlock } from "../src/lib/runner";

function resetDb() {
  db.delete(proposedTasks).run();
  db.delete(inboxEntries).run();
  db.delete(configTable).run();
  db.delete(blockers).run();
}

const stubTeam = { risk: { safeWords: [] as string[] } } as const;

test("persona-loader reads the ai-team source of truth", async () => {
  const team = await loadTeam(config.personasDir);
  assert.ok(team.personas.length >= 13, "expected the full roster");
  assert.ok(team.personas.every((p) => p.systemPrompt.length > 200), "every persona has a real prompt");
  assert.ok(team.personas.find((p) => p.name === "Caio"), "Caio present");
  assert.ok(team.personas.find((p) => p.name === "Augusto"), "Augusto present");
  assert.equal(team.risk.tiers.length, 3, "three risk tiers");
  assert.ok(team.risk.safeWords.length >= 10, "safe-words parsed");
});

test("db inbox + proposed round-trip", () => {
  resetDb();
  const e = addEntry({ text: "hello", projectHint: "krill" });
  assert.equal(e.status, "raw");
  assert.equal(listEntries().length, 1);
  assert.equal(rawEntries().length, 1);

  markEntries([e.id], "planned");
  assert.equal(rawEntries().length, 0, "planned entries leave the pending queue");

  const t = addProposed({ project_key: "krill", name: "x", risk_tier: "low", bypass: true, deps: ["y"] });
  assert.equal(listProposed("proposed").length, 1);
  assert.deepEqual(JSON.parse(t.deps), ["y"], "deps round-trip (B2)");
  updateProposed(t.id, { status: "approved" });
  assert.equal(listProposed("approved").length, 1);

  assert.throws(() => addEntry({ text: "   " }), "empty entry rejected");
});

test("plan: pending requests become proposed tasks, then marked planned", async () => {
  resetDb();
  addEntry({ text: "add CSV export to reports", projectHint: "ztest" });
  assert.equal(pendingRequests("ztest").length, 1, "dump is a pending request");
  const proposed = await plan(stubTeam as never, "ztest");
  assert.equal(proposed.length, 1, "one request -> one proposed task");
  assert.match(proposed[0].name, /CSV export/, "task carries the request");
  assert.equal(pendingRequests("ztest").length, 0, "request consumed (planned)");
  resetDb();
});

test("triage classifies risk correctly", () => {
  const team = { risk: { safeWords: ["pricing", "legal"] } };
  const t = (name: string, project_key: string) => triage(team, { name, description: "", project_key });
  assert.equal(t("fix typo in readme", "demo-app").risk_tier, "low");
  assert.equal(t("add a db migration", "demo-app").risk_tier, "high", "irreversible keyword");
  assert.equal(t("change the pricing tier", "demo-app").risk_tier, "high", "safe-word");
  assert.equal(t("build a maintenance log", "mv").risk_tier, "medium", "default");
});

test("autonomy ladder: dial controls how far a task bypasses (B1)", () => {
  const bypass = (name: string, key: string, dial: string) =>
    triage(stubTeam, { name, description: "", project_key: key }, dial).bypass;
  const low = "fix typo";
  const med = "build a feature";
  assert.equal(bypass(low, "demo-app", "conservative"), false);
  assert.equal(bypass(med, "demo-app", "conservative"), false);
  assert.equal(bypass(low, "demo-app", "balanced"), true);
  assert.equal(bypass(med, "demo-app", "balanced"), false);
  assert.equal(bypass(low, "demo-app", "aggressive"), true);
  assert.equal(bypass(med, "demo-app", "aggressive"), true);
});

test("self-edit floor covers the whole fleet — bridge/ai-team never bypass, even ludicrous", () => {
  for (const key of ["whale", "krill", "bridge", "ai-team"]) {
    const r = triage(stubTeam, { name: "small tweak", description: "", project_key: key }, "ludicrous");
    assert.equal(r.risk_tier, "high", `${key}: self-edit is always high`);
    assert.equal(r.bypass, false, `${key}: plan review never skipped`);
    assert.equal(r.auto_publish, false, `${key}: never auto-finishes`);
  }
  // Sanity: an unprotected project on ludicrous DOES bypass — the floor is
  // the exception, not a broken dial.
  const open = triage(stubTeam, { name: "small tweak", description: "", project_key: "demo-app" }, "ludicrous");
  assert.equal(open.bypass, true);
  assert.equal(open.auto_publish, true);
});

test("flow preview reflects the gates a task will hit (B3)", () => {
  assert.match(flowPreview({ risk_tier: "high" }), /full review/);
  assert.match(flowPreview({ risk_tier: "low", auto_publish: true }), /auto-finish/);
  assert.match(flowPreview({ risk_tier: "low", bypass: true }), /deliverable/);
  assert.equal(flowPreview({ risk_tier: "low" }), "stops at plan review");
});

test("B3 refine: Input re-evaluates + re-triages + logs the turn", async () => {
  resetDb();
  const t = addProposed({ project_key: "demo-app", name: "add export", description: "csv", risk_tier: "medium" });
  const r = await refine(stubTeam as never, t.id, "also support json");
  assert.match(r.task.description, /json/, "stub folds the input in");
  assert.equal(JSON.parse(r.task.refine_log).length, 1, "turn logged");
  assert.equal(r.task.status, "proposed", "re-opened for next decision");
  assert.ok(typeof r.flow === "string" && r.flow.length, "flow preview returned");
});

test("B3 refine: acceptance survives a refine (must not be nulled)", async () => {
  resetDb();
  const accept = "CSV export downloads a .csv with all columns";
  const t = addProposed({
    project_key: "demo-app",
    name: "add export",
    description: "csv",
    risk_tier: "medium",
    acceptance: accept,
  });
  const r = await refine(stubTeam as never, t.id, "also support json");
  // The refine path must carry acceptance through, not drop it — a refined task
  // with a null/stale acceptance verifies the wrong bar in krill.
  assert.equal(r.task.acceptance, accept, "acceptance preserved through refine");
});

test("B4 arm-time confirm: auto-finish push/batch needs a distinct confirm", async () => {
  resetDb();
  const t = addProposed({ project_key: "demo-app", name: "x", risk_tier: "low", auto_publish: true });
  const r = await push(t.id);
  assert.equal(r.needsConfirm, true, "single push needs confirm");
  assert.equal(getProposed(t.id)!.status, "proposed", "not pushed yet");
  const b = await pushBatch(stubTeam as never, "demo-app");
  assert.equal(b.needsConfirm, true, "batch needs confirm");
});

test("auto-finish rung (A2): auto_publish only for aggressive + low + non-self-edit", () => {
  const ap = (name: string, key: string, dial: string) =>
    triage(stubTeam, { name, description: "", project_key: key }, dial).auto_publish;
  assert.equal(ap("fix typo", "demo-app", "aggressive"), true, "aggressive low -> auto-finish");
  assert.equal(ap("fix typo", "demo-app", "balanced"), false, "balanced low -> no auto-finish");
  assert.equal(ap("build a feature", "demo-app", "aggressive"), false, "medium never auto-finishes");
  assert.equal(ap("fix typo", "whale", "aggressive"), false, "self-edit never auto-finishes");
});

test("autonomous rung: auto_publish for low+medium, NOT high, NOT self-edit", () => {
  const tri = (name: string, key: string) =>
    triage(stubTeam, { name, description: "", project_key: key }, "autonomous");
  assert.equal(tri("fix typo", "demo-app").auto_publish, true, "low -> auto");
  assert.equal(tri("build a feature", "demo-app").auto_publish, true, "medium -> auto");
  assert.equal(tri("add a db migration", "demo-app").auto_publish, false, "high -> NOT auto");
  assert.equal(tri("add a db migration", "demo-app").bypass, false, "high -> full review (no bypass)");
  assert.equal(tri("fix typo", "whale").auto_publish, false, "self-edit never auto");
});

test("ludicrous rung: auto_publish for EVERY tier except self-edit", () => {
  const ap = (name: string, key: string) =>
    triage(stubTeam, { name, description: "", project_key: key }, "ludicrous").auto_publish;
  assert.equal(ap("fix typo", "demo-app"), true, "low -> auto");
  assert.equal(ap("build a feature", "demo-app"), true, "medium -> auto");
  assert.equal(ap("add a db migration", "demo-app"), true, "high (irreversible) -> auto");
  assert.equal(ap("change the pricing tier", "demo-app"), true, "high (safe-word) -> auto");
  assert.equal(ap("fix typo", "whale"), false, "self-edit never auto, even ludicrous");
  assert.equal(ap("fix typo", "krill"), false, "self-edit never auto, even ludicrous");
});

test("self-edit guard: orchestrator tasks never bypass, any dial", () => {
  assert.equal(
    triage(stubTeam, { name: "fix typo", description: "", project_key: "demo-app" }, "aggressive").bypass,
    true,
  );
  for (const key of config.autonomy.protected) {
    for (const dial of ["conservative", "balanced", "aggressive", "autonomous", "ludicrous"]) {
      const self = triage(stubTeam, { name: "fix typo", description: "", project_key: key }, dial);
      assert.equal(self.risk_tier, "high", `${key} self-edit is high risk`);
      assert.equal(self.bypass, false, `${key} self-edit never bypasses (${dial})`);
      assert.equal(self.auto_publish, false, `${key} self-edit never auto-finishes (${dial})`);
    }
  }
});

test("config: DB overrides win over env; protected stays env-only", () => {
  resetDb();
  setConfigOverrides(readConfig());
  assert.equal(config.autonomy.bypass, "conservative", "env default dial");
  assert.equal(isReal(), false, "env default runner is stub");

  writeConfig({ runner: "real", bypass: "aggressive", auto_push: true, model_plan: "opus" });
  setConfigOverrides(readConfig());
  assert.equal(config.autonomy.bypass, "aggressive", "override wins");
  assert.equal(config.autonomy.autoPush, true, "bool override wins");
  assert.equal(config.models.plan, "opus", "model override wins");
  assert.equal(isReal(), true, "runner override wins");

  assert.ok(
    config.autonomy.protected.includes("whale") && config.autonomy.protected.includes("krill"),
    "protected floor holds regardless of overrides",
  );

  setConfigOverrides(null); // reset shared module state
  resetDb();
});

test("blocker detection: auth/login prompts classify, ordinary prose doesn't", () => {
  const supa = classifyBlock("Open this URL in your browser to authorize Supabase access:\n\nhttps://api.supabase.com/v1/oauth/authorize?x=1");
  assert.equal(supa?.kind, "mcp_auth", "supabase OAuth -> mcp_auth");
  assert.match(supa?.actionUrl ?? "", /^https:\/\/api\.supabase\.com/, "captures the URL");
  assert.equal(classifyBlock("Not logged in · Please run /login")?.kind, "cli_login");
  assert.equal(classifyBlock("No filesystem access. Paste the cron logs and I'll plan."), null, "model asking for data is NOT a blocker");
});

test("blocker queue: file (deduped), list open, resolve", () => {
  resetDb();
  const a = addBlocker({ kind: "mcp_auth", trigger_kind: "plan", trigger_ref: "mv", summary: "needs auth", action_url: "https://x" });
  assert.equal(listBlockers("open").length, 1);
  // same (kind, trigger) while open -> refresh, not a duplicate
  const b = addBlocker({ kind: "mcp_auth", trigger_kind: "plan", trigger_ref: "mv", summary: "needs auth (again)" });
  assert.equal(b.id, a.id, "deduped to the same row");
  assert.equal(listBlockers("open").length, 1);
  // a different unit -> separate blocker
  addBlocker({ kind: "mcp_auth", trigger_kind: "plan", trigger_ref: "demo-app", summary: "other" });
  assert.equal(listBlockers("open").length, 2);
  resolveBlocker(a.id, "resolved");
  assert.equal(listBlockers("open").length, 1, "resolved drops out of open");
});

test("plan attributes tasks to their source dump + a shared plan run", async () => {
  resetDb();
  const a = addEntry({ text: "add CSV export", projectHint: "ztest" });
  const b = addEntry({ text: "add dark mode", projectHint: "ztest" });
  const proposed = await plan(stubTeam as never, "ztest");
  assert.equal(proposed.length, 2, "two dumps -> two tasks (stub)");
  const runIds = new Set(proposed.map((t) => t.plan_run_id));
  assert.equal(runIds.size, 1, "one plan run id for the click");
  const srcIds = new Set(proposed.map((t) => t.source_entry_id));
  assert.deepEqual([...srcIds].sort(), [a.id, b.id].sort(), "each task attributed to its dump");
});

// --- WH-11: dependency enforcement on push (payload + defer) ---------------
// Mock krill at the fetch seam: health up, one project, sequential task ids.
function mockKrill() {
  const orig = globalThis.fetch;
  const calls: { method: string; url: string; body: Record<string, unknown> | undefined }[] = [];
  let seq = 0;
  let krillTasks: { id: string; status?: string }[] = [];
  globalThis.fetch = (async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    const method = opts.method || "GET";
    const u = String(url);
    const body = opts.body ? (JSON.parse(opts.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url: u, body });
    let data: unknown = {};
    if (u.includes("/api/health")) data = {};
    else if (u.includes("/api/projects")) data = [
      { id: "proj1", slug: "ZT", name: "demo-app", folder_path: "/x", has_repo: true },
      { id: "projK", slug: "KR", name: "krill", folder_path: "/k", has_repo: true },
    ];
    else if (method === "POST" && u.includes("/api/tasks")) data = { id: `kid-${++seq}` };
    else if (u.includes("/api/tasks")) data = krillTasks;
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    calls,
    posts: () => calls.filter((c) => c.method === "POST" && c.url.includes("/api/tasks")),
    setTasks: (ts: { id: string; status?: string }[]) => { krillTasks = ts; },
    restore: () => { globalThis.fetch = orig; },
  };
}

test("WH-11 push(id): refuses when a dependency isn't in krill; passes depends_on once it is", async () => {
  resetDb();
  const k = mockKrill();
  try {
    // dep not in krill -> push_failed, no task created
    const b = addProposed({ project_key: "demo-app", name: "B", deps: ["A"] });
    const r1 = await push(b.id);
    assert.equal(r1.pushed, false, "blocked push doesn't go through");
    assert.match(r1.error ?? "", /dependency not in krill/i);
    assert.equal(getProposed(b.id)!.status, "push_failed");
    assert.equal(k.posts().length, 0, "no krill task created for a dep-blocked push");

    // push A first, then B resolves the dep -> depends_on carries A's id
    const a = addProposed({ project_key: "demo-app", name: "A" });
    const rA = await push(a.id);
    assert.equal(rA.pushed, true, "independent task pushes");
    const aKid = getProposed(a.id)!.krill_task_id;
    assert.ok(aKid, "A got a krill id");

    const r2 = await push(b.id);
    assert.equal(r2.pushed, true, "B pushes once its dep is in krill");
    const bPost = k.posts().at(-1)!;
    assert.deepEqual(bPost.body!.depends_on, [aKid], "B's payload carries A's krill id");
  } finally {
    k.restore();
  }
});

test("push(id) is idempotent: an already-pushed task is never re-pushed (no duplicate krill task)", async () => {
  resetDb();
  const k = mockKrill();
  try {
    const a = addProposed({ project_key: "demo-app", name: "A" });
    const r1 = await push(a.id);
    assert.equal(r1.pushed, true, "first push lands");
    const kid = getProposed(a.id)!.krill_task_id;
    assert.equal(k.posts().length, 1, "one krill task created");

    const r2 = await push(a.id);
    assert.equal(r2.pushed, false, "second push is a no-op");
    assert.equal(r2.alreadyPushed, true, "flagged already-pushed");
    assert.equal(k.posts().length, 1, "no duplicate krill task created");
    assert.equal(getProposed(a.id)!.krill_task_id, kid, "krill id unchanged");
  } finally {
    k.restore();
  }
});

test("acceptance: stored on the proposed task and carried into the krill payload", async () => {
  resetDb();
  const k = mockKrill();
  try {
    const acc = "after a test-mode checkout, tenants.plan = the bought tier";
    const t = addProposed({ project_key: "demo-app", name: "checkout persists plan", acceptance: acc });
    assert.equal(getProposed(t.id)!.acceptance, acc, "acceptance persisted on the proposed row");

    const r = await push(t.id);
    assert.equal(r.pushed, true, "task pushes");
    const post = k.posts().at(-1)!;
    assert.equal(post.body!.acceptance, acc, "acceptance reaches the krill createTask payload");
  } finally {
    k.restore();
  }
});

test("acceptance: null when the planner didn't author one", async () => {
  resetDb();
  const k = mockKrill();
  try {
    const t = addProposed({ project_key: "demo-app", name: "no acceptance" });
    assert.equal(getProposed(t.id)!.acceptance, null, "null when unset");
    await push(t.id);
    assert.equal(k.posts().at(-1)!.body!.acceptance, null, "payload carries null");
  } finally {
    k.restore();
  }
});

test("WH-11 pushItems: in-batch dep pushes in order; a missing upstream defers, not strips", async () => {
  resetDb();
  const k = mockKrill();
  try {
    // A + B in the same batch, B depends on A -> both push, B carries A's id
    addProposed({ project_key: "demo-app", name: "A" });
    addProposed({ project_key: "demo-app", name: "B", deps: ["A"] });
    const r = await pushBatch(stubTeam as never, "demo-app");
    assert.equal(r.pushed, 2, "both push");
    assert.equal(r.deferred ?? 0, 0, "nothing deferred when the dep is in-batch");
    const bPost = k.posts().find((p) => p.body!.name === "B")!;
    const aPost = k.posts().find((p) => p.body!.name === "A")!;
    assert.deepEqual(bPost.body!.depends_on, [(await krillIdFor(aPost))], "B depends on A's krill id");

    // C depends on a ghost upstream that's neither in batch nor in krill -> defer
    resetDb();
    addProposed({ project_key: "demo-app", name: "C", deps: ["ghost"] });
    const r2 = await pushBatch(stubTeam as never, "demo-app");
    assert.equal(r2.pushed, 0, "C is not pushed with a stripped dep");
    assert.equal(r2.deferred, 1, "C deferred");
    assert.equal(getProposed(listProposed().find((t) => t.name === "C")!.id)!.status, "proposed", "C stays proposed");
  } finally {
    k.restore();
  }
});

// A's krill id is the POST response we mocked sequentially; resolve it from the
// proposed row updated during the batch push.
async function krillIdFor(aPost: { body?: Record<string, unknown> }): Promise<string> {
  const a = listProposed().find((t) => t.name === aPost.body!.name)!;
  return a.krill_task_id as string;
}

test("push: all krill toggles carry into the payload (non-protected project)", async () => {
  resetDb();
  const k = mockKrill();
  try {
    const t = addProposed({ project_key: "demo-app", name: "toggles", bypass: true, auto_publish: true });
    updateProposed(t.id, { skip_plan: true, skip_ai_review: true, skip_verify: true });
    const r = await push(t.id, { confirm: true });
    assert.equal(r.pushed, true, "task pushes");
    const body = k.posts().at(-1)!.body!;
    assert.equal(body.skip_plan, true, "skip_plan carried");
    assert.equal(body.skip_plan_review, true, "skip_plan_review (bypass) carried");
    assert.equal(body.skip_ai_review, true, "skip_ai_review carried");
    assert.equal(body.skip_verify, true, "skip_verify carried when explicit");
    assert.equal(body.auto_publish, true, "auto_publish carried");
  } finally {
    k.restore();
  }
});

test("push: skip_verify omitted from payload when null (krill defaults by mode)", async () => {
  resetDb();
  const k = mockKrill();
  try {
    const t = addProposed({ project_key: "demo-app", name: "verify-auto" });
    assert.equal(getProposed(t.id)!.skip_verify, null, "skip_verify defaults null");
    await push(t.id);
    const body = k.posts().at(-1)!.body!;
    assert.equal("skip_verify" in body, false, "no skip_verify key — krill applies its mode default");
  } finally {
    k.restore();
  }
});

test("self-edit guard at push: protected forces skip_plan + auto_publish off; plan-review/AI-review/verify opt-in", async () => {
  resetDb();
  const k = mockKrill();
  try {
    // Arm every toggle on a krill (protected) task.
    const t = addProposed({ project_key: "krill", name: "self-edit", bypass: true, auto_publish: true });
    updateProposed(t.id, { skip_plan: true, skip_ai_review: true, skip_verify: true });
    const r = await push(t.id, { confirm: true });
    assert.equal(r.pushed, true, "task pushes");
    const body = k.posts().at(-1)!.body!;
    assert.equal(body.skip_plan, false, "guard: planning is forced ON for self-edits");
    assert.equal(body.auto_publish, false, "guard: auto-finish forced OFF (deliverable gets human review)");
    // Opt-in for self-edits — the deliverable gate (auto_publish off) still holds.
    assert.equal(body.skip_plan_review, true, "skip_plan_review honored for self-edits");
    assert.equal(body.skip_ai_review, true, "skip_ai_review honored for self-edits");
    assert.equal(body.skip_verify, true, "skip_verify honored for self-edits");
  } finally {
    k.restore();
  }
});

test("push: skip_verify=false (force on) is sent explicitly so krill verifies even a non-dev task", async () => {
  resetDb();
  const k = mockKrill();
  try {
    const t = addProposed({ project_key: "demo-app", name: "force-verify", mode: "non-dev" });
    updateProposed(t.id, { skip_verify: false });
    await push(t.id);
    const body = k.posts().at(-1)!.body!;
    assert.equal(body.skip_verify, false, "explicit false reaches krill — verify forced on");
  } finally {
    k.restore();
  }
});

test("proposed_tasks: typed dep edges + premise/reeval columns round-trip", () => {
  resetDb();
  // (1) schema — migration added the columns
  const cols = (sqlite.prepare("PRAGMA table_info(proposed_tasks)").all() as { name: string }[]).map((r) => r.name);
  for (const c of ["dep_types", "premise", "reeval_status", "reeval_note", "reeval_source"]) {
    assert.ok(cols.includes(c), `proposed_tasks missing column ${c}`);
  }

  // (2) round-trip typed deps + premise through addProposed/getProposed
  const gate = addProposed({ project_key: "wh", name: "MV-17 memo", label: "memo" });
  const child = addProposed({
    project_key: "wh",
    name: "MV-18 build",
    label: "build",
    deps: ["MV-17 memo"],
    dep_types: { "MV-17 memo": "gate" },
    premise: "assumes GO on MV-17 memo",
    reeval_status: "pending",
    reeval_note: "awaiting memo verdict",
    reeval_source: gate.id,
  });
  const read = getProposed(child.id)!;
  assert.deepEqual(JSON.parse(read.dep_types), { "MV-17 memo": "gate" });
  assert.equal(read.premise, "assumes GO on MV-17 memo");
  assert.equal(read.reeval_status, "pending");
  assert.equal(read.reeval_source, gate.id);

  // (3) canonicalizeProjectDeps rewrites label-keyed dep_types to canonical name
  const child2 = addProposed({
    project_key: "wh",
    name: "MV-19 ship",
    deps: ["memo"],
    dep_types: { "memo": "gate" },
  });
  canonicalizeProjectDeps("wh");
  const canon = getProposed(child2.id)!;
  assert.deepEqual(JSON.parse(canon.deps), ["MV-17 memo"], "deps canonicalized");
  assert.deepEqual(JSON.parse(canon.dep_types), { "MV-17 memo": "gate" }, "dep_types keys canonicalized in lockstep");
  resetDb();
});

test("WH-20 reject: flags direct dependents with pending re-eval; leaves dep edges + unrelated tasks untouched", () => {
  resetDb();
  const a = addProposed({ project_key: "demo-app", name: "A" });
  const b = addProposed({ project_key: "demo-app", name: "B", deps: ["A"] });
  const c = addProposed({ project_key: "demo-app", name: "C", deps: ["A"] });
  const d = addProposed({ project_key: "demo-app", name: "D" });

  const r = reject(a.id);
  assert.equal(r.task.status, "rejected", "A is rejected");

  const flaggedNames = r.flagged.map((f) => f.name).sort();
  assert.deepEqual(flaggedNames, ["B", "C"], "B and C flagged");

  const bRow = getProposed(b.id)!;
  assert.equal(bRow.reeval_status, "pending", "B reeval_status = pending");
  assert.equal(bRow.reeval_source, a.id, "B reeval_source = A's id");
  assert.match(bRow.reeval_note ?? "", /A/, "reeval_note names the rejected task");
  assert.deepEqual(JSON.parse(bRow.deps), ["A"], "B.deps unchanged — edge not stripped");

  const dRow = getProposed(d.id)!;
  assert.equal(dRow.reeval_status, null, "D untouched");

  assert.ok(r.note && r.note.includes("2"), "note reports 2 flagged dependents");
  resetDb();
});

test("WH-17 gate edge: pushBatch defers a gated dependent; DONE gate flips reeval_status; push then held-back", async () => {
  resetDb();
  const k = mockKrill();
  try {
    const aRow = addProposed({ project_key: "demo-app", name: "A" });
    addProposed({
      project_key: "demo-app",
      name: "B",
      deps: ["A"],
      dep_types: { A: "gate" },
      premise: "assumes GO on A",
    });

    // pushBatch: A pushes, B deferred (gated — not a missing-dep)
    const r = await pushBatch(stubTeam as never, "demo-app");
    assert.equal(r.pushed, 1, "only A pushes");
    assert.equal(r.deferred, 1, "B is deferred");
    assert.equal((r as { heldBack?: number }).heldBack ?? 0, 0, "no held-back (no pending reeval yet)");
    const bResult = (r.results as { name: string; deferred?: boolean; gatedBy?: string[] }[]).find((x) => x.name === "B");
    assert.equal(bResult?.deferred, true, "B result deferred");
    assert.deepEqual(bResult?.gatedBy, ["A"], "B gated by A");
    const bId = listProposed().find((t) => t.name === "B")!.id;
    assert.equal(getProposed(bId)!.status, "proposed", "B stays proposed");

    // simulate A DONE in krill -> enrichPushed cascades reeval_status to B
    const aKid = getProposed(aRow.id)!.krill_task_id!;
    k.setTasks([{ id: aKid, status: "DONE" }]);
    await enrichPushed(listProposed());
    assert.equal(getProposed(bId)!.reeval_status, "pending", "B flagged pending re-evaluation");
    assert.equal(getProposed(bId)!.reeval_source, aRow.id, "reeval_source is A's whale id");

    // push(B) is held-back; B stays proposed
    const r2 = await push(bId);
    assert.equal(r2.pushed, false, "push held-back");
    assert.equal((r2 as { heldBack?: number }).heldBack, 1, "heldBack count is 1");
    assert.equal(getProposed(bId)!.status, "proposed", "B status unchanged");
  } finally {
    k.restore();
    resetDb();
  }
});

test("WH-19 reevaluateSubtree: verdicts kill/keep/revise; reevalApply only changes the target", async () => {
  resetDb();

  // R is a rejected sibling (d3 depends on it and must be revised)
  const rejected = addProposed({ project_key: "demo-app", name: "R" });
  updateProposed(rejected.id, { status: "rejected" });

  // Gate task (krill_task_id set so reevaluateSubtree could theoretically call krill)
  const gate = addProposed({ project_key: "demo-app", name: "G", label: "g" });
  updateProposed(gate.id, { krill_task_id: "kid-g" });

  // d1: contradicted premise → kill
  const d1 = addProposed({
    project_key: "demo-app", name: "D1",
    deps: ["G"], dep_types: { G: "gate" },
    premise: "assumes GO on G",
  });
  // d2: valid premise → keep
  const d2 = addProposed({
    project_key: "demo-app", name: "D2",
    deps: ["G"], dep_types: { G: "gate" },
    premise: "assumes user wants X",
  });
  // d3: dep on rejected R → revise (R dropped from deps)
  const d3 = addProposed({
    project_key: "demo-app", name: "D3",
    deps: ["G", "R"], dep_types: { G: "gate" },
  });

  // result doc names the contradicted premise using the stub protocol
  const result = "gate G done. CONTRADICTED: assumes GO on G";
  const r = await reevaluateSubtree(stubTeam as never, gate.id, { result });

  assert.equal(r.ok, true, "reevaluateSubtree ok");
  assert.equal(getProposed(d1.id)!.reeval_status, "kill",   "d1 verdict=kill (contradicted premise)");
  assert.equal(getProposed(d2.id)!.reeval_status, "keep",   "d2 verdict=keep (premise valid)");
  assert.equal(getProposed(d3.id)!.reeval_status, "revise", "d3 verdict=revise (dep on rejected R)");
  for (const d of [d1, d2, d3])
    assert.ok(getProposed(d.id)!.reeval_note?.length, `${d.name} has non-empty reeval_note`);

  // snapshot canonical fields before any apply
  type Snap = { name: string; description: string; deps: string; status: string };
  const snap = (id: string): Snap => {
    const t = getProposed(id)!;
    return { name: t.name, description: t.description, deps: t.deps, status: t.status };
  };
  const before = { d1: snap(d1.id), d2: snap(d2.id), d3: snap(d3.id) };

  // apply only d3
  reevalApply(d3.id);

  const after = { d1: snap(d1.id), d2: snap(d2.id), d3: snap(d3.id) };
  assert.deepEqual(after.d1, before.d1, "d1 canonical fields unchanged");
  assert.deepEqual(after.d2, before.d2, "d2 canonical fields unchanged");
  assert.notDeepEqual(after.d3, before.d3, "d3 changed after apply");
  assert.deepEqual(JSON.parse(getProposed(d3.id)!.deps), ["G"], "R dropped from d3.deps");
  assert.equal(getProposed(d3.id)!.reeval_status, null, "d3 reeval cleared after apply");

  resetDb();
});

// -- Gate flow: the operator path (trigger -> verdict -> apply) --------------
// These cover the seam WH-16..WH-23 left open: verdicts existed but nothing
// could produce them from the app, and the two fields the machinery keys on
// (dep_types, premise) were unwritable outside a direct DB write.

test("PATCH /api/proposed/:id accepts premise + dep_types, and rejects bogus edges", async () => {
  resetDb();
  const { PATCH } = await import("../src/app/api/proposed/[id]/route");
  const patch = (id: string, body: unknown) =>
    PATCH(new Request(`http://x/api/proposed/${id}`, { method: "PATCH", body: JSON.stringify(body) }), {
      params: Promise.resolve({ id }),
    });

  addProposed({ project_key: "wh", name: "GATE", label: "gate" });
  addProposed({ project_key: "wh", name: "ORD", label: "ord" });
  const child = addProposed({ project_key: "wh", name: "CHILD", deps: ["GATE", "ORD"] });

  // gate tag + premise persist; "order" is stored as an absent key
  let res = await patch(child.id, {
    dep_types: { GATE: "gate", ORD: "order" },
    premise: "  assumes GO on GATE  ",
  });
  assert.equal(res.status, 200);
  let row = getProposed(child.id)!;
  assert.deepEqual(JSON.parse(row.dep_types), { GATE: "gate" }, "only gate edges stored");
  assert.equal(row.premise, "assumes GO on GATE", "premise trimmed");

  // a type on a non-dependency edge is refused, and nothing is written
  res = await patch(child.id, { dep_types: { NOPE: "gate" } });
  assert.equal(res.status, 400, "unknown edge rejected");
  assert.deepEqual(JSON.parse(getProposed(child.id)!.dep_types), { GATE: "gate" }, "prior state intact");

  // an invalid edge type is refused
  res = await patch(child.id, { dep_types: { GATE: "sometimes" } });
  assert.equal(res.status, 400, "invalid dep_type value rejected");

  // full-replacement semantics: submitting all-order clears the gate
  res = await patch(child.id, { dep_types: { GATE: "order", ORD: "order" } });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(getProposed(child.id)!.dep_types), {}, "gate cleared by full replace");

  // premise survives a patch that does not mention it
  await patch(child.id, { priority: "P1" });
  row = getProposed(child.id)!;
  assert.equal(row.premise, "assumes GO on GATE", "premise untouched by unrelated patch");
  assert.equal(row.priority, "P1");
  resetDb();
});

test("PATCH /api/proposed/:id removes a dep edge — the control the rejected-dep flag points at", async () => {
  resetDb();
  const { PATCH } = await import("../src/app/api/proposed/[id]/route");
  const patch = (id: string, body: unknown) =>
    PATCH(new Request(`http://x/api/proposed/${id}`, { method: "PATCH", body: JSON.stringify(body) }), {
      params: Promise.resolve({ id }),
    });

  addProposed({ project_key: "wh", name: "GATE", label: "gate" });
  addProposed({ project_key: "wh", name: "ORD", label: "ord" });
  addProposed({ project_key: "other", name: "FOREIGN" });
  const child = addProposed({
    project_key: "wh", name: "CHILD", deps: ["GATE", "ORD"], dep_types: { GATE: "gate" },
  });

  // dropping an edge drops its type with it — a type on a non-existent edge is
  // invisible in the UI and silently wrong at push time
  let res = await patch(child.id, { deps: ["ORD"] });
  assert.equal(res.status, 200);
  let row = getProposed(child.id)!;
  assert.deepEqual(JSON.parse(row.deps), ["ORD"], "edge removed");
  assert.deepEqual(JSON.parse(row.dep_types), {}, "the gate type went with it");

  // deps + dep_types in one PATCH: the type is validated against the INCOMING
  // edges, not the stored ones (the editor always sends both)
  res = await patch(child.id, { deps: ["GATE", "ORD"], dep_types: { GATE: "gate", ORD: "order" } });
  assert.equal(res.status, 200);
  row = getProposed(child.id)!;
  assert.deepEqual(JSON.parse(row.deps).sort(), ["GATE", "ORD"]);
  assert.deepEqual(JSON.parse(row.dep_types), { GATE: "gate" }, "re-added edge can be re-typed in the same call");

  // guards
  assert.equal((await patch(child.id, { deps: ["NOPE"] })).status, 400, "unknown task rejected");
  assert.equal((await patch(child.id, { deps: ["FOREIGN"] })).status, 400, "cross-project dep rejected");
  assert.equal((await patch(child.id, { deps: ["CHILD"] })).status, 400, "self-dep rejected");
  assert.equal((await patch(child.id, { deps: "GATE" })).status, 400, "deps must be an array");
  assert.deepEqual(JSON.parse(getProposed(child.id)!.deps).sort(), ["GATE", "ORD"], "no partial write on a rejected patch");

  // a dangling edge (upstream deleted) is exactly what the operator opens the
  // editor to remove — it must survive being resubmitted, not 400
  const ghost = addProposed({ project_key: "wh", name: "GHOST" });
  await patch(child.id, { deps: ["GATE", "ORD", "GHOST"] });
  deleteProposed(ghost.id);
  res = await patch(child.id, { deps: ["GATE", "GHOST"] });
  assert.equal(res.status, 200, "dangling edge can be resubmitted");
  res = await patch(child.id, { deps: ["GATE"] });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(getProposed(child.id)!.deps), ["GATE"], "and removed");
  resetDb();
});

test("krill.getTaskResult builds an outcome from diff_text + comments, null when neither exists", async () => {
  const orig = globalThis.fetch;
  const reply = (task: Record<string, unknown>, comments: unknown[]) => {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      const data = u.includes("/comments") ? { comments } : { task };
      return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  };
  const krill = await import("../src/lib/krill-client");
  try {
    // diff + comments both fold into the result
    reply(
      { name: "MV-17 memo", status: "DONE", acceptance: "memo exists", diff_text: "+ NO-GO recommended" },
      [{ stage: "AI-REVIEW", text: "approve: gates stated" }],
    );
    const full = await krill.getTaskResult("MV-17");
    assert.ok(full, "result assembled");
    assert.match(full!, /MV-17 memo \(DONE\)/, "header names the task + status");
    assert.match(full!, /NO-GO recommended/, "diff text included");
    assert.match(full!, /\[AI-REVIEW\] approve/, "stage notes included");

    // comments alone are still an outcome (non-dev tasks that changed no files)
    reply({ name: "T", status: "DONE" }, [{ stage: "IMPLEMENTING", text: "survey returned N=12" }]);
    const notesOnly = await krill.getTaskResult("T");
    assert.match(notesOnly!, /N=12/);

    // metadata with no diff and no comments is NOT an outcome -> operator pastes
    reply({ name: "T", status: "DONE", acceptance: "something" }, []);
    assert.equal(await krill.getTaskResult("T"), null, "no fabricated result");

    // provenance travels with the text: "krill's own result field" and "we glued
    // this together from stage notes" are very different levels of trust, and the
    // operator decides whether to replace the text based on which one it is
    reply({ name: "T", status: "DONE", diff_text: "+ x" }, [{ stage: "AI-REVIEW", text: "ok" }]);
    assert.equal((await krill.getTaskOutcome("T"))?.source, "diff+notes");
    reply({ name: "T", status: "DONE", diff_text: "+ x" }, []);
    assert.equal((await krill.getTaskOutcome("T"))?.source, "diff");
    reply({ name: "T", status: "DONE" }, [{ stage: "IMPLEMENTING", text: "N=12" }]);
    assert.equal((await krill.getTaskOutcome("T"))?.source, "notes");
    reply({ name: "T", status: "CANCELED", result: "called off" }, []);
    const own = await krill.getTaskOutcome("T");
    assert.equal(own?.source, "result");
    assert.equal(own?.krill_status, "CANCELED", "krill status rides along for the dialog header");
  } finally {
    globalThis.fetch = orig;
  }
});

test("reevaluateSubtree reports needsResult when krill has no outcome, and accepts a pasted one", async () => {
  resetDb();
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    const data = u.includes("/comments") ? { comments: [] } : { task: { name: "G", status: "DONE" } };
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const gate = addProposed({ project_key: "wh", name: "G", label: "g" });
    updateProposed(gate.id, { status: "pushed", krill_task_id: "WH-1" });
    addProposed({
      project_key: "wh", name: "D", deps: ["G"],
      dep_types: { G: "gate" }, premise: "assumes GO on G",
    });

    const blank = await reevaluateSubtree(stubTeam as never, gate.id);
    assert.equal(blank.ok, false, "no outcome -> not ok");
    assert.equal(blank.needsResult, true, "operator is asked for the result");
    assert.equal(getProposed(gate.id)!.reeval_status, null, "nothing stamped on a failed read");

    const pasted = await reevaluateSubtree(stubTeam as never, gate.id, { result: "CONTRADICTED: no-go, premise dead" });
    assert.equal(pasted.ok, true, "pasted result evaluates");
    assert.ok((pasted.verdicts ?? []).length > 0, "verdicts produced for the dependent");
  } finally {
    globalThis.fetch = orig;
    resetDb();
  }
});

test("resolving a gate verdict is durable: no re-stamp loop, and the task becomes pushable", async () => {
  resetDb();
  const k = mockKrill();
  try {
    // two gates over one dependent — the shape that a single-slot marker breaks
    const g1 = addProposed({ project_key: "demo-app", name: "G1", label: "g1" });
    const g2 = addProposed({ project_key: "demo-app", name: "G2", label: "g2" });
    updateProposed(g1.id, { status: "pushed", krill_task_id: "K1" });
    updateProposed(g2.id, { status: "pushed", krill_task_id: "K2" });
    const dep = addProposed({
      project_key: "demo-app", name: "D", deps: ["G1", "G2"],
      dep_types: { G1: "gate", G2: "gate" }, premise: "assumes GO on both",
    });
    k.setTasks([{ id: "K1", status: "DONE" }, { id: "K2", status: "RUNNING" }]);

    // G1 finished -> dependent flagged pending by the poll
    await enrichPushed([getProposed(g1.id)!, getProposed(g2.id)!]);
    assert.equal(getProposed(dep.id)!.reeval_status, "pending", "flagged when G1 lands");
    assert.equal(getProposed(dep.id)!.reeval_source, g1.id);

    // operator resolves it (keep) -> verdict cleared, G1 recorded as handled
    updateProposed(dep.id, { reeval_status: "keep" , reeval_source: g1.id });
    reevalApply(dep.id);
    let after = getProposed(dep.id)!;
    assert.equal(after.reeval_status, null, "verdict cleared on apply");
    assert.deepEqual(JSON.parse(after.reeval_resolved), [g1.id], "G1 recorded as resolved");

    // the poll runs again with G1 still DONE — it must NOT re-raise the flag
    await enrichPushed([getProposed(g1.id)!, getProposed(g2.id)!]);
    assert.equal(getProposed(dep.id)!.reeval_status, null, "no re-stamp loop for a resolved gate");

    // still not pushable: G2 is a gate that has not resolved yet
    let r = await push(dep.id, { confirm: true });
    assert.equal(r.pushed, false, "held while G2 unresolved");
    assert.deepEqual(r.gatedBy, ["G2"], "only the unresolved gate is named");

    // G2 finishes -> flagged again, for G2 this time
    k.setTasks([{ id: "K1", status: "DONE" }, { id: "K2", status: "DONE" }]);
    await enrichPushed([getProposed(g1.id)!, getProposed(g2.id)!]);
    after = getProposed(dep.id)!;
    assert.equal(after.reeval_status, "pending", "second gate raises its own flag");
    assert.equal(after.reeval_source, g2.id);

    // dismissing also counts as resolved -> now nothing gates it
    reevalDismiss(dep.id);
    after = getProposed(dep.id)!;
    assert.deepEqual(JSON.parse(after.reeval_resolved).sort(), [g1.id, g2.id].sort(), "both gates recorded");
    await enrichPushed([getProposed(g1.id)!, getProposed(g2.id)!]);
    assert.equal(getProposed(dep.id)!.reeval_status, null, "stays clear after both resolved");

    r = await push(dep.id, { confirm: true });
    assert.notEqual(r.deferred, true, "pushes once every gate is resolved");
  } finally {
    k.restore();
    resetDb();
  }
});

test("gate guard fails open when the upstream proposal is gone", async () => {
  resetDb();
  const k = mockKrill();
  try {
    // A live gate blocks normally...
    const gate = addProposed({ project_key: "demo-app", name: "G", label: "g" });
    updateProposed(gate.id, { status: "pushed", krill_task_id: "K1" });
    k.setTasks([{ id: "K1", status: "DONE" }]);
    const dep = addProposed({
      project_key: "demo-app", name: "D", deps: ["G"],
      dep_types: { G: "gate" }, premise: "assumes GO on G",
    });
    assert.deepEqual(unresolvedGates(getProposed(dep.id)!), ["G"], "live gate blocks");

    // ...but a gate edge naming a proposal that does not exist must NOT. There is
    // no row to run Re-evaluate on and no verdict band to dismiss, so failing
    // closed would strand the dependent with no in-app way out. This is the state
    // left by deleting an upstream, and by an edge naming something never
    // distilled. Ordinary dep ordering still refuses an unsatisfied name.
    const orphan = addProposed({
      project_key: "demo-app", name: "O", deps: ["GHOST"],
      dep_types: { GHOST: "gate" }, premise: "assumes GO on GHOST",
    });
    assert.deepEqual(unresolvedGates(getProposed(orphan.id)!), [], "absent upstream gates nothing");

    // and the same once a real upstream is deleted mid-flight
    deleteProposed(gate.id);
    assert.deepEqual(unresolvedGates(getProposed(dep.id)!), [], "deleted upstream gates nothing");
    const r = await push(dep.id, { confirm: true });
    assert.notEqual(r.deferred, true, "not deferred by a gate that no longer exists");
  } finally {
    k.restore();
    resetDb();
  }
});

test("withGateState ships exactly the gates push refuses on (UI cannot drift from the guard)", async () => {
  resetDb();
  const k = mockKrill();
  try {
    const gate = addProposed({ project_key: "demo-app", name: "G", label: "g" });
    updateProposed(gate.id, { status: "pushed", krill_task_id: "K1" });
    k.setTasks([{ id: "K1", status: "DONE" }]);
    const dep = addProposed({
      project_key: "demo-app", name: "D", deps: ["G"],
      dep_types: { G: "gate" }, premise: "assumes GO on G",
    });
    const free = addProposed({ project_key: "demo-app", name: "F" });

    const rowOf = (id: string) => withGateState(listProposed()).find((p) => p.id === id)!;
    assert.deepEqual(rowOf(dep.id).gated_by, ["G"], "gated row carries the reason");
    assert.deepEqual(rowOf(free.id).gated_by, [], "ungated row carries an empty list, never undefined");

    // what the UI greys out === the names the server refuses on
    const held = await push(dep.id, { confirm: true });
    assert.equal(held.deferred, true, "server defers it");
    assert.deepEqual(held.gatedBy, rowOf(dep.id).gated_by, "same names on both sides");

    // A caller's stale copy must not leak through: withGateState re-reads the row,
    // so a pre-stamp copy still reports the gate that enrichPushed just raised.
    await enrichPushed([getProposed(gate.id)!]);
    const staleCopy = { ...dep, reeval_status: null, reeval_resolved: "[]" };
    assert.deepEqual(withGateState([staleCopy])[0].gated_by, ["G"], "checked against the live row");

    reevalDismiss(dep.id);
    assert.deepEqual(rowOf(dep.id).gated_by, [], "clears once resolved");
    const sent = await push(dep.id, { confirm: true });
    assert.notEqual(sent.deferred, true, "server agrees");
  } finally {
    k.restore();
    resetDb();
  }
});

test("reevaluate preview returns krill's outcome + dependent list without evaluating", async () => {
  resetDb();
  const orig = globalThis.fetch;
  // Every outbound call the preview makes, so "it only reads krill" is asserted
  // rather than assumed. The evaluation itself runs through the stage stub under
  // test config, so it makes no request of its own — the observable proof that
  // preview skipped it is that it produced no verdicts and stamped no rows.
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/comments")) return new Response(JSON.stringify({ comments: [] }), { status: 200 });
    return new Response(
      JSON.stringify({ task: { name: "G", status: "DONE", diff_text: "+ stale scaffold, no findings yet" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const gate = addProposed({ project_key: "demo-app", name: "G", label: "g" });
    updateProposed(gate.id, { status: "pushed", krill_task_id: "K1" });
    addProposed({
      project_key: "demo-app", name: "D1", deps: ["G"],
      dep_types: { G: "gate" }, premise: "assumes GO on G",
    });
    addProposed({ project_key: "demo-app", name: "D2", deps: ["D1"], premise: "needs D1" });

    const pre = await reevaluateSubtree(stubTeam as never, gate.id, { preview: true });
    assert.equal(pre.preview, true);
    assert.match(pre.result!, /stale scaffold/, "shows the operator what krill actually holds");
    assert.deepEqual(pre.dependents!.sort(), ["D1", "D2"], "whole subtree listed, not just direct deps");
    assert.equal(pre.resultSource, "diff", "dialog can say where the text came from");
    assert.equal(pre.krillStatus, "DONE");
    assert.deepEqual(pre.skipped, [], "nothing held by another gate");

    // preview evaluated nothing: no verdicts, no rows stamped, and the only
    // outbound traffic was the krill result read
    assert.equal(pre.verdicts, undefined, "preview returns no verdicts");
    for (const n of ["D1", "D2"]) {
      const t = listProposed().find((x) => x.name === n)!;
      assert.equal(t.reeval_status, null, `${n} untouched by preview`);
    }
    assert.ok(urls.length > 0, "preview did read krill");
    assert.deepEqual(
      urls.filter((u) => !u.includes("/api/tasks/")),
      [],
      "preview talks to nothing but the krill task read",
    );

    // an operator-supplied result overrides the stale krill text
    const run = await reevaluateSubtree(stubTeam as never, gate.id, { result: "CONTRADICTED: no-go" });
    assert.equal(run.ok, true);
    assert.ok((run.verdicts ?? []).length > 0, "verdicts written from the pasted result");
  } finally {
    globalThis.fetch = orig;
    resetDb();
  }
});

test("a second gate does not silently overwrite the first gate's unreviewed verdicts", async () => {
  resetDb();
  try {
    // Two gates over one dependent — the whale board's actual shape. Both reach D
    // because collectDescendants walks every edge, so without a guard the second
    // run replaces the first's verdict and the operator never learns it happened.
    const g1 = addProposed({ project_key: "demo-app", name: "G1", label: "g1" });
    const g2 = addProposed({ project_key: "demo-app", name: "G2", label: "g2" });
    const dep = addProposed({
      project_key: "demo-app", name: "D", deps: ["G1", "G2"],
      dep_types: { G1: "gate", G2: "gate" }, premise: "assumes GO on both",
    });

    const first = await reevaluateSubtree(stubTeam as never, g1.id, { result: "GO — proceed" });
    assert.equal(first.ok, true);
    const afterFirst = getProposed(dep.id)!;
    assert.ok(afterFirst.reeval_status, "G1 wrote a verdict");
    assert.equal(afterFirst.reeval_source, g1.id);
    const verdictFromG1 = afterFirst.reeval_status;

    // G2's preview warns BEFORE the model call
    const pre = await reevaluateSubtree(stubTeam as never, g2.id, { preview: true, result: "x" });
    assert.deepEqual(pre.dependents, ["D"], "D is in G2's subtree");
    assert.equal(pre.skipped?.length, 1, "preview reports the collision");
    assert.equal(pre.skipped![0].name, "D");
    assert.equal(pre.skipped![0].heldBy, "G1", "named by gate, not by raw id");
    assert.equal(pre.skipped![0].verdict, verdictFromG1);

    // running G2 leaves the verdict alone and reports what it skipped
    const second = await reevaluateSubtree(stubTeam as never, g2.id, { result: "CONTRADICTED: assumes GO on both" });
    assert.equal(second.ok, true);
    assert.deepEqual(second.verdicts, [], "nothing left to judge");
    assert.equal(second.skipped?.length, 1, "collision reported on the real run too");
    const untouched = getProposed(dep.id)!;
    assert.equal(untouched.reeval_status, verdictFromG1, "first gate's verdict survives");
    assert.equal(untouched.reeval_source, g1.id, "and still belongs to G1");

    // explicit opt-in does replace it
    const forced = await reevaluateSubtree(stubTeam as never, g2.id, {
      result: "CONTRADICTED: assumes GO on both",
      overwrite: true,
    });
    assert.deepEqual(forced.skipped, [], "nothing skipped when overwriting");
    assert.equal(forced.verdicts?.length, 1, "D judged this time");
    const replaced = getProposed(dep.id)!;
    assert.equal(replaced.reeval_status, "kill", "premise contradicted by G2");
    assert.equal(replaced.reeval_source, g2.id, "now owned by G2");

    // a bare `pending` flag is not a verdict — it must never block a real one
    updateProposed(dep.id, { reeval_status: "pending", reeval_source: g1.id, reeval_revision: null });
    const overPending = await reevaluateSubtree(stubTeam as never, g2.id, { result: "GO — proceed" });
    assert.deepEqual(overPending.skipped, [], "pending is a flag, not a judgement");
    assert.equal(getProposed(dep.id)!.reeval_source, g2.id, "G2's verdict replaces the flag");
  } finally {
    resetDb();
  }
});
