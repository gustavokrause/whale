// baleia smoke tests — the merge gate. Zero deps (node:test). Run: npm test
//
// Covers the spine: persona-loader, db round-trip, and the triage gates
// (incl. the self-edit guard that protects the orchestrator).

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import { config } from "../src/config.mjs";
import { loadTeam } from "../src/persona-loader.mjs";
import {
  openDb, addEntry, listEntries, rawEntries, markEntries, setEntryLane,
  addProposed, listProposed, updateProposed, getProposed,
} from "../src/db.mjs";
import { triage, flowPreview } from "../src/stages.mjs";
import { push, pushBatch, refine } from "../src/pipeline.mjs";

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
  const path = join(tmpdir(), `baleia-test-${randomUUID()}.db`);
  const db = openDb(path);
  try {
    const e = addEntry(db, { text: "hello", projectHint: "krill" });
    assert.equal(e.status, "raw");
    assert.equal(listEntries(db).length, 1);
    assert.equal(rawEntries(db).length, 1);

    setEntryLane(db, e.id, { lane: "task" });
    assert.equal(listEntries(db)[0].lane, "task");

    markEntries(db, [e.id], "distilled");
    assert.equal(rawEntries(db).length, 0, "distilled entries leave the raw queue");

    const t = addProposed(db, { project_key: "krill", name: "x", risk_tier: "low", bypass: 1, deps: ["y"] });
    assert.equal(listProposed(db, "proposed").length, 1);
    assert.deepEqual(JSON.parse(t.deps), ["y"], "deps round-trip (B2)");
    updateProposed(db, t.id, { status: "approved" });
    assert.equal(listProposed(db, "approved").length, 1);

    assert.throws(() => addEntry(db, { text: "   " }), "empty entry rejected");
  } finally {
    db.close?.();
    rmSync(path, { force: true });
  }
});

test("triage classifies risk correctly", () => {
  const team = { risk: { safeWords: ["pricing", "legal"] } };
  const t = (name, project_key) => triage(team, { name, description: "", project_key });

  assert.equal(t("fix typo in readme", "arqtrack").risk_tier, "low");
  assert.equal(t("add a db migration", "arqtrack").risk_tier, "high", "irreversible keyword");
  assert.equal(t("change the pricing tier", "arqtrack").risk_tier, "high", "safe-word");
  assert.equal(t("build a maintenance log", "mv").risk_tier, "medium", "default");
});

test("autonomy ladder: dial controls how far a task bypasses (B1)", () => {
  const team = { risk: { safeWords: [] } };
  const bypass = (name, key, dial) => triage(team, { name, description: "", project_key: key }, dial).bypass;
  const low = "fix typo";            // low risk
  const med = "build a feature";     // medium (default)

  // conservative: nothing bypasses
  assert.equal(bypass(low, "arqtrack", "conservative"), false);
  assert.equal(bypass(med, "arqtrack", "conservative"), false);
  // balanced: low bypasses, medium reviewed
  assert.equal(bypass(low, "arqtrack", "balanced"), true);
  assert.equal(bypass(med, "arqtrack", "balanced"), false);
  // aggressive: low + medium bypass
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
  const path = join(tmpdir(), `baleia-b3-${randomUUID()}.db`);
  const db = openDb(path);
  const team = { risk: { safeWords: [] } };
  try {
    const t = addProposed(db, { project_key: "arqtrack", name: "add export", description: "csv", risk_tier: "medium" });
    const r = await refine(team, db, t.id, "also support json");
    assert.match(r.task.description, /json/, "stub folds the input in");
    assert.equal(JSON.parse(r.task.refine_log).length, 1, "turn logged");
    assert.equal(r.task.status, "proposed", "re-opened for next decision");
    assert.ok(typeof r.flow === "string" && r.flow.length, "flow preview returned");
  } finally {
    db.close?.();
    rmSync(path, { force: true });
  }
});

test("B4 arm-time confirm: auto-finish push/batch needs a distinct confirm", async () => {
  const path = join(tmpdir(), `baleia-b4-${randomUUID()}.db`);
  const db = openDb(path);
  try {
    const t = addProposed(db, { project_key: "arqtrack", name: "x", risk_tier: "low", auto_publish: true });
    // no confirm → short-circuits with needsConfirm (before any krill call)
    const r = await push(db, t.id);
    assert.equal(r.needsConfirm, true, "single push needs confirm");
    assert.equal(getProposed(db, t.id).status, "proposed", "not pushed yet");
    const b = await pushBatch(null, db, "arqtrack");
    assert.equal(b.needsConfirm, true, "batch needs confirm");
  } finally {
    db.close?.();
    rmSync(path, { force: true });
  }
});

test("auto-finish rung (A2): auto_publish only for aggressive + low + non-self-edit", () => {
  const team = { risk: { safeWords: [] } };
  const ap = (name, key, dial) => triage(team, { name, description: "", project_key: key }, dial).auto_publish;
  assert.equal(ap("fix typo", "arqtrack", "aggressive"), true, "aggressive low -> auto-finish");
  assert.equal(ap("fix typo", "arqtrack", "balanced"), false, "balanced low -> no auto-finish");
  assert.equal(ap("build a feature", "arqtrack", "aggressive"), false, "medium never auto-finishes");
  assert.equal(ap("fix typo", "baleia", "aggressive"), false, "self-edit never auto-finishes");
});

test("self-edit guard: orchestrator tasks never bypass, any dial", () => {
  const team = { risk: { safeWords: [] } };
  // under aggressive a non-self-edit low WOULD bypass...
  assert.equal(
    triage(team, { name: "fix typo", description: "", project_key: "arqtrack" }, "aggressive").bypass,
    true,
  );
  // ...but a self-edit is forced to high + review regardless of dial
  for (const key of config.autonomy.protected) {
    for (const dial of ["conservative", "balanced", "aggressive"]) {
      const self = triage(team, { name: "fix typo", description: "", project_key: key }, dial);
      assert.equal(self.risk_tier, "high", `${key} self-edit is high risk`);
      assert.equal(self.bypass, false, `${key} self-edit never bypasses (${dial})`);
    }
  }
});
