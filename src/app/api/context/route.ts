import type { NextRequest } from "next/server";
import { readContext, listContextKeys } from "@/lib/context-store";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (key) return json({ key, md: readContext(key) });
  return json({ keys: listContextKeys() });
}
