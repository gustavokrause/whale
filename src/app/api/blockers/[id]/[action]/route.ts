import { getBlocker, resolveBlocker } from "@/db/queries";
import { startPlanJob } from "@/lib/plan-job";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

// resolve = cleared + resume the paused unit (re-run from its last clean state).
// dismiss = clear without resuming. Today the only resumable trigger is "plan".
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  try {
    const { id, action } = await params;
    const b = getBlocker(id);
    if (!b) return fail("blocker not found", 404);

    if (action === "dismiss") {
      resolveBlocker(id, "dismissed");
      return json({ ok: true, resumed: false });
    }
    if (action === "resolve") {
      resolveBlocker(id, "resolved");
      let resumed = false;
      if (b.trigger_kind === "plan") {
        await startPlanJob(b.trigger_ref);
        resumed = true;
      }
      return json({ ok: true, resumed });
    }
    return fail(`unknown action "${action}"`);
  } catch (e) {
    return fail(e);
  }
}
