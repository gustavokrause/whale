// whale — CONTEXT store. whale owns its memory (keyed by project), so user
// project repos stay clean. One living markdown file per project + 'global'.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const DIR = process.env.WHALE_CONTEXT_DIR || path.resolve(process.cwd(), "data/context");

export const keyToSlug = (key) =>
  (key || "global").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "global";

const fileFor = (key) => path.join(DIR, `${keyToSlug(key)}.md`);

// Real LLM stages (distill, audit) run via `claude --print` and sometimes emit a
// thinking preamble ("Now I have enough...", "Enough. Writing CONTEXT.md.") before
// the contracted "# CONTEXT —" header — the text format isn't structured, so the
// output contract can't be enforced at the model. Strip anything before the first
// CONTEXT heading so stored memory always starts at the contract. No-op when the
// header is already first (stub output, manual writes).
function normalizeContext(md) {
  const heading = (md || "").match(/^# CONTEXT\b.*$/m);
  if (!heading) return (md || "").trim();
  return md.slice(md.indexOf(heading[0])).trim();
}

export function readContext(key) {
  const f = fileFor(key);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

export function writeContext(key, md) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(fileFor(key), normalizeContext(md), "utf8");
  return fileFor(key);
}

export function listContextKeys() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
}
