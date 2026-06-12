// baleia — config (autonomy dials, runner mode, model tiering)

import path from "node:path";

export const config = {
  // LLM execution: 'stub' (deterministic, no key, default) | 'real' (Anthropic API)
  runner: process.env.BALEIA_RUNNER || "stub",

  // Model tiering per stage (Caio's call). Verify IDs against latest on real use.
  models: {
    distill: process.env.BALEIA_MODEL_DISTILL || "claude-haiku-4-5-20251001",
    plan: process.env.BALEIA_MODEL_PLAN || "claude-sonnet-4-6",
    triage: process.env.BALEIA_MODEL_TRIAGE || "claude-opus-4-8",
    route: process.env.BALEIA_MODEL_ROUTE || "claude-sonnet-4-6",
  },

  // Autonomy dials (start conservative; loosen as override rate drops).
  autonomy: {
    // which risk tiers may bypass human review
    bypass: process.env.BALEIA_BYPASS || "conservative", // conservative | balanced | aggressive
    // push approved tasks to krill automatically vs. leave staged for a manual push
    autoPush: process.env.BALEIA_AUTOPUSH === "1",
    // creating krill projects is ALWAYS gated; this only enables proposing them
    allowNewProjects: process.env.BALEIA_ALLOW_NEW_PROJECTS === "1",
  },

  krill: { baseUrl: process.env.KRILL_URL || "http://localhost:3000" },

  personasDir:
    process.env.PERSONAS_DIR || path.resolve(process.cwd(), "../ai-team"),
};

export const isReal = () => config.runner === "real";
