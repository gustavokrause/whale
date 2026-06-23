import { listBlockers } from "@/db/queries";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

// Open blockers — the unblock queue the UI surfaces. ?all=1 for the full history.
export async function GET(req: Request) {
  const all = new URL(req.url).searchParams.get("all") === "1";
  return json({ blockers: listBlockers(all ? undefined : "open") });
}
