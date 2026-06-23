// whale — the thinking stages. Each has a deterministic stub (runs offline) and a
// real path that uses the persona prompts loaded from ai-team.

import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { isReal, config } from "./config";
import { completeJSON } from "./runner";
import { readContext } from "./context-store";
import * as krill from "./krill-client";
import { pendingRequests, markEntries, addProposed, listProposed, updateProposed, setEntriesPlanError } from "@/db/queries";
import { planConsensus, planSingle, pickRefiner, type ConsensusContext } from "./consensus";
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
  source?: number; // index of the WORK REQUEST this task primarily serves
  label?: string; // short handle (1-3 words) for tracking + dep labels
  acceptance?: string; // concrete definition-of-done for krill's VERIFYING stage
  owner_persona?: string; // consensus: persona that proposed this task
  owner_area?: string; // consensus: that persona's area
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

export async function plan(
  team: Team,
  key: string,
  report?: (text: string) => void,
): Promise<ProposedTask[]> {
  const reqs = pendingRequests(key);
  if (!reqs.length) return [];
  const context = readContext(key); // background reference (may be empty if not onboarded)
  // Standing backlog for this project — so a later plan run (e.g. a follow-up)
  // can depend on existing tasks and not restate them. Each item is tagged with
  // its live state (proposed / in-flight / done) so the planner can DEPEND on
  // in-flight tasks (e.g. a follow-up that extends one) instead of suppressing
  // the overlap as a "duplicate".
  const existing = await existingBacklog(key);
  const { drafts, transcript } = isReal()
    ? await planRealOrConsensus(team, key, context, reqs, existing, report)
    : { drafts: planStub(key, reqs), transcript: [] as unknown[] };
  const consensusLog = transcript.length ? JSON.stringify(transcript) : "[]";
  // Labels are the readable handle used in dep badges — keep them unique within
  // the run so they're unambiguous (second "payment" -> "payment-2").
  const usedLabels = new Map<string, number>();
  for (const t of drafts) {
    const base = (t.label || "").trim().toLowerCase();
    if (!base) continue;
    const seen = usedLabels.get(base);
    usedLabels.set(base, (seen ?? 0) + 1);
    t.label = seen ? `${base}-${seen + 1}` : base;
  }
  // One id per Plan click; each task is attributed to the dump it serves.
  const runId = randomUUID();
  const proposed = drafts.map((t) => triageAndStore(team, key, t, runId, reqs, consensusLog));
  canonicalizeProjectDeps(key);

  // Only mark a dump "planned" if it actually produced a task. A dump the
  // planner emitted nothing for (treated as duplicate / out of scope) stays
  // "raw" so it remains in the pending queue, and gets a visible plan_error
  // explaining why — instead of silently vanishing into a planned-but-empty
  // black hole (the old bug: markEntries ran unconditionally).
  const servedIds = new Set(proposed.map((p) => p.source_entry_id).filter(Boolean));
  const served = reqs.filter((r) => servedIds.has(r.id));
  const unserved = reqs.filter((r) => !servedIds.has(r.id));
  if (served.length) markEntries(served.map((r) => r.id), "planned");
  if (unserved.length) {
    setEntriesPlanError(
      unserved.map((r) => r.id),
      "Planner proposed no task for this request — likely treated as a duplicate of existing work or out of scope. Review it, edit the text, or re-plan. (It stays here until it produces a task.)",
    );
  }
  return proposed;
}

/**
 * Project backlog the planner sees, each tagged with its live state so it can
 * depend on in-flight work rather than re-proposing or suppressing it:
 *   - "proposed"  — in whale, not yet pushed to krill
 *   - "in-flight" — pushed, krill task still active (not DONE/CANCELED)
 *   - "done"      — krill task reached DONE
 * Tolerant: if krill is unreachable, pushed tasks fall back to "in-flight".
 */
async function existingBacklog(
  key: string,
): Promise<{ name: string; label: string | null; state: string }[]> {
  const rows = listProposed().filter(
    (p) => p.project_key === key && p.status !== "rejected",
  );
  const krillIds = rows.map((r) => r.krill_task_id).filter((id): id is string => !!id);
  let statusById = new Map<string, string>();
  if (isReal() && krillIds.length) {
    const tasks = await krill.listTasks();
    statusById = new Map(tasks.map((t) => [t.id, (t.status || "").toUpperCase()]));
  }
  return rows.map((p) => {
    let state = "proposed";
    if (p.krill_task_id) {
      const s = statusById.get(p.krill_task_id);
      state = s === "DONE" ? "done" : s === "CANCELED" ? "done" : "in-flight";
    }
    return { name: p.name, label: p.label, state };
  });
}

