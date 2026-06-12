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
  addProposed, listProposed, updateProposed,
} from "../src/db.mjs";
import { triage } from "../src/stages.mjs";

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

    const t = addProposed(db, { project_key: "krill", name: "x", risk_tier: "low", bypass: 1 });
    assert.equal(listProposed(db, "proposed").length, 1);
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
  assert.equal(t("fix typo in readme", "arqtrack").bypass, true);
  assert.equal(t("add a db migration", "arqtrack").risk_tier, "high", "irreversible keyword");
  assert.equal(t("change the pricing tier", "arqtrack").risk_tier, "high", "safe-word");
  assert.equal(t("build a maintenance log", "mv").risk_tier, "medium", "default");
});

test("self-edit guard: orchestrator tasks never bypass", () => {
  const team = { risk: { safeWords: [] } };
  // a trivial task that WOULD normally bypass...
  const other = triage(team, { name: "fix typo", description: "", project_key: "arqtrack" });
  assert.equal(other.bypass, true);
  // ...is forced to high + review when it targets the orchestrator
  for (const key of config.autonomy.protected) {
    const self = triage(team, { name: "fix typo", description: "", project_key: key });
    assert.equal(self.risk_tier, "high", `${key} self-edit is high risk`);
    assert.equal(self.bypass, false, `${key} self-edit never bypasses`);
  }
});
