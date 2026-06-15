// whale — config (autonomy dials, runner mode, model tiering).
//
// Layered: env defaults  ←  DB overrides (UI-editable subset).
// The `config` object reads LIVE via getters, so a PATCH /api/config takes effect
// without a restart (call setConfigOverrides after writing the DB row).
//
// SAFETY: the self-edit guard (`protected`) and infra wiring (ports, paths, URLs)
// are env-only — never in the DB layer, never UI-editable. The no-auth LAN UI must
// not be able to shrink the guard. See docs/config-ui-overrides.md.

import path from "node:path";

// Bare env defaults (the bootstrap layer + last-resort fallback).
const envDefaults = {
  runner: process.env.WHALE_RUNNER || "stub",
  model_distill: process.env.WHALE_MODEL_DISTILL || "haiku",
  model_plan: process.env.WHALE_MODEL_PLAN || "sonnet",
  model_route: process.env.WHALE_MODEL_ROUTE || "haiku",
  bypass: process.env.WHALE_BYPASS || "conservative",
  auto_push: process.env.WHALE_AUTOPUSH === "1",
  allow_new_projects: process.env.WHALE_ALLOW_NEW_PROJECTS === "1",
};

// DB-sourced overrides (only keys explicitly set; NULL columns are dropped).
let _overrides = {};

/** Load the override layer from a DB config row (NULL fields ignored). */
export function setConfigOverrides(row) {
  _overrides = {};
  if (!row) return;
  for (const k of Object.keys(envDefaults)) {
    if (row[k] !== null && row[k] !== undefined) _overrides[k] = row[k];
  }
}

const ovBool = (v) => v === 1 || v === true || v === "1";
const pick = (k) => (k in _overrides ? _overrides[k] : envDefaults[k]);
const pickBool = (k) => (k in _overrides ? ovBool(_overrides[k]) : envDefaults[k]);

// The self-edit guard is env-only with a hard floor: whale + krill are ALWAYS
// protected even if env omits them. Never sourced from the DB / UI.
const PROTECTED_FLOOR = ["whale", "krill"];
function protectedList() {
  const env = (process.env.WHALE_PROTECTED || "whale,krill")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...PROTECTED_FLOOR, ...env])];
}

export const config = {
  get runner() { return pick("runner"); },
  models: {
    get distill() { return pick("model_distill"); },
    get plan() { return pick("model_plan"); },
    get route() { return pick("model_route"); },
  },
  autonomy: {
    get bypass() { return pick("bypass"); },
    get autoPush() { return pickBool("auto_push"); },
    get allowNewProjects() { return pickBool("allow_new_projects"); },
    get protected() { return protectedList(); }, // env-only, with floor
  },
  // Infra wiring — env-only (changing these is a boot concern).
  krill: { baseUrl: process.env.KRILL_URL || "http://localhost:3000" },
  personasDir:
    process.env.PERSONAS_DIR || path.resolve(process.cwd(), "../ai-team"),
};

export const isReal = () => config.runner === "real";

// Plain merged view for the API (getters resolved) + which knobs are env-locked,
// so the UI can render them read-only.
export function configSnapshot() {
  return {
    runner: config.runner,
    models: { ...config.models }, // resolves getters
    autonomy: {
      bypass: config.autonomy.bypass,
      autoPush: config.autonomy.autoPush,
      allowNewProjects: config.autonomy.allowNewProjects,
    },
    envLocked: {
      protected: config.autonomy.protected, // self-edit guard (read-only)
      krillUrl: config.krill.baseUrl,
      personasDir: config.personasDir,
    },
  };
}
