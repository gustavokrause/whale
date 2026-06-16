// whale — the thinking stages. Each has a deterministic stub (runs offline) and a
// real path that uses the persona prompts loaded from ai-team.

import { isReal, config } from "./config";
import { completeJSON } from "./runner";
import { readContext } from "./context-store";
import { pendingRequests, markEntries, addProposed } from "@/db/queries";
import type { Team, Persona } from "./persona-loader";
import type { InboxEntry, ProposedTask } from "@/db/schema";

const persona = (team: Team, name: string): Persona | undefined =>
  team.personas.find((p) => p.name === name);

export type TaskDraft = {
  name: string;
  description?: string;
  project_key?: string;
  new_project?: boolean;
  priority?: string;
  mode?: string;
  depends_on?: string[];
};

export type TriageResult = {
  risk_tier: string;
  bypass: boolean;
  auto_publish: boolean;
  priority: string;
  mode: string;
  rationale: string;
};

export type RouteEntry = { text: string; project_hint?: string | null };

export type RouteResult = {
  dest: string;
  projectKey?: string;
  question?: string;
  reason: string;
};

/* ---------- PLANNER: pending requests (grounded by audit context) -> proposed ---------- */
// A dump tagged to a project IS a work request (an inbox_entries row). Plan reads
// the project's pending requests + the audit CONTEXT (background reference, never
// rewritten) → proposed tasks, then marks those requests planned.

export async function plan(team: Team, key: string): Promise<ProposedTask[]> {
  const reqs = pendingRequests(key);
  if (!reqs.length) return [];
  const context = readContext(key); // background reference (may be empty if not onboarded)
  const drafts = isReal() ? await planReal(team, key, context, reqs) : planStub(key, reqs);
  const proposed = drafts.map((t) => triageAndStore(team, key, t));
  markEntries(reqs.map((r) => r.id), "planned");
  return proposed;
}

function planStub(key: string, reqs: InboxEntry[]): TaskDraft[] {
  return reqs.map((r) => {
    const t = r.text.replace(/\n+/g, " ").trim();
    return { name: t.length > 70 ? t.slice(0, 67) + "..." : t, description: `Requested for ${key}.` };
  });
}

async function planReal(team: Team, key: string, context: string, reqs: InboxEntry[]): Promise<TaskDraft[]> {
  const augusto = persona(team, "Augusto");
  const maria = persona(team, "Maria");
  const system =
    `You are a planning duo.\n\n# Augusto (Strategy)\n${augusto?.systemPrompt || ""}\n\n` +
    `# Maria (Product)\n${maria?.systemPrompt || ""}\n\n` +
    `Augusto challenges scope and protects resources; Maria turns it into the smallest shippable tasks.\n` +
    `Turn the WORK REQUESTS into concrete proposed tasks, grounded in the PROJECT CONTEXT ` +
    `(background reference — use it to scope and clarify; do NOT restate it and do NOT invent work ` +
    `beyond the requests). Augusto kills scope creep. ` +
    `Sequence work that builds on other tasks: set depends_on to the exact names of ` +
    `the sibling tasks that must finish first ([] if independent). ` +
    `Each task: {name, description, priority(P0..P3), mode(dev|non-dev), depends_on: string[]}.`;
  const user =
    `PROJECT: ${key}\n\n` +
    `PROJECT CONTEXT (background, reference only):\n${context || "(not onboarded — no background context)"}\n\n` +
    `WORK REQUESTS:\n${reqs.map((r) => `- ${r.text}`).join("\n")}\n\n` +
    `Return a JSON array of proposed tasks (one or more per request as needed).`;
  const out = await completeJSON<TaskDraft[] | { tasks: TaskDraft[] }>({ system, user, model: config.models.plan });
  return Array.isArray(out) ? out : out.tasks || [];
}

function triageAndStore(team: Team, key: string, t: TaskDraft): ProposedTask {
  const tri = triage(team, { ...t, project_key: key });
  return addProposed({
    project_key: key,
    name: t.name,
    description: t.description || "",
    priority: t.priority || tri.priority,
    mode: t.mode || tri.mode,
    risk_tier: tri.risk_tier,
    rationale: tri.rationale,
    bypass: tri.bypass,
    auto_publish: tri.auto_publish,
    deps: Array.isArray(t.depends_on) ? t.depends_on : [],
  });
}

/* ---------- TRIAGE: risk rubric -> krill review/bypass decision ---------- */

const HIGH_RE = /\b(delete|drop|migration|schema|deploy|prod|production|payment|billing|auth|security|irreversible|refund|charge|gdpr|lgpd|contract)\b/i;
const LOW_RE = /\b(typo|rename|comment|docs?|readme|copy|wording|lint|format|tidy|cleanup)\b/i;
const DEV_RE = /\b(code|repo|refactor|bug|api|endpoint|component|migration|schema|deploy|test|build|function|class)\b/i;

