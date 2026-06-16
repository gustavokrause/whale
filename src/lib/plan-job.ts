// Start a plan as a tracked job, capturing any interactive block (MCP auth, CLI
// login) as a blocker instead of a cryptic failure. Shared by POST /api/plan and
// blocker resume so the pause/resume behaviour is identical on both paths.

import { getTeam } from "./team";
import { planProject } from "./pipeline";
import { startJob, isRunning } from "./jobs";
import { BlockedError } from "./runner";
import { addBlocker, setPlanError } from "@/db/queries";

export async function startPlanJob(key: string): Promise<{ running: boolean }> {
  if (isRunning("plan", key)) return { running: true };
  const team = await getTeam();
  setPlanError(key, null); // fresh attempt — clear any prior failure
  startJob("plan", key, async () => {
    try {
      const proposed = await planProject(team, key);
      return { ok: true, note: `${proposed.length} proposed task(s)` };
    } catch (e) {
      if (e instanceof BlockedError) {
        addBlocker({
          kind: e.kind,
          trigger_kind: "plan",
          trigger_ref: key,
          summary: `${e.message} (planning ${key})`,
          detail: e.detail,
          action_url: e.actionUrl ?? null,
        });
        return { ok: false, note: `blocked: ${e.message}` };
      }
      // Persist the failure on the pending dumps so the inbox shows WHY.
      const msg = e instanceof Error ? e.message : String(e);
      setPlanError(key, msg.slice(0, 400));
      return { ok: false, note: `plan failed: ${msg.slice(0, 120)}` };
    }
  });
  return { running: true };
}
