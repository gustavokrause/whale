// baleia — config (autonomy dials, runner mode, model tiering)

import path from "node:path";

export const config = {
  // LLM execution: 'stub' (deterministic, default) | 'real' (spawns the
  // Claude Code CLI — krill's model — using your Claude Code auth, no API key).
  runner: process.env.BALEIA_RUNNER || "stub",

  // Model tiering per stage (CLI aliases). Triage is deterministic (no model).
  models: {
    distill: process.env.BALEIA_MODEL_DISTILL || "haiku",
    plan: process.env.BALEIA_MODEL_PLAN || "sonnet",
    route: process.env.BALEIA_MODEL_ROUTE || "haiku",
  },

  // Autonomy dials (start conservative; loosen as override rate drops).
  autonomy: {
    // which risk tiers may bypass human review
    bypass: process.env.BALEIA_BYPASS || "conservative", // conservative | balanced | aggressive
    // push approved tasks to krill automatically vs. leave staged for a manual push
    autoPush: process.env.BALEIA_AUTOPUSH === "1",
    // creating krill projects is ALWAYS gated; this only enables proposing them
    allowNewProjects: process.env.BALEIA_ALLOW_NEW_PROJECTS === "1",
    // self-modification guard: tasks targeting the orchestrator itself always
    // get 🔴 human review, never bypass (a bad self-edit can break automation).
    protected: (process.env.BALEIA_PROTECTED || "baleia,krill")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  },

  krill: { baseUrl: process.env.KRILL_URL || "http://localhost:3000" },

  personasDir:
    process.env.PERSONAS_DIR || path.resolve(process.cwd(), "../ai-team"),
};

export const isReal = () => config.runner === "real";
