// Start a plan as a tracked job, capturing any interactive block (MCP auth, CLI
// login) as a blocker instead of a cryptic failure. Shared by POST /api/plan and
// blocker resume so the pause/resume behaviour is identical on both paths.

import { getTeam } from "./team";
import { planProject } from "./pipeline";
import { startJob, isRunning } from "./jobs";
import { BlockedError } from "./runner";
import { addBlocker } from "@/db/queries";

export async function startPlanJob(key: string): Promise<{ running: boolean }> {
  if (isRunning("plan", key)) return { running: true };
  const team = await getTeam();
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
      throw e;
    }
  });
  return { running: true };
}
