// whale — config (autonomy dials, runner mode, model tiering).
//
// Layered: env defaults ← DB overrides (UI-editable subset). The `config` object
// reads LIVE via getters, so a PATCH /api/config takes effect without a restart
// (call setConfigOverrides after writing the DB row).
//
// SAFETY: the self-edit guard (`protected`) and infra wiring are env-only — never
// in the DB layer, never UI-editable. See docs/config-ui-overrides.md.

import path from "node:path";
import type { ConfigRow } from "@/db/schema";

const envDefaults = {
  runner: process.env.WHALE_RUNNER || "stub",
  model_plan: process.env.WHALE_MODEL_PLAN || "sonnet",
  model_route: process.env.WHALE_MODEL_ROUTE || "haiku",
  bypass: process.env.WHALE_BYPASS || "conservative",
  auto_push: process.env.WHALE_AUTOPUSH === "1",
  allow_new_projects: process.env.WHALE_ALLOW_NEW_PROJECTS === "1",
  plan_file_access: process.env.WHALE_PLAN_FILE_ACCESS === "1",
};

type OverrideKey = keyof typeof envDefaults;

let _overrides: Partial<Record<OverrideKey, unknown>> = {};

/** Load the override layer from a DB config row (NULL fields ignored). */
export function setConfigOverrides(row?: ConfigRow | null) {
  _overrides = {};
  if (!row) return;
  const r = row as Record<string, unknown>;
  for (const k of Object.keys(envDefaults) as OverrideKey[]) {
    if (r[k] !== null && r[k] !== undefined) _overrides[k] = r[k];
  }
}

const ovBool = (v: unknown) => v === 1 || v === true || v === "1";
const pick = (k: OverrideKey) => (k in _overrides ? _overrides[k] : envDefaults[k]);
const pickBool = (k: OverrideKey) =>
  k in _overrides ? ovBool(_overrides[k]) : (envDefaults[k] as boolean);

// Self-edit guard: env-only with a hard floor (whale + krill always protected).
const PROTECTED_FLOOR = ["whale", "krill"];
function protectedList(): string[] {
  const env = (process.env.WHALE_PROTECTED || "whale,krill")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...PROTECTED_FLOOR, ...env])];
}

export const config = {
  get runner() {
    return pick("runner") as string;
  },
  models: {
    get plan() {
      return pick("model_plan") as string;
    },
    get route() {
      return pick("model_route") as string;
    },
  },
  autonomy: {
    get bypass() {
      return pick("bypass") as string;
    },
    get autoPush() {
      return pickBool("auto_push");
    },
    get allowNewProjects() {
      return pickBool("allow_new_projects");
    },
    get planFileAccess() {
      return pickBool("plan_file_access");
    },
    get protected() {
      return protectedList();
    },
  },
  krill: { baseUrl: process.env.KRILL_URL || "http://localhost:3000" },
  personasDir: process.env.PERSONAS_DIR || path.resolve(process.cwd(), "../ai-team"),
};

export const isReal = () => config.runner === "real";

export function configSnapshot() {
  return {
    runner: config.runner,
    models: {
      plan: config.models.plan,
      route: config.models.route,
    },
    autonomy: {
      bypass: config.autonomy.bypass,
      autoPush: config.autonomy.autoPush,
      allowNewProjects: config.autonomy.allowNewProjects,
      planFileAccess: config.autonomy.planFileAccess,
    },
    envLocked: {
      protected: config.autonomy.protected,
      krillUrl: config.krill.baseUrl,
      personasDir: config.personasDir,
    },
  };
}
