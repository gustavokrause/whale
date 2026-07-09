import type { NextRequest } from "next/server";
import { readContext, listContextKeys, writeContext, deleteContext } from "@/lib/context-store";
import { contextStatus } from "@/lib/pipeline";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (key) return json({ key, md: readContext(key) });
  const keys = listContextKeys();
  // ?stale=1 adds per-key repo drift (extra krill + git work); opt-in so the
  // plain key list stays cheap for other callers.
  if (req.nextUrl.searchParams.get("stale")) return json({ keys, stale: await contextStatus() });
  return json({ keys });
}

// Seed/update a project's background context by hand (for repo-less idea projects,
// or to correct an audit). Onboard's textarea hits this; no LLM, no krill needed.
// Merge-aware: distilled sections (Decisions, Standing principles) survive a save
// that omits them — see writeContext/mergeContext.
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.key) return fail("key required");
    if (typeof b.md !== "string" || !b.md.trim()) return fail("md (context text) required");
    writeContext(b.key, b.md);
    return json({ ok: true, key: b.key, chars: b.md.length });
  } catch (e) {
    return fail(e);
  }
}

// Forget a project's background context. whale-local — does not touch krill or
// the repo. Idempotent: reports whether a file was actually removed.
export function DELETE(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!key) return fail("key required");
  return json({ ok: true, key, deleted: deleteContext(key) });
}
