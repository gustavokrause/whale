// context-store test — isolated file so we can point WHALE_CONTEXT_DIR at a
// temp dir before the module reads it. (node --test runs each file in its own
// process, so this env override can't leak into the other tests.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

const CTX = join(tmpdir(), `whale-ctx-${randomUUID()}`);
process.env.WHALE_CONTEXT_DIR = CTX;

test("context-store writes and reads living context", async () => {
  const cs = await import("../src/context-store.mjs");
  try {
    cs.writeContext("krill", "# CONTEXT — krill\n\nhi");
    assert.match(cs.readContext("krill"), /CONTEXT — krill/);
    assert.ok(cs.listContextKeys().includes("krill"));
    assert.equal(cs.readContext("does-not-exist"), "", "missing key returns empty");
  } finally {
    rmSync(CTX, { recursive: true, force: true });
  }
});
