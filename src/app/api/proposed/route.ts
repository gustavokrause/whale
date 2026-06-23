import type { NextRequest } from "next/server";
import { listProposed, listEntries } from "@/db/queries";
import { enrichPushed } from "@/lib/pipeline";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

// Attach the source dump's text so the UI can group proposals by their dump.
function withDumpText<T extends { source_entry_id?: string | null }>(items: T[]) {
  const byId = new Map(listEntries(500).map((e) => [e.id, e.text]));
  return items.map((t) => ({
    ...t,
    source_entry_text: t.source_entry_id ? byId.get(t.source_entry_id) ?? null : null,
  }));
}

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") || undefined;
  const items = listProposed(status);
  // ?sync=1 reads back live krill status for pushed tasks (Gap A)
  if (req.nextUrl.searchParams.get("sync") === "1")
    return json({ proposed: withDumpText(await enrichPushed(items)) });
  return json({ proposed: withDumpText(items) });
}
