import type { NextRequest } from "next/server";
import { listProposed } from "@/db/queries";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") || undefined;
  return json({ proposed: listProposed(status) });
}
