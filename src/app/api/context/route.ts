import type { NextRequest } from "next/server";
import { readContext, listContextKeys, writeContext, deleteContext } from "@/lib/context-store";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (key) return json({ key, md: readContext(key) });
  return json({ keys: listContextKeys() });
}

// Seed/replace a project's background context by hand (for repo-less idea projects,
// or to correct an audit). Onboard's textarea hits this; no LLM, no krill needed.
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
