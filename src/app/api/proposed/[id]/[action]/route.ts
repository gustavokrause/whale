import type { NextRequest } from "next/server";
import { getTeam } from "@/lib/team";
import { approve, reject, push, reassign, refine } from "@/lib/pipeline";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

const body = async (req: NextRequest): Promise<Record<string, unknown>> => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await params;
  try {
    const team = await getTeam();
    if (action === "approve") return json(await approve(team, id));
    if (action === "reject") return json({ task: reject(id) });
    if (action === "push") {
      const b = await body(req);
      return json(await push(id, { confirm: !!b.confirm }));
    }
    if (action === "reassign") {
      const b = await body(req);
      if (!b.project_key) return fail("project_key required");
      return json({ task: reassign(team, id, String(b.project_key)) });
    }
    if (action === "refine") {
      const b = await body(req);
      if (!b.input) return fail("input required");
      return json(await refine(team, id, String(b.input)));
    }
    return fail(`unknown action: ${action}`, 404);
  } catch (e) {
    return fail(e);
  }
}
