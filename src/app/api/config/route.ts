import type { NextRequest } from "next/server";
import { config, setConfigOverrides, configSnapshot } from "@/lib/config";
import { readConfig, writeConfig } from "@/db/queries";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

const RUNNERS = ["stub", "real"];
const BYPASS = ["conservative", "balanced", "aggressive", "autonomous", "ludicrous"];
const MODELS = ["haiku", "sonnet", "opus"];

// Only the UI-tunable subset, with allowed values. `protected` (self-edit guard)
// is rejected — it stays env-only by design.
function validateConfigPatch(b: Record<string, unknown>) {
  if ("protected" in b)
    throw new Error("protected is env-only (self-edit guard); not editable here");
  const out: Record<string, unknown> = {};
  if ("runner" in b) {
    if (!RUNNERS.includes(b.runner as string)) throw new Error("runner must be stub|real");
    out.runner = b.runner;
  }
  for (const k of ["model_plan", "model_route"]) {
    if (k in b) {
      if (!MODELS.includes(b[k] as string)) throw new Error(`${k} must be ${MODELS.join("|")}`);
      out[k] = b[k];
    }
  }
  if ("bypass" in b) {
    if (!BYPASS.includes(b.bypass as string)) throw new Error(`bypass must be ${BYPASS.join("|")}`);
    out.bypass = b.bypass;
  }
  if ("auto_push" in b) out.auto_push = !!b.auto_push;
  if ("allow_new_projects" in b) out.allow_new_projects = !!b.allow_new_projects;
  return out;
}

export async function GET() {
  // refresh the override layer (covers first request before instrumentation in dev)
  setConfigOverrides(readConfig());
  void config;
  return json(configSnapshot());
}

export async function PATCH(req: NextRequest) {
  try {
    const fields = validateConfigPatch(await req.json());
    writeConfig(fields);
    setConfigOverrides(readConfig()); // apply live — no restart
    return json(configSnapshot());
  } catch (e) {
    return fail(e);
  }
}
