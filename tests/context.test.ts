// context-store test — point WHALE_CONTEXT_DIR at a temp dir before importing the
// module (it reads the env at load), so this can't touch real memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

const CTX = join(tmpdir(), `whale-ctx-${randomUUID()}`);
process.env.WHALE_CONTEXT_DIR = CTX;

test("context-store writes and reads living context", async () => {
  const cs = await import("../src/lib/context-store");
  try {
    cs.writeContext("krill", "# CONTEXT — krill\n\nhi");
    assert.match(cs.readContext("krill"), /CONTEXT — krill/);
    assert.ok(cs.listContextKeys().includes("krill"));
    assert.equal(cs.readContext("does-not-exist"), "", "missing key returns empty");
  } finally {
    rmSync(CTX, { recursive: true, force: true });
  }
});

test("mergeContext: preserved sections survive; non-preserved replaced wholesale", async () => {
  const cs = await import("../src/lib/context-store");
  const existing =
    "# CONTEXT — x\n\n## Stack\nold stack\n\n## Decisions\n- ship weekly\n\n## Standing principles\n- keep it small";
  const incoming = "# CONTEXT — x\n\n## Stack\nnew stack";
  const merged = cs.mergeContext(existing, incoming);
  assert.match(merged, /new stack/, "incoming body kept");
  assert.doesNotMatch(merged, /old stack/, "non-preserved section replaced wholesale");
  assert.match(merged, /## Decisions\n- ship weekly/, "distilled Decisions survive");
  assert.match(merged, /## Standing principles\n- keep it small/, "principles survive");
});

test("mergeContext: incoming version of a preserved section wins over existing", async () => {
  const cs = await import("../src/lib/context-store");
  const merged = cs.mergeContext(
    "# CONTEXT — x\n\n## Decisions\n- old decision",
    "# CONTEXT — x\n\n## Decisions\n- new decision",
  );
  assert.match(merged, /new decision/, "writer explicitly provided the section");
  assert.doesNotMatch(merged, /old decision/, "existing version dropped");
});

test("prependSectionBullets: newest first, cap drops oldest, other sections untouched", async () => {
  const cs = await import("../src/lib/context-store");
  const old = Array.from({ length: 39 }, (_, i) => `- old-${i}`);
  const md = `# CONTEXT — x\n\n## Stack\nsqlite\n\n## Decisions\n${old.join("\n")}\n\n## Open questions\nnone`;
  const out = cs.prependSectionBullets(md, "Decisions", ["- new-a", "- new-b", "- new-c"], 40);
  const bullets = out
    .slice(out.indexOf("## Decisions"))
    .split("\n## ")[0]
    .split("\n")
    .filter((l) => l.startsWith("- "));
  assert.equal(bullets.length, 40, "capped at 40");
  assert.deepEqual(bullets.slice(0, 3), ["- new-a", "- new-b", "- new-c"], "new bullets prepended");
  assert.equal(bullets.at(-1), "- old-36", "oldest two dropped");
  assert.doesNotMatch(out, /- old-38/, "overflow dropped");
  assert.match(out, /## Stack\nsqlite/, "sections before survive");
  assert.match(out, /## Open questions\nnone/, "sections after survive");
});

test("prependSectionBullets: creates the section at the end when absent", async () => {
  const cs = await import("../src/lib/context-store");
  const out = cs.prependSectionBullets("# CONTEXT — x\n\n## Stack\nsqlite", "Decisions", ["- d1"]);
  assert.match(out, /## Stack\nsqlite\n\n## Decisions\n- d1$/, "appended after existing content");
});

test("distillToContext: skips silently when the project has no context", async () => {
  const cs = await import("../src/lib/context-store");
  try {
    assert.equal(cs.distillToContext("never-onboarded", "Decisions", ["- x"]), false);
    assert.equal(cs.readContext("never-onboarded"), "", "no file created from nothing");
    cs.writeContext("dctx", "# CONTEXT — dctx\n\n## Goals\ng");
    assert.equal(cs.distillToContext("dctx", "Decisions", ["- x"]), true);
    assert.match(cs.readContext("dctx"), /## Decisions\n- x/);
  } finally {
    rmSync(CTX, { recursive: true, force: true });
  }
});

test("writeContext merges by default (onboard-style rewrite); replace:true clobbers", async () => {
  const cs = await import("../src/lib/context-store");
  try {
    cs.writeContext("mkey", "# CONTEXT — mkey\n\n## Stack\nv1\n\n## Decisions\n- keep sqlite");
    cs.writeContext("mkey", "# CONTEXT — mkey\n\n## Stack\nv2"); // re-onboard, no Decisions
    const md = cs.readContext("mkey");
    assert.match(md, /## Stack\nv2/, "audit output lands");
    assert.match(md, /## Decisions\n- keep sqlite/, "distilled section survives the rewrite");
    cs.writeContext("mkey", "# CONTEXT — mkey\n\n## Stack\nv3", { replace: true });
    assert.doesNotMatch(cs.readContext("mkey"), /Decisions/, "escape hatch really replaces");
  } finally {
    rmSync(CTX, { recursive: true, force: true });
  }
});

test("prependSectionBullets dedups same-body bullets across dates", async () => {
  const cs = await import("../src/lib/context-store");
  const base = "# CONTEXT — d\n\n## Standing principles\n- [2026-07-08] refined \"add export\": also support json\n- [2026-07-08] refined \"add export\": also support json";
  const md = cs.prependSectionBullets(base, "Standing principles", [
    '- [2026-07-09] refined "add export": also support json',
    '- [2026-07-09] refined "other": new fact',
  ]);
  const hits = md.match(/also support json/g) ?? [];
  assert.equal(hits.length, 1, "one fact, one bullet — newest date wins");
  assert.match(md, /\[2026-07-09\] refined "add export"/, "kept the newest stamp");
  assert.match(md, /new fact/);
});
