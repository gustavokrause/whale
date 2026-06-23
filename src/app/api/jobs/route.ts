import { runningJobs, recentJobs } from "@/lib/jobs";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

// What's running now (onboard audits, plans) + recently finished — for the UI to
// show in-progress state across reloads and toast completions.
export async function GET() {
  return json({ running: runningJobs(), recent: recentJobs() });
}