export function triage(
  team: Team | { risk?: { safeWords?: string[] } },
  task: { name: string; description?: string; project_key?: string; new_project?: boolean },
  dial: string = config.autonomy.bypass,
): TriageResult {
  const text = `${task.name} ${task.description || ""}`.toLowerCase();
  const safeWords = team?.risk?.safeWords || [];
  const hitsSafeWord = safeWords.some((w) => text.includes(w.toLowerCase()));

  const isSelfEdit = config.autonomy.protected.includes((task.project_key || "").toLowerCase());

  let risk_tier = "medium";
  if (isSelfEdit || hitsSafeWord || HIGH_RE.test(text) || task.new_project) risk_tier = "high";
  else if (LOW_RE.test(text)) risk_tier = "low";

  const isLudicrous = dial === "ludicrous";
  // Autonomous: auto-finish low + medium, but high still gets full plan review.
  // Ludicrous: auto-finish EVERY tier. Both keep the self-edit floor (whale/krill
  // protected tasks never auto/bypass — the runaway-loop guard).
  const isAutonomous = dial === "autonomous";

  let bypass = false;
  if (!isSelfEdit) {
    if (isLudicrous) bypass = true; // skip plan review at every tier (auto anyway)
    else if (risk_tier === "low") bypass = dial === "balanced" || dial === "aggressive" || isAutonomous;
    else if (risk_tier === "medium") bypass = dial === "aggressive" || isAutonomous;
    // high: only Ludicrous skips review; Autonomous keeps high fully gated.
  }

  const auto_publish =
    !isSelfEdit &&
    (isLudicrous ||
      (isAutonomous && risk_tier !== "high") ||
      (risk_tier === "low" && dial === "aggressive"));

  const priority = risk_tier === "high" ? "P1" : risk_tier === "low" ? "P3" : "P2";
  const mode = DEV_RE.test(text) ? "dev" : "non-dev";
  const why = isSelfEdit
    ? "self-edit (orchestrator)"
    : hitsSafeWord ? "safe-word"
    : task.new_project ? "new-project"
    : HIGH_RE.test(text) ? "irreversible-keyword"
    : LOW_RE.test(text) ? "trivial"
    : "default";
  return {
    risk_tier,
    bypass,
    auto_publish,
    priority,
    mode,
    rationale: `${risk_tier} (${why}); dial=${dial} -> ${auto_publish ? "auto-finish" : bypass ? "bypass plan review" : "human review"}`,
  };
}

/* ---------- ROUTER: a raw entry -> destination (Phase 3) ---------- */

export async function route(team: Team, entry: RouteEntry, knownKeys: string[] = []): Promise<RouteResult> {
  return isReal() ? routeReal(team, entry, knownKeys) : routeStub(entry, knownKeys);
}

function routeStub(entry: RouteEntry, knownKeys: string[]): RouteResult {
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

async function routeReal(team: Team, entry: RouteEntry, knownKeys: string[] = []): Promise<RouteResult> {
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
  return completeJSON<RouteResult>({ system, user, model: config.models.route });
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "untitled";

/* ---------- REFINE: Input is a turn — re-evaluate a task per user input (B3) ---------- */

export async function refineProposal(team: Team, current: ProposedTask, input: string): Promise<TaskDraft> {
  if (!isReal()) {
    return {
      name: current.name,
      description: `${current.description || ""} | refine: ${input}`.trim(),
      priority: current.priority,
      mode: current.mode,
      depends_on: JSON.parse(current.deps || "[]"),
    };
  }
  const maria = persona(team, "Maria");
  const system =
    `${maria?.systemPrompt || ""}\n\nRefine ONE proposed task per the user's input. Keep what's ` +
    `good, apply the change, don't invent extra scope. Return ` +
    `{name, description, priority(P0..P3), mode(dev|non-dev), depends_on:string[]}.`;
  const user =
    `CURRENT TASK:\n${JSON.stringify({ name: current.name, description: current.description, priority: current.priority, mode: current.mode })}\n\n` +
    `USER INPUT:\n${input}\n\nReturn the updated task JSON.`;
  return completeJSON<TaskDraft>({ system, user, model: config.models.plan });
}

/** Human-readable preview of where a task will stop in krill, from its flags. */
export function flowPreview(t: { risk_tier?: string | null; auto_publish?: boolean; bypass?: boolean }): string {
  if (t.risk_tier === "high") return "🔴 full review (plan + deliverable)";
  if (t.auto_publish) return "🟢 auto-finish → DONE (no gate)";
  if (t.bypass) return "🟡 skips plan review → stops at deliverable";
  return "stops at plan review";
}
