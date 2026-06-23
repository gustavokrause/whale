import * as krill from "@/lib/krill-client";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

// Does the krill project allow auto-finish? Used to warn BEFORE whale pushes
// auto_publish tasks (they'd otherwise stop at deliverable review in krill).
// armed: true | false | null (unknown — unreachable or no project yet).
export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!key) return json({ reachable: false, armed: null });
  if (!(await krill.ping())) return json({ reachable: false, armed: null });
  const id = await krill.resolveProjectId(key);
  if (!id) return json({ reachable: true, armed: null, missing: true });
  const p = await krill.getProject(id);
  return json({ reachable: true, armed: p?.allow_auto_finish ?? null });
}
