// baleia — the thinking stages. Each has a deterministic stub (runs now, no key)
// and a real path that uses the actual persona prompts loaded from ai-team.

import { isReal, config } from "./config.mjs";
import { complete, completeJSON } from "./runner.mjs";
import { readContext, writeContext } from "./context-store.mjs";
import { rawEntries, markEntries, addProposed } from "./db.mjs";

const persona = (team, name) => team.personas.find((p) => p.name === name);

/* ---------- DISTILLER: raw inbox entries -> living CONTEXT.md per key ---------- */

export async function distill(team, db) {
  const entries = rawEntries(db);
  if (!entries.length) return { distilled: 0, keys: [] };

  const byKey = new Map();
  for (const e of entries) {
    const key = (e.project_hint || "").trim() || "global";
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }

  const touched = [];
  for (const [key, group] of byKey) {
    const prior = readContext(key);
    const md = isReal()
      ? await distillReal(team, key, prior, group)
      : distillStub(key, prior, group);
    writeContext(key, md);
    markEntries(db, group.map((e) => e.id), "distilled");
    touched.push({ key, added: group.length });
  }
  return { distilled: entries.length, keys: touched };
}

function distillStub(key, prior, group) {
  const header = prior.trim()
    ? prior.trimEnd()
    : `# CONTEXT — ${key}\n\n_Living file maintained by baleia._\n\n## Notes`;
  const bullets = group
    .map((e) => `- ${e.text.replace(/\n+/g, " ")}  _(${new Date(e.created_at).toISOString().slice(0, 10)})_`)
    .join("\n");
  return `${header}\n${bullets}\n`;
}

async function distillReal(team, key, prior, group) {
  const caio = persona(team, "Caio");
  const system =
    `${caio?.systemPrompt || ""}\n\nYou maintain a living CONTEXT.md for project "${key}". ` +
    `Merge new notes into a structured doc with sections: Goals, Constraints, Decisions, Open questions. ` +
    `Keep it tight; drop noise; preserve prior decisions.\n\n` +
    `OUTPUT CONTRACT: return ONLY the raw markdown of the file, starting with the line ` +
    `"# CONTEXT — ${key}". No preamble, no summary of what you changed, no code fences, no commentary.`;
  const user =
    `EXISTING CONTEXT.md:\n${prior || "(none yet)"}\n\nNEW NOTES TO MERGE IN:\n` +
    group.map((e) => `- ${e.text}`).join("\n") +
    `\n\nNow output the complete updated CONTEXT.md and nothing else.`;
  return complete({ system, user, model: config.models.distill });
}

/* ---------- PLANNER: CONTEXT -> proposed tasks (Augusto + Maria) ---------- */

export async function plan(team, db, key) {
  const context = readContext(key);
  if (!context.trim()) return [];
  const tasks = isReal() ? await planReal(team, key, context) : planStub(key, context);
  return tasks.map((t) => triageAndStore(team, db, key, t));
}

function planStub(key, context) {
  // turn actionable note lines into at most 3 tasks
  const lines = context
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").replace(/_\(.*?\)_/g, "").trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("_") && l.length > 8);
  return lines.slice(0, 3).map((l) => ({
    name: l.length > 70 ? l.slice(0, 67) + "..." : l,
    description: `From ${key} context: ${l}`,
  }));
}

async function planReal(team, key, context) {
  const augusto = persona(team, "Augusto");
  const maria = persona(team, "Maria");
  const system =
    `You are a planning duo.\n\n# Augusto (Strategy)\n${augusto?.systemPrompt || ""}\n\n` +
    `# Maria (Product)\n${maria?.systemPrompt || ""}\n\n` +
    `Augusto challenges scope and protects resources; Maria turns it into the smallest shippable tasks. ` +
    `Propose only tasks the context justifies. Each: {name, description, priority(P0..P3), mode(dev|non-dev)}.`;
  const user = `PROJECT: ${key}\n\nCONTEXT:\n${context}\n\nReturn a JSON array of proposed tasks (max 6).`;
  const out = await completeJSON({ system, user, model: config.models.plan, maxTokens: 2000 });
  return Array.isArray(out) ? out : out.tasks || [];
}

function triageAndStore(team, db, key, t) {
  const tri = triage(team, { ...t, project_key: key });
  return addProposed(db, {
    project_key: key,
    name: t.name,
    description: t.description || "",
    priority: t.priority || tri.priority,
    mode: t.mode || tri.mode,
    risk_tier: tri.risk_tier,
    rationale: tri.rationale,
    bypass: tri.bypass,
  });
}

