import { config } from "@/lib/config";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  return json({
    ok: true,
    runner: config.runner,
    autonomy: config.autonomy,
    db: process.env.DB_PATH ?? "data/whale.db",
  });
}
