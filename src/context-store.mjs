// baleia — CONTEXT store. baleia owns its memory (keyed by project), so user
// project repos stay clean. One living markdown file per project + 'global'.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const DIR = process.env.BALEIA_CONTEXT_DIR || path.resolve(process.cwd(), "data/context");

export const keyToSlug = (key) =>
  (key || "global").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "global";

const fileFor = (key) => path.join(DIR, `${keyToSlug(key)}.md`);

export function readContext(key) {
  const f = fileFor(key);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

export function writeContext(key, md) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(fileFor(key), md, "utf8");
  return fileFor(key);
}

export function listContextKeys() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
}
