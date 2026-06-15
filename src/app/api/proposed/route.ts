import type { NextRequest } from "next/server";
import { listProposed } from "@/db/queries";
import { enrichPushed } from "@/lib/pipeline";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") || undefined;
  const items = listProposed(status);
  // ?sync=1 reads back live krill status for pushed tasks (Gap A)
  if (req.nextUrl.searchParams.get("sync") === "1")
    return json({ proposed: await enrichPushed(items) });
  return json({ proposed: items });
}
