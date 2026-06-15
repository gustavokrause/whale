// whale — CONTEXT store. whale owns its memory (keyed by project), so user
// project repos stay clean. One living markdown file per project + 'global'.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

// Resolved lazily: calling process.cwd() at module top-level makes Next's file
// tracer treat the whole project root as a dependency (NFT warnings).
const getDir = () =>
  process.env.WHALE_CONTEXT_DIR ||
  path.resolve(/* turbopackIgnore: true */ process.cwd(), "data/context");

export const keyToSlug = (key: string | null | undefined): string =>
  (key || "global")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "global";

const fileFor = (key: string) => path.join(getDir(), `${keyToSlug(key)}.md`);

// The audit (onboard) runs via `claude --print` and sometimes emits a
// thinking preamble before the contracted "# CONTEXT —" header. Strip anything
// before the first CONTEXT heading so stored memory matches the contract.
function normalizeContext(md: string): string {
  const heading = (md || "").match(/^# CONTEXT\b.*$/m);
  if (!heading) return (md || "").trim();
  return md.slice(md.indexOf(heading[0])).trim();
}

export function readContext(key: string): string {
  const f = fileFor(key);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

export function writeContext(key: string, md: string): string {
  mkdirSync(getDir(), { recursive: true });
  writeFileSync(fileFor(key), normalizeContext(md), "utf8");
  return fileFor(key);
}

export function listContextKeys(): string[] {
  const DIR = getDir();
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}
