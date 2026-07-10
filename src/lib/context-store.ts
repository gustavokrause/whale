// whale — CONTEXT store. whale owns its memory (keyed by project), so user
// project repos stay clean. One living markdown file per project + 'global'.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
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
const metaFileFor = (key: string) => path.join(getDir(), `${keyToSlug(key)}.meta.json`);

// Sidecar metadata (the repo HEAD the context was audited against) so we can tell
// when the cached context has drifted from the live repo. Kept beside the .md;
// listContextKeys ignores it (only .md counts).
export type ContextMeta = { head?: string; at?: number };

export function readContextMeta(key: string): ContextMeta {
  const f = metaFileFor(key);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8")) as ContextMeta;
  } catch {
    return {};
  }
}

export function writeContextMeta(key: string, meta: ContextMeta): void {
  mkdirSync(getDir(), { recursive: true });
  writeFileSync(metaFileFor(key), JSON.stringify(meta), "utf8");
}

const GIT_IO: { encoding: "utf8"; stdio: ["ignore", "pipe", "ignore"] } = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
};

/** Current git HEAD of a repo dir, or "" if not a git repo / git missing. */
export function gitHead(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], GIT_IO).trim();
  } catch {
    return "";
  }
}

/** Commits added to `dir` since `from` (drift since the audit). 0 if same/unknown. */
export function commitsSince(dir: string, from: string): number {
  if (!from) return 0;
  try {
    const out = execFileSync("git", ["-C", dir, "rev-list", "--count", `${from}..HEAD`], GIT_IO).trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

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

// Sections the distiller owns (folded in over time, not re-derivable from the
// repo). A re-onboard or manual save must never clobber them.
export const PRESERVED_SECTIONS = ["Decisions", "Standing principles", "Shipped impact"];

// H2 sections of a context doc: heading title (lowercased) -> full section text
// (heading line + body, up to the next "## ").
function sectionsOf(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const heads = [...md.matchAll(/^## .*$/gm)];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index!;
    const end = i + 1 < heads.length ? heads[i + 1].index! : md.length;
    out.set(heads[i][0].slice(3).trim().toLowerCase(), md.slice(start, end).trimEnd());
  }
  return out;
}

/**
 * Merge-aware rewrite: the result is `incoming`, plus any PRESERVED_SECTIONS
 * present in `existing` but absent from `incoming`, appended at the end. If the
 * incoming doc carries a preserved section itself, the writer explicitly
 * provided it — incoming's version wins. Pure; exported for tests.
 */
export function mergeContext(existing: string, incoming: string): string {
  const have = sectionsOf(incoming);
  const prev = sectionsOf(existing);
  const kept = PRESERVED_SECTIONS
    .map((s) => s.toLowerCase())
    .filter((s) => prev.has(s) && !have.has(s))
    .map((s) => prev.get(s)!);
  if (!kept.length) return incoming;
  return [incoming.trimEnd(), ...kept].join("\n\n");
}

export function writeContext(
  key: string,
  md: string,
  { replace = false }: { replace?: boolean } = {},
): string {
  mkdirSync(getDir(), { recursive: true });
  const incoming = normalizeContext(md);
  const existing = replace ? "" : readContext(key);
  writeFileSync(fileFor(key), existing ? mergeContext(existing, incoming) : incoming, "utf8");
  return fileFor(key);
}

/**
 * Prepend bullets to an H2 section of a context doc (newest first), capped at
 * `cap` bullets (oldest dropped). Creates the section at the end of the doc if
 * absent; every other section is left untouched. Pure; exported for tests.
 */
// Dedup key for a ledger bullet: the body without the leading `- [date] `
// stamp. Re-refining a task with the same words must not burn extra slots of
// the capped section — one fact, one bullet (newest date wins).
const bulletBody = (b: string): string =>
  b.replace(/^- \[\d{4}-\d{2}-\d{2}\]\s*/, "").trim();

export function prependSectionBullets(
  md: string,
  section: string,
  bullets: string[],
  cap = 40,
): string {
  const heading = `## ${section}`;
  const secs = sectionsOf(md);
  const existing = secs.get(section.toLowerCase());
  const oldBullets = existing
    ? existing.split("\n").slice(1).filter((l) => l.startsWith("- "))
    : [];
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const b of [...bullets, ...oldBullets]) {
    const body = bulletBody(b);
    if (seen.has(body)) continue;
    seen.add(body);
    merged.push(b);
    if (merged.length >= cap) break;
  }
  const text = `${heading}\n${merged.join("\n")}`;
  if (!existing) return `${md.trimEnd()}\n\n${text}`;
  const start = md.indexOf(existing);
  return md.slice(0, start) + text + md.slice(start + existing.length);
}

/**
 * Fold distilled bullets into a project's context (the C2/C3 ledger). Skips
 * silently when the project has no CONTEXT.md yet — the distiller must never
 * create a context file from nothing. Returns whether it wrote.
 */
export function distillToContext(
  key: string,
  section: string,
  bullets: string[],
  cap = 40,
): boolean {
  const existing = readContext(key);
  if (!existing || !bullets.length) return false;
  writeContext(key, prependSectionBullets(existing, section, bullets, cap));
  return true;
}

// Forget a project's background context. whale-local only — never touches the
// repo or krill. Returns false if there was nothing stored for the key.
export function deleteContext(key: string): boolean {
  const f = fileFor(key);
  const m = metaFileFor(key);
  const had = existsSync(f);
  if (had) unlinkSync(f);
  if (existsSync(m)) unlinkSync(m); // drop the staleness sidecar too
  return had;
}

export function listContextKeys(): string[] {
  const DIR = getDir();
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}
