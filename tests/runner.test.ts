// D1 metering — envelope parse + fallback + JSONL readout. Pure functions only;
// never spawns the claude CLI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

import { parseResultEnvelope, readUsageRows } from "../src/lib/runner";

test("parseResultEnvelope: extracts the result text + usage meta from the json envelope", () => {
  const env = JSON.stringify({
    type: "result",
    subtype: "success",
    result: '  {"tasks":[]}  ',
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
    total_cost_usd: 0.0123,
    num_turns: 1,
    duration_ms: 4321,
    session_id: "sess-1",
  });
  const { text, meta } = parseResultEnvelope(env);
  assert.equal(text, '{"tasks":[]}', "callers get the trimmed assistant text, as with --output-format text");
  assert.equal(meta?.usage?.input_tokens, 10);
  assert.equal(meta?.usage?.output_tokens, 5);
  assert.equal(meta?.usage?.cache_creation_input_tokens, 1);
  assert.equal(meta?.usage?.cache_read_input_tokens, 2);
  assert.equal(meta?.total_cost_usd, 0.0123);
  assert.equal(meta?.num_turns, 1);
  assert.equal(meta?.duration_ms, 4321);
  assert.equal(meta?.session_id, "sess-1");
});

test("parseResultEnvelope: non-JSON stdout falls back to raw text, no usage row", () => {
  const raw = "Open this URL in your browser to authorize:\nhttps://x";
  const { text, meta } = parseResultEnvelope(raw);
  assert.equal(text, raw, "raw text passes through untouched (blocker detection still sees it)");
  assert.equal(meta, null);
});

test("parseResultEnvelope: JSON that isn't a result envelope falls back to raw", () => {
  const raw = '{"tasks":[{"name":"x"}]}'; // a bare model reply, not the CLI envelope
  const { text, meta } = parseResultEnvelope(raw);
  assert.equal(text, raw);
  assert.equal(meta, null);
});

test("readUsageRows: returns the last N parsed rows, skipping junk lines", () => {
  const dir = join(tmpdir(), `whale-usage-${randomUUID()}`);
  const file = join(dir, "usage.jsonl");
  const prev = process.env.WHALE_USAGE_FILE;
  process.env.WHALE_USAGE_FILE = file;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ at: 1, purpose: "a" })}\nnot json\n${JSON.stringify({ at: 2, purpose: "b" })}\n${JSON.stringify({ at: 3, purpose: "c" })}\n`,
      "utf8",
    );
    const rows = readUsageRows(2) as { purpose: string }[];
    assert.deepEqual(rows.map((r) => r.purpose), ["b", "c"], "last 2 rows, junk skipped");
    process.env.WHALE_USAGE_FILE = join(dir, "missing.jsonl");
    assert.deepEqual(readUsageRows(), [], "missing file -> empty");
  } finally {
    if (prev === undefined) delete process.env.WHALE_USAGE_FILE;
    else process.env.WHALE_USAGE_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
