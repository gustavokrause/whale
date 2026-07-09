import { readUsageRows } from "@/lib/runner";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

// D1 metering readout: the last 200 per-call usage rows (data/usage.jsonl),
// appended by the runner on every `claude --output-format json` run.
export function GET() {
  return json({ rows: readUsageRows(200) });
}