/**
 * Deps may come back as a task NAME or its short handle (label). Storage is
 * keyed by name (UI/push resolve by name), so rewrite each dep to the canonical
 * task name across the project, dropping self-refs and unknowns.
 */
export function canonicalizeProjectDeps(projectKey: string): void {
  const all = listProposed().filter((p) => p.project_key === projectKey && p.status !== "rejected");
  const toName = new Map<string, string>();
  for (const t of all) {
    toName.set(t.name, t.name);
    if (t.label) toName.set(t.label, t.name);
  }
  for (const t of all) {
    const deps = JSON.parse(t.deps || "[]") as string[];
    const norm = [...new Set(deps.map((d) => toName.get(d)).filter((n): n is string => !!n && n !== t.name))];
    if (JSON.stringify(norm) !== t.deps) updateProposed(t.id, { deps: JSON.stringify(norm) });
  }
}

function planStub(key: string, reqs: InboxEntry[]): TaskDraft[] {
  return reqs.map((r, i) => {
    const t = r.text.replace(/\n+/g, " ").trim();
    return { name: t.length > 70 ? t.slice(0, 67) + "..." : t, description: `Requested for ${key}.`, source: i };
  });
}

/**
 * Optional read-only repo access for planning. When WHALE_PLAN_FILE_ACCESS is on,
 * scope the planner to the project's folder so file-referencing dumps ground
 * against real files. Shared by the consensus bench and the legacy duo.
 */
async function resolveFileAccess(key: string): Promise<{ cwd?: string; fileNote: string }> {
  if (!config.autonomy.planFileAccess) return { fileNote: "" };
  const meta = await krill.getProjectMeta(key).catch(() => null);
  const folder = meta?.folder_path ? meta.folder_path.replace(/^~(?=$|\/)/, homedir()) : undefined;
  if (!folder) return { fileNote: "" };
  return {
    cwd: folder,
    fileNote:
      `\n\nYou have READ-ONLY access to this project's repo at ${folder} ` +
      `(Read/Grep/Glob). Read any files the requests reference to ground the plan.`,
  };
}

/**
 * The real planner. Default: the dynamic peer-consensus bench (Caio nominates →
 * personas propose+nominate → fixpoint convergence → monotone peer revision).
 * WHALE_CONSENSUS=0 falls back to the legacy Augusto+Maria duo. The consensus
 * path also falls back to the duo if it yields zero tasks, so a dump never
 * silently produces nothing.
 */
async function planRealOrConsensus(
  team: Team,
  key: string,
  context: string,
  reqs: InboxEntry[],
  existing: { name: string; label: string | null; state?: string }[] = [],
  report?: (text: string) => void,
): Promise<{ drafts: TaskDraft[]; transcript: unknown[] }> {
  const { cwd, fileNote } = await resolveFileAccess(key);
  const mode = config.planner; // "consensus" | "single" | "duo"
  const ctx: ConsensusContext = { key, context, reqs, existing, cwd, fileNote };

  if (mode === "single") {
    const res = await planSingle(team, ctx, undefined, report);
    if (res.drafts.length) return { drafts: res.drafts, transcript: res.transcript };
    report?.("Single planner empty — falling back to Augusto + Maria…");
    const drafts = await planRealDuo(team, key, context, reqs, existing, cwd, fileNote);
    return { drafts, transcript: res.transcript };
  }

  if (mode === "consensus") {
    const res = await planConsensus(team, ctx, undefined, report);
    if (res.drafts.length) return { drafts: res.drafts, transcript: res.transcript };
    // Empty consensus (everyone proposed nothing) — don't strand the dump; the
    // duo always produces work. Keep the transcript so the UI shows what happened.
    report?.("Consensus empty — falling back to Augusto + Maria…");
    const drafts = await planRealDuo(team, key, context, reqs, existing, cwd, fileNote);
    return { drafts, transcript: res.transcript };
  }

  report?.("Augusto + Maria planning…");
  const drafts = await planRealDuo(team, key, context, reqs, existing, cwd, fileNote);
  return { drafts, transcript: [] };
}

