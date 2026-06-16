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
} from "../src/db/queries";
import { triage, flowPreview, plan } from "../src/lib/stages";
import { push, pushBatch, refine } from "../src/lib/pipeline";

function resetDb() {
  db.delete(proposedTasks).run();
  db.delete(inboxEntries).run();
  db.delete(configTable).run();
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
    for (const dial of ["conservative", "balanced", "aggressive", "ludicrous"]) {
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
