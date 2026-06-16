import { config } from "@/lib/config";
import { listEntries, rawEntries, listProposed } from "@/db/queries";
import { ping } from "@/lib/krill-client";
import { ingestFollowups } from "@/lib/followup-ingest";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  // Opportunistic krill→whale pull on the regular status poll (single-flight,
  // tolerant). A cron / the manual /api/followups/ingest endpoint also drive it.
  void ingestFollowups();
  const proposed = listProposed();
  const byStatus: Record<string, number> = {};
  for (const p of proposed) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  return json({
    runner: config.runner,
    autonomy: { bypass: config.autonomy.bypass, autoPush: config.autonomy.autoPush },
    inbox: { total: listEntries(1000).length, raw: rawEntries().length },
    proposed: { total: proposed.length, byStatus },
    krill: { up: await ping(), url: config.krill.baseUrl },
  });
}