/* ---------- TRIAGE: risk rubric -> krill review/bypass decision ---------- */
// Deterministic (Caio: deterministic where possible). Uses ai-team safe-words.

const HIGH_RE = /\b(delete|drop|migration|schema|deploy|prod|production|payment|billing|auth|security|irreversible|refund|charge|gdpr|lgpd|contract)\b/i;
const LOW_RE = /\b(typo|rename|comment|docs?|readme|copy|wording|lint|format|tidy|cleanup)\b/i;
const DEV_RE = /\b(code|repo|refactor|bug|api|endpoint|component|migration|schema|deploy|test|build|function|class)\b/i;

export function triage(team, task) {
  const text = `${task.name} ${task.description || ""}`.toLowerCase();
  const safeWords = team?.risk?.safeWords || [];
  const hitsSafeWord = safeWords.some((w) => text.includes(w.toLowerCase()));

  // self-modification guard: a task aimed at the orchestrator itself (baleia/
  // krill) is always high-risk and never bypasses — a bad self-edit can break
  // the very automation running it.
  const isSelfEdit = config.autonomy.protected.includes((task.project_key || "").toLowerCase());

  let risk_tier = "medium";
  if (isSelfEdit || hitsSafeWord || HIGH_RE.test(text) || task.new_project) risk_tier = "high";
  else if (LOW_RE.test(text)) risk_tier = "low";

  const dial = config.autonomy.bypass;
  let bypass = false;
  if (isSelfEdit) bypass = false;
  else if (risk_tier === "low") bypass = true;
  else if (risk_tier === "medium" && dial === "aggressive") bypass = true;
  // high never bypasses

  const priority = risk_tier === "high" ? "P1" : risk_tier === "low" ? "P3" : "P2";
  const mode = DEV_RE.test(text) ? "dev" : "non-dev";
  const why = isSelfEdit ? "self-edit (orchestrator)" : hitsSafeWord ? "safe-word" : task.new_project ? "new-project" : HIGH_RE.test(text) ? "irreversible-keyword" : LOW_RE.test(text) ? "trivial" : "default";
  return {
    risk_tier,
    bypass,
    priority,
    mode,
    rationale: `${risk_tier} (${why}); dial=${dial} -> ${bypass ? "bypass" : "human review"}`,
  };
}

/* ---------- ROUTER: a raw entry -> destination (Phase 3) ---------- */

export async function route(team, entry, knownKeys = []) {
  return isReal() ? routeReal(team, entry, knownKeys) : routeStub(entry, knownKeys);
}

function routeStub(entry, knownKeys) {
  const t = entry.text.trim();
  const hint = (entry.project_hint || "").trim();
  if (/\b(new project|new idea|idea:|start a|build a|kick off)\b/i.test(t))
    return { dest: "new_project", projectKey: hint || slug(t), reason: "new-project phrasing" };
  if (hint && (knownKeys.includes(hint) || true))
    return { dest: "task", projectKey: hint, reason: "project hint present" };
  if (t.length < 25 || /^(note|remember|fyi)\b/i.test(t))
    return { dest: "context", projectKey: "global", reason: "short / note" };
  if (t.endsWith("?"))
    return { dest: "ask", question: "Which project, and is this a task or just context?", reason: "ambiguous question" };
  return { dest: "task", projectKey: "global", reason: "default to task" };
}

async function routeReal(team, entry, knownKeys = []) {
  const caio = persona(team, "Caio");
  const system =
    `${caio?.systemPrompt || ""}\n\nClassify the input into one destination: ` +
    `"task" (work in an existing project), "new_project" (proposes a new project — gated), ` +
    `"context" (just info), or "ask" (ambiguous). ` +
    `When dest="task", projectKey MUST be one of the KNOWN PROJECTS below (match by topic); ` +
    `if none fit, use "new_project". Return {dest, projectKey?, question?, reason}.`;
  const user =
    `KNOWN PROJECTS: ${knownKeys.length ? knownKeys.join(", ") : "(none yet)"}\n` +
    `INPUT: ${entry.text}\nPROJECT HINT: ${entry.project_hint || "(none)"}`;
  return completeJSON({ system, user, model: config.models.route, maxTokens: 400 });
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "untitled";
