import { ingestFollowups } from "@/lib/followup-ingest";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

// Manual / cron trigger to pull krill's open follow-ups into the inbox.
export async function POST() {
  try {
    return json({ ok: true, ingested: await ingestFollowups() });
  } catch (e) {
    return fail(e);
  }
}