async function planRealDuo(
  team: Team,
  key: string,
  context: string,
  reqs: InboxEntry[],
  existing: { name: string; label: string | null; state?: string }[] = [],
  cwd?: string,
  fileNote = "",
): Promise<TaskDraft[]> {
  const augusto = persona(team, "Augusto");
  const maria = persona(team, "Maria");
  const system =
    `You are a planning duo.\n\n# Augusto (Strategy)\n${augusto?.systemPrompt || ""}\n\n` +
    `# Maria (Product)\n${maria?.systemPrompt || ""}\n\n` +
    `Augusto challenges scope and protects resources; Maria turns it into the smallest shippable tasks.\n` +
    `Turn the WORK REQUESTS into concrete proposed tasks, grounded in the PROJECT CONTEXT ` +
    `(background reference — use it to scope and clarify; do NOT restate it and do NOT invent work ` +
    `beyond the requests). Augusto kills scope creep. ` +
    `Attribute each task to the WORK REQUEST it primarily serves via "source" (the [n] index). ` +
    `Give each a short "label": a 1-3 word lowercase handle to track it by (e.g. "stripe", "migration", "trial-ui"); deps reference these. ` +
    `Give each an "acceptance": a CONCRETE, checkable definition of done that a verifier can RUN to prove the task works — name the observable end state, not the steps. ` +
    `Prefer a runnable assertion over prose: e.g. "after a test-mode checkout, tenants.plan = the bought tier and period_end is set", "GET /api/x returns 200 with field y", "npm test passes incl. a new test for Z". For non-dev tasks, make it the deliverable's bar (e.g. "doc covers cases A, B, C with examples"). ` +
    `Each task: {name, description, priority(P0..P3), mode(dev|non-dev), depends_on: string[], source: number, label: string, acceptance: string}.\n\n` +
    `## Every request must produce work\n` +
    `Each WORK REQUEST must yield at least one task UNLESS it is already fully covered by an ` +
    `EXISTING task with the SAME scope. "Same scope" means same change to the same target — NOT ` +
    `merely a similar name or the same file. A request tagged source=krill-followup is a gap a ` +
    `running task hit (a build/typecheck break, missed file, out-of-scope leftover): it is by ` +
    `definition NOT yet covered — always propose it, and depend on the task it follows up. ` +
    `If a request truly is a duplicate, still emit the task but set depends_on to the existing ` +
    `task it overlaps so the order holds. When several requests are the same change across ` +
    `different files, you MAY consolidate them into ONE task spanning those files.\n\n` +
    `## Dependency DIRECTION (get this right — wrong direction breaks the build)\n` +
    `depends_on lists the sibling tasks that must finish FIRST ([] if independent). Edges point ` +
    `to what must already exist when the task runs. Decide direction by the task's intent:\n` +
    `- ADD/CREATE a shared thing (util, type, column, API, export, flag): the producer runs ` +
    `FIRST; consumers depend on it.\n` +
    `- REMOVE/DELETE a shared thing (drop an export/symbol/column/endpoint that others use): the ` +
    `removal runs LAST — it depends on EVERY task that stops using that thing. Deleting the ` +
    `definition before its consumers are updated breaks every consumer (e.g. removing an export ` +
    `from features.ts while pages still import it). The teardown task is a SINK, not a root.\n` +
    `- MODIFY a shared contract (rename, signature change): sequence producer→consumers, or change ` +
    `them together if there is no compatibility shim.\n` +
    `Deps MAY cross requests and MAY reference EXISTING tasks (including in-flight ones).`;

  const backlog = existing.length
    ? `\n\nEXISTING TASKS for this project (already in the backlog — don't re-propose the SAME scope; you MAY set depends_on to these EXACT names). Each shows its live state — [in-flight] tasks are still running, so a follow-up that extends one should DEPEND on it, not replace it:\n${existing
        .map((e) => `- ${e.name}${e.label ? ` [${e.label}]` : ""} — ${e.state ?? "proposed"}`)
        .join("\n")}`
    : "";
  const user =
    `PROJECT: ${key}\n\n` +
    `PROJECT CONTEXT (background, reference only):\n${context || "(not onboarded — no background context)"}\n\n` +
    `WORK REQUESTS (source shows where each came from; krill-followup = a gap a running task hit, not yet covered):\n${reqs
      .map((r, i) => `[${i}] (source=${r.source}) ${r.text}`)
      .join("\n")}${backlog}\n\n` +
    `Return a JSON array of proposed tasks (one or more per request as needed). Tag each with "source" = the [n] it serves. depends_on may reference EXISTING task names above OR your new tasks.${fileNote}`;
  const out = await completeJSON<TaskDraft[] | { tasks: TaskDraft[] }>({
    system,
    user,
    model: config.models.plan,
    cwd,
    fileAccess: !!cwd,
  });
  return Array.isArray(out) ? out : out.tasks || [];
}

