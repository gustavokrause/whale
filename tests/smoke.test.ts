// whale smoke tests — the merge gate. Run: npm test (DB_PATH=data/test.db).
// Singleton drizzle db; resetDb() isolates the db-touching tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import { config, isReal, setConfigOverrides } from "../src/lib/config";
import { loadTeam } from "../src/lib/persona-loader";
import { db } from "../src/db/client";
import { inboxEntries, proposedTasks, config as configTable } from "../src/db/schema";
import {
  addEntry, listEntries, rawEntries, markEntries,
  addProposed, listProposed, updateProposed, getProposed,
  readConfig, writeConfig, pendingRequests,
  addBlocker, listBlockers, resolveBlocker,
} from "../src/db/queries";
import { blockers } from "../src/db/schema";
import { triage, flowPreview, plan } from "../src/lib/stages";
import { push, pushBatch, refine } from "../src/lib/pipeline";
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
  assert.equal(t("fix typo in readme", "arqtrack").risk_tier, "low");
  assert.equal(t("add a db migration", "arqtrack").risk_tier, "high", "irreversible keyword");
  assert.equal(t("change the pricing tier", "arqtrack").risk_tier, "high", "safe-word");
  assert.equal(t("build a maintenance log", "mv").risk_tier, "medium", "default");
});

test("autonomy ladder: dial controls how far a task bypasses (B1)", () => {
  const bypass = (name: string, key: string, dial: string) =>
    triage(stubTeam, { name, description: "", project_key: key }, dial).bypass;
  const low = "fix typo";
  const med = "build a feature";
  assert.equal(bypass(low, "arqtrack", "conservative"), false);
  assert.equal(bypass(med, "arqtrack", "conservative"), false);
  assert.equal(bypass(low, "arqtrack", "balanced"), true);
  assert.equal(bypass(med, "arqtrack", "balanced"), false);
  assert.equal(bypass(low, "arqtrack", "aggressive"), true);
  assert.equal(bypass(med, "arqtrack", "aggressive"), true);
});

test("flow preview reflects the gates a task will hit (B3)", () => {
  assert.match(flowPreview({ risk_tier: "high" }), /full review/);
  assert.match(flowPreview({ risk_tier: "low", auto_publish: true }), /auto-finish/);
  assert.match(flowPreview({ risk_tier: "low", bypass: true }), /deliverable/);
  assert.equal(flowPreview({ risk_tier: "low" }), "stops at plan review");
});

test("B3 refine: Input re-evaluates + re-triages + logs the turn", async () => {
  resetDb();
  const t = addProposed({ project_key: "arqtrack", name: "add export", description: "csv", risk_tier: "medium" });
  const r = await refine(stubTeam as never, t.id, "also support json");
  assert.match(r.task.description, /json/, "stub folds the input in");
  assert.equal(JSON.parse(r.task.refine_log).length, 1, "turn logged");
  assert.equal(r.task.status, "proposed", "re-opened for next decision");
  assert.ok(typeof r.flow === "string" && r.flow.length, "flow preview returned");
});

test("B4 arm-time confirm: auto-finish push/batch needs a distinct confirm", async () => {
  resetDb();
  const t = addProposed({ project_key: "arqtrack", name: "x", risk_tier: "low", auto_publish: true });
  const r = await push(t.id);
  assert.equal(r.needsConfirm, true, "single push needs confirm");
  assert.equal(getProposed(t.id)!.status, "proposed", "not pushed yet");
  const b = await pushBatch(stubTeam as never, "arqtrack");
  assert.equal(b.needsConfirm, true, "batch needs confirm");
});

test("auto-finish rung (A2): auto_publish only for aggressive + low + non-self-edit", () => {
  const ap = (name: string, key: string, dial: string) =>
    triage(stubTeam, { name, description: "", project_key: key }, dial).auto_publish;
  assert.equal(ap("fix typo", "arqtrack", "aggressive"), true, "aggressive low -> auto-finish");
  assert.equal(ap("fix typo", "arqtrack", "balanced"), false, "balanced low -> no auto-finish");
  assert.equal(ap("build a feature", "arqtrack", "aggressive"), false, "medium never auto-finishes");
  assert.equal(ap("fix typo", "whale", "aggressive"), false, "self-edit never auto-finishes");
});

