// C5 Nth-of-class recurrence + C7 prior-routing note — seeded rows, no LLM.

import { test } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/db/client";
import { proposedTasks } from "../src/db/schema";
import { addProposed } from "../src/db/queries";
import { classRecurrenceCount, priorRoutingNote } from "../src/lib/stages";

test("classRecurrenceCount: counts same-label proposals per project", () => {
  db.delete(proposedTasks).run();
  try {
    addProposed({ project_key: "rc", name: "fix build 1", label: "build" });
    addProposed({ project_key: "rc", name: "fix build 2", label: "Build" }); // case-insensitive
    addProposed({ project_key: "rc", name: "copy tweak", label: "copy" });
    addProposed({ project_key: "other", name: "fix build 3", label: "build" }); // other project

    assert.equal(classRecurrenceCount("rc", "build"), 2);
    assert.equal(classRecurrenceCount("rc", "copy"), 1);
    assert.equal(classRecurrenceCount("rc", null), 0);
    assert.equal(classRecurrenceCount("rc", "  "), 0);
  } finally {
    db.delete(proposedTasks).run();
  }
});

test("priorRoutingNote: newest-first owner lines, capped, deduped", () => {
  db.delete(proposedTasks).run();
  try {
    addProposed({ project_key: "pr", name: "t1", plan_run_id: "run-aaaa1111", owner_persona: "Maria" });
    addProposed({ project_key: "pr", name: "t2", plan_run_id: "run-aaaa1111", owner_persona: "Rafael" });
    addProposed({ project_key: "pr", name: "t3", plan_run_id: "run-aaaa1111", owner_persona: "Maria" }); // dedup
    addProposed({ project_key: "pr", name: "t4", plan_run_id: "run-bbbb2222", owner_persona: "Lucas" });
    addProposed({ project_key: "other", name: "t5", plan_run_id: "run-cccc3333", owner_persona: "Ana" });

    const note = priorRoutingNote("pr");
    // Owner order within a run is timestamp-arbitrary — assert membership only.
    assert.match(note, /run run-aaaa: owned by .*Maria/);
    assert.match(note, /run run-aaaa: owned by .*Rafael/);
    assert.equal((note.match(/Maria/g) ?? []).length, 1, "same owner listed once per run");
    assert.match(note, /run-bbbb: owned by Lucas/);
    assert.doesNotMatch(note, /Ana/, "other project's runs excluded");
    assert.equal(priorRoutingNote("empty-project"), "");
  } finally {
    db.delete(proposedTasks).run();
  }
});