function triageAndStore(
  team: Team,
  key: string,
  t: TaskDraft,
  runId: string,
  reqs: InboxEntry[],
  consensusLog = "[]",
): ProposedTask {
  const tri = triage(team, { ...t, project_key: key });
  // Map the planner's source index to the dump; fall back to the first dump.
  const srcEntry =
    typeof t.source === "number" && reqs[t.source] ? reqs[t.source] : reqs[0];
  return addProposed({
    project_key: key,
    plan_run_id: runId,
    source_entry_id: srcEntry?.id ?? null,
    label: t.label?.trim() || null,
    name: t.name,
    description: t.description || "",
    priority: t.priority || tri.priority,
    mode: t.mode || tri.mode,
    risk_tier: tri.risk_tier,
    rationale: tri.rationale,
    bypass: tri.bypass,
    auto_publish: tri.auto_publish,
    deps: Array.isArray(t.depends_on) ? t.depends_on : [],
    acceptance: t.acceptance?.trim() || null,
    owner_persona: t.owner_persona?.trim() || null,
    owner_area: t.owner_area?.trim() || null,
    consensus_log: consensusLog,
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
  // Route the refine to the right persona instead of always Maria: prefer the
  // task's owner, let Caio switch if the input shifts domain. Falls back to the
  // legacy duo voice (Maria) when consensus is off.
  const refiner = config.autonomy.consensus
    ? await pickRefiner(team, {
        name: current.name,
        description: current.description,
        owner_persona: current.owner_persona,
        input,
      })
    : persona(team, "Maria");

  // Optional repo file-read access (same gate as Plan) so refine can verify
  // details (a value, a path) instead of guessing.
  let cwd: string | undefined;
  let fileNote = "";
  if (config.autonomy.planFileAccess) {
    const meta = await krill.getProjectMeta(current.project_key).catch(() => null);
    const folder = meta?.folder_path
      ? meta.folder_path.replace(/^~(?=$|\/)/, homedir())
      : undefined;
    if (folder) {
      cwd = folder;
      fileNote = `\n\nYou have READ-ONLY access to this project's repo at ${folder} (Read/Grep/Glob) — read files to verify details rather than guessing.`;
    }
  }

  // The standing backlog so refine can wire depends_on to existing tasks.
  const existing = listProposed()
    .filter((p) => p.project_key === current.project_key && p.id !== current.id && p.status !== "rejected")
    .map((p) => `- ${p.name}${p.label ? ` [${p.label}]` : ""}`);
  const backlog = existing.length
    ? `\n\nOTHER PROPOSED TASKS for this project (you MAY set depends_on to these EXACT names if this task builds on them; do NOT duplicate them):\n${existing.join("\n")}`
    : "";

  const system =
    `${refiner?.systemPrompt || ""}\n\nYou are ${refiner?.name || "the planner"} ` +
    `(${refiner?.area || "Product"}). Refine ONE proposed task per the user's input, ` +
    `applying YOUR discipline's judgment. Keep what's good, apply the change, don't ` +
    `invent extra scope. Return ` +
    `{name, description, priority(P0..P3), mode(dev|non-dev), depends_on:string[]}.`;
  const user =
    `CURRENT TASK:\n${JSON.stringify({ name: current.name, description: current.description, priority: current.priority, mode: current.mode, depends_on: JSON.parse(current.deps || "[]") })}\n\n` +
    `USER INPUT:\n${input}${backlog}\n\nReturn the updated task JSON.${fileNote}`;
  const out = await completeJSON<TaskDraft>({ system, user, model: config.models.plan, cwd, fileAccess: !!cwd });
  // Re-stamp ownership: a refine can move a task to whoever now owns it.
  return { ...out, owner_persona: refiner?.name, owner_area: refiner?.area };
}

/** Human-readable preview of where a task will stop in krill, from its flags. */
export function flowPreview(t: { risk_tier?: string | null; auto_publish?: boolean; bypass?: boolean }): string {
  if (t.risk_tier === "high") return "🔴 full review (plan + deliverable)";
  if (t.auto_publish) return "🟢 auto-finish → DONE (no gate)";
  if (t.bypass) return "🟡 skips plan review → stops at deliverable";
  return "stops at plan review";
}