test("autonomous rung: auto_publish for low+medium, NOT high, NOT self-edit", () => {
  const tri = (name: string, key: string) =>
    triage(stubTeam, { name, description: "", project_key: key }, "autonomous");
  assert.equal(tri("fix typo", "arqtrack").auto_publish, true, "low -> auto");
  assert.equal(tri("build a feature", "arqtrack").auto_publish, true, "medium -> auto");
  assert.equal(tri("add a db migration", "arqtrack").auto_publish, false, "high -> NOT auto");
  assert.equal(tri("add a db migration", "arqtrack").bypass, false, "high -> full review (no bypass)");
  assert.equal(tri("fix typo", "whale").auto_publish, false, "self-edit never auto");
});

test("ludicrous rung: auto_publish for EVERY tier except self-edit", () => {
  const ap = (name: string, key: string) =>
    triage(stubTeam, { name, description: "", project_key: key }, "ludicrous").auto_publish;
  assert.equal(ap("fix typo", "arqtrack"), true, "low -> auto");
  assert.equal(ap("build a feature", "arqtrack"), true, "medium -> auto");
  assert.equal(ap("add a db migration", "arqtrack"), true, "high (irreversible) -> auto");
  assert.equal(ap("change the pricing tier", "arqtrack"), true, "high (safe-word) -> auto");
  assert.equal(ap("fix typo", "whale"), false, "self-edit never auto, even ludicrous");
  assert.equal(ap("fix typo", "krill"), false, "self-edit never auto, even ludicrous");
});

test("self-edit guard: orchestrator tasks never bypass, any dial", () => {
  assert.equal(
    triage(stubTeam, { name: "fix typo", description: "", project_key: "arqtrack" }, "aggressive").bypass,
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
  addBlocker({ kind: "mcp_auth", trigger_kind: "plan", trigger_ref: "arqtrack", summary: "other" });
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
  globalThis.fetch = (async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    const method = opts.method || "GET";
    const u = String(url);
    const body = opts.body ? (JSON.parse(opts.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url: u, body });
    let data: unknown = {};
    if (u.includes("/api/health")) data = {};
    else if (u.includes("/api/projects")) data = [{ id: "proj1", slug: "ZT", name: "arqtrack", folder_path: "/x", has_repo: true }];
    else if (method === "POST" && u.includes("/api/tasks")) data = { id: `kid-${++seq}` };
    else if (u.includes("/api/tasks")) data = { tasks: [] };
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    calls,
    posts: () => calls.filter((c) => c.method === "POST" && c.url.includes("/api/tasks")),
    restore: () => { globalThis.fetch = orig; },
  };
}

test("WH-11 push(id): refuses when a dependency isn't in krill; passes depends_on once it is", async () => {
  resetDb();
  const k = mockKrill();
  try {
    // dep not in krill -> push_failed, no task created
    const b = addProposed({ project_key: "arqtrack", name: "B", deps: ["A"] });
    const r1 = await push(b.id);
    assert.equal(r1.pushed, false, "blocked push doesn't go through");
    assert.match(r1.error ?? "", /dependency not in krill/i);
    assert.equal(getProposed(b.id)!.status, "push_failed");
    assert.equal(k.posts().length, 0, "no krill task created for a dep-blocked push");

    // push A first, then B resolves the dep -> depends_on carries A's id
    const a = addProposed({ project_key: "arqtrack", name: "A" });
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
    const a = addProposed({ project_key: "arqtrack", name: "A" });
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
    const t = addProposed({ project_key: "arqtrack", name: "checkout persists plan", acceptance: acc });
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
    const t = addProposed({ project_key: "arqtrack", name: "no acceptance" });
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
    addProposed({ project_key: "arqtrack", name: "A" });
    addProposed({ project_key: "arqtrack", name: "B", deps: ["A"] });
    const r = await pushBatch(stubTeam as never, "arqtrack");
    assert.equal(r.pushed, 2, "both push");
    assert.equal(r.deferred ?? 0, 0, "nothing deferred when the dep is in-batch");
    const bPost = k.posts().find((p) => p.body!.name === "B")!;
    const aPost = k.posts().find((p) => p.body!.name === "A")!;
    assert.deepEqual(bPost.body!.depends_on, [(await krillIdFor(aPost))], "B depends on A's krill id");

    // C depends on a ghost upstream that's neither in batch nor in krill -> defer
    resetDb();
    addProposed({ project_key: "arqtrack", name: "C", deps: ["ghost"] });
    const r2 = await pushBatch(stubTeam as never, "arqtrack");
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
