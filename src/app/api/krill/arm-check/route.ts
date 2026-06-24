import * as krill from "@/lib/krill-client";
import { json } from "@/lib/api";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

// Does the krill project allow auto-finish? Used to warn BEFORE whale pushes
// auto_publish tasks (they'd otherwise stop at deliverable review in krill).
// armed: true | false | null (unknown — unreachable or no project yet).
// protected: this key is a self-edit target (whale/krill) — the modal disables
// the human-gate toggles since the push path forces them off regardless.
export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key") || "";
  const protectedKey = config.autonomy.protected.includes(key.toLowerCase());
  if (!key) return json({ reachable: false, armed: null, protected: false });
  if (!(await krill.ping())) return json({ reachable: false, armed: null, protected: protectedKey });
  const id = await krill.resolveProjectId(key);
  if (!id) return json({ reachable: true, armed: null, missing: true, protected: protectedKey });
  const p = await krill.getProject(id);
  return json({ reachable: true, armed: p?.allow_auto_finish ?? null, protected: protectedKey });
}
