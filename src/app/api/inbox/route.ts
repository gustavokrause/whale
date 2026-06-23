import type { NextRequest } from "next/server";
import { addEntry, listEntries } from "@/db/queries";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  return json({ entries: listEntries(50) });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const entry = addEntry({ text: b.text, projectHint: b.project_hint || null, source: b.source || "manual" });
    return json({ entry }, 201);
  } catch (e) {
    return fail(e);
  }
}
