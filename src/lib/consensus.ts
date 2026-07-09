// whale — dynamic peer-consensus planner. Replaces the hardcoded Augusto+Maria
// duo (legacy path in stages.ts) with the whole bench, used WISELY:
//
//   1. NOMINATE   Caio (orchestration) reads the dumps and names the MINIMUM
//                 relevant personas — usually one. (cheap model: route)
//   2. PROPOSE    each nominee proposes tasks ONLY in its specialty, tagged with
//                 its name/area, and MAY nominate others on a genuine dependency.
//   3. CONVERGE   newly-nominated personas run in further rounds until a round
//                 names nobody new (fixpoint; each persona speaks once — bounded
//                 by the roster, no arbitrary cap). A completeness SWEEP then pulls
//                 any discipline that owns part of the work but was never named
//                 (cross-domain plans only).
//   4. SYNTHESIZE one Caio merge pass folds same-deliverable proposals into a
//                 single owned task and passes distinct slices through untouched.
//                 Replaces the old per-persona REVISE step, which collapsed:
//                 symmetric personas all deferred and withdrew everything. The
//                 merge is a librarian, not a judge — it never drops a slice.
//
// HARD CONSTRAINT: whale runs each persona as a separate sandboxed `claude` CLI
// call with the Task tool BLOCKED (runner.ts SANDBOX_DISALLOWED) — personas
// cannot spawn each other. So every nomination is JSON returned to THIS loop,
// and whale does the dispatching. There is no in-Claude agent recursion.

import { config } from "./config";
import { completeJSON } from "./runner";
import type { Team, Persona } from "./persona-loader";
import type { InboxEntry } from "@/db/schema";
import type { TaskDraft } from "./stages";

// The LLM call, injectable so the orchestration (convergence, synthesis merge,
// transcript) is testable offline without spawning the `claude` CLI.
export type Completer = typeof completeJSON;

// Resolve a nominee reference to a persona. Models sometimes return the AREA
// ("Product") instead of the NAME ("Maria") in the name field, so fall back to
// matching on area.
const persona = (team: Team, ref: string): Persona | undefined => {
  const r = (ref || "").toLowerCase().trim();
  if (!r) return undefined;
  return (
    team.personas.find((p) => p.name.toLowerCase() === r) ||
    team.personas.find((p) => p.area.toLowerCase() === r) ||
    team.personas.find((p) => p.area.toLowerCase().includes(r) || r.includes(p.area.toLowerCase()))
  );
};

export type Nomination = { name: string; area: string; why: string };

// One line of the audit trail stored per plan run (consensus_log column).
export type ConsensusEvent =
  | { kind: "nominate"; by: string; nominees: Nomination[]; at: number }
  | { kind: "propose"; by: string; area: string; tasks: string[]; at: number }
  | { kind: "merge"; by: string; before: number; after: number; at: number };

export type ConsensusResult = { drafts: TaskDraft[]; transcript: ConsensusEvent[] };

export type ConsensusContext = {
  key: string;
  context: string;
  reqs: InboxEntry[];
  existing: { name: string; label: string | null; state?: string }[];
  cwd?: string;
  fileNote: string;
  // Owner/persona outcomes of this project's recent plan runs (tracker C7):
  // fed to the nominate step so routing compounds instead of cold-starting.
  priorRouting?: string;
};

// Routing doctrine — the AGENTS.md "routing economy", balanced. The point is to
// bring the RIGHT people, not the fewest and not everyone. Earlier this was tuned
// too tight ("usually ONE") and collapsed every plan onto a single persona; the
// fix is to pull a discipline whenever it genuinely OWNS part of the work, while
// still refusing personas who'd only echo.
const ECONOMY =
  `ROUTING DOCTRINE — bring the RIGHT people, sized to the work.\n` +
  `- A narrow, single-discipline ask → one persona.\n` +
  `- Work that genuinely spans disciplines → pull EACH discipline that OWNS part of it. ` +
  `Consider the WHOLE roster, not a favorite few — match the dump to whoever owns a piece:\n` +
  `    Strategy (positioning, scope) · Finance (unit economics, pricing) · Product (packaging, ` +
  `roadmap) · Sales (deal shapes, B2B motion) · Marketing (funnel, GTM, SEO) · Metrics ` +
  `(measurement, experiments) · UX (flows, friction) · UI (visual, layout) · Copy (messaging) · ` +
  `Frontend / Backend (build) · DevOps (infra, cost, deploy) · Legal (contracts, compliance, ` +
  `refunds) · AI/Orchestration (agent/automation design).\n` +
  `- Those are illustrations, not a whitelist — a dump about churn pulls Metrics, one about ` +
  `infra cost pulls DevOps, one about a contract pulls Legal, even if nobody named them first.\n` +
  `- Do NOT add a persona who would only echo another or rubber-stamp — that is padding.\n` +
  `- Do NOT withhold a discipline that genuinely owns part of the work just to keep the ` +
  `set small. Under-staffing real cross-domain work is the worse failure: one persona ` +
  `forced to work outside its expertise produces shallow, templated output.`;

// The task schema + dependency-direction rules every proposer/reviser must follow,
// so heterogeneous personas emit a uniform TaskDraft. Mirrors the legacy duo prompt.
const TASK_CONTRACT =
  `Each task is JSON: {name, description, priority(P0..P3), mode(dev|non-dev), ` +
  `depends_on: string[], source: number, label: string, acceptance: string}.\n` +
  `- "source": the [n] index of the WORK REQUEST this task primarily serves.\n` +
  `- "label": a 1-3 word lowercase handle (e.g. "stripe", "migration"); deps reference these.\n` +
  `- "acceptance": a CONCRETE, checkable definition of done a verifier can RUN — name the ` +
  `observable end state, not the steps (e.g. "GET /api/x returns 200 with field y", ` +
  `"npm test passes incl. a new test for Z"). For non-dev tasks, the deliverable's bar.\n` +
  `DEPENDENCY DIRECTION (wrong direction breaks the build): depends_on lists siblings that ` +
  `must finish FIRST ([] if independent). ADD/CREATE a shared thing → producer runs first, ` +
  `consumers depend on it. REMOVE/DELETE a shared thing → the removal runs LAST, depending on ` +
  `every task that stopped using it (a sink, not a root). MODIFY a shared contract → ` +
  `sequence producer→consumers. Deps MAY reference EXISTING tasks (including in-flight ones).\n` +
  `COLLISION-SAFETY (tasks run CONCURRENTLY in separate worktrees → parallel merge conflicts): ` +
  `two tasks that edit the SAME FILE, or both append to a SERIALIZED surface (a DB migrations ` +
  `directory — each emits a new migration that collides on apply/order, RLS policies on the same ` +
  `tables, a shared lockfile), must NOT be left independent EVEN WHEN neither needs the other's ` +
  `result. CHAIN them via depends_on (foundational / highest-risk first, then by priority) so they ` +
  `land one at a time. Distinct deliverables, SEQUENCED — not merged into one.\n` +
  `ACTIVATION (merged ≠ live): if a change only takes effect after a SEPARATE deploy/apply step ` +
  `the repo does NOT automate (edge functions need \`functions deploy\`; migrations need ` +
  `\`db push\`/a CI apply; a build needs publishing) — propose that activation as its OWN task ` +
  `depending on the change task(s). A merged PR that is never deployed is NOT done.\n` +
  `ALTITUDE (symptom vs cause): before proposing per-request patches, check whether several ` +
  `WORK REQUESTS are symptoms of ONE underlying cause — the same subsystem failing repeatedly, ` +
  `the same class of bug, the same missing guard/test/gate. If so, propose ONE root-cause task ` +
  `that fixes the CLASS: set "source" to the primary request and "sources":[every other [n] it ` +
  `supersedes] so those dumps are credited to it. Do NOT also propose the per-symptom patches ` +
  `unless one is independently urgent — then chain it via depends_on to the cause task. ` +
  `Name what the recurring failures reveal about the system in the description.`;

/** Shared context block (dumps + project context + standing backlog). */
function contextBlock(ctx: ConsensusContext): string {
  const backlog = ctx.existing.length
    ? `\n\nEXISTING TASKS for this project (don't re-propose the SAME scope; you MAY set ` +
      `depends_on to these EXACT names — [in-flight] ones are still running, so a follow-up ` +
      `that extends one should DEPEND on it, not replace it):\n${ctx.existing
        .map((e) => `- ${e.name}${e.label ? ` [${e.label}]` : ""} — ${e.state ?? "proposed"}`)
        .join("\n")}`
    : "";
  return (
    `PROJECT: ${ctx.key}\n\n` +
    `PROJECT CONTEXT (background, reference only — do NOT restate it, do NOT invent work ` +
    `beyond the requests):\n${ctx.context || "(not onboarded — no background context)"}\n\n` +
    `WORK REQUESTS (source shows where each came from; krill-followup = a gap a running task ` +
    `hit, not yet covered):\n${ctx.reqs.map((r, i) => `[${i}] (source=${r.source}) ${r.text}`).join("\n")}` +
    backlog
  );
}

/** A compact roster Caio picks from. */
function rosterList(team: Team): string {
  return team.personas.map((p) => `- ${p.name} (${p.area})`).join("\n");
}

const stamp = (t: TaskDraft, p: Persona): TaskDraft => ({
  ...t,
  owner_persona: p.name,
  owner_area: p.area,
});

/** Keep only nominations naming a real, not-yet-spoken persona. */
function validNominations(team: Team, noms: Nomination[], spoken: Set<string>): Nomination[] {
  const seen = new Set<string>();
  const out: Nomination[] = [];
  for (const n of noms || []) {
    const p = persona(team, n?.name || "");
    if (!p) continue;
    const key = p.name.toLowerCase();
    if (spoken.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: p.name, area: p.area, why: n.why || "" });
  }
  return out;
}

/* ---------- Phase 1: Caio nominates the entry personas ---------- */

async function nominate(
  team: Team,
  ctx: ConsensusContext,
  complete: Completer,
): Promise<{ scope: string; nominees: Nomination[] }> {
  const caio = persona(team, "Caio");
  const system =
    `${caio?.systemPrompt || ""}\n\n${ECONOMY}\n\n` +
    `You COORDINATE the team. First SIZE the work: is it single-discipline, ` +
    `multi-discipline, or near whole-bench? Then nominate the persona(s) that match — ` +
    `one for a narrow ask, several when the work genuinely spans disciplines. A request ` +
    `to redesign pricing/plans across many products is NOT a one-person job. Pick from ` +
    `this roster ONLY (use exact names):\n${rosterList(team)}\n\n` +
    `Return {"scope":"single|multi|broad","nominees":[{"name","area","why"}]}. ` +
    `"why" ties each persona to the part of the work they OWN. Don't nominate yourself ` +
    `unless orchestration is itself the work; don't pad with personas who'd only echo.`;
  // Routing memory: how this project's recent work was owned. A hint for
  // sizing/nominating — not a rule; a genuinely new kind of dump should still
  // route on its own merits.
  const priorRouting = ctx.priorRouting
    ? `\n\nPRIOR ROUTING (this project's recent plan runs — hint, not a rule):\n${ctx.priorRouting}`
    : "";
  const out = await complete<{ scope?: string; nominees?: Nomination[] }>({
    system,
    user: contextBlock(ctx) + priorRouting,
    model: config.models.nominate,
    purpose: "consensus:nominate",
  });
  const scope = (out?.scope || "multi").toLowerCase();
  const noms = validNominations(team, out?.nominees || [], new Set());
  // Never plan blind: if Caio names no one valid, fall back to the strategy+product
  // duo so a dump always reaches someone.
  if (!noms.length) {
    return {
      scope: "single",
      nominees: validNominations(
        team,
        [
          { name: "Augusto", area: "Strategy", why: "default planner — no domain owner nominated" },
          { name: "Maria", area: "Product", why: "default planner — decompose into shippable tasks" },
        ],
        new Set(),
      ),
    };
  }
  return { scope, nominees: noms };
}

/* ---------- Refine routing: pick the ONE right persona to revise a task ---------- */

/**
 * The Input/Refine flow used to hardcode Maria. This routes it WISELY: Caio picks
 * the persona best suited to revise THIS task given the user's input — preferring
 * the task's current owner, but switching when the input pushes the work into
 * another discipline (e.g. a finance task whose input raises a legal question).
 * Falls back to the owner, then Maria, if routing yields nothing usable.
 */
export async function pickRefiner(
  team: Team,
  task: { name: string; description?: string; owner_persona?: string | null; input: string },
  complete: Completer = completeJSON,
): Promise<Persona> {
  const fallback = persona(team, task.owner_persona || "") || persona(team, "Maria");
  const caio = persona(team, "Caio");
  const system =
    `${caio?.systemPrompt || ""}\n\n${ECONOMY}\n\n` +
    `Pick the ONE persona best suited to revise this task given the user's input. ` +
    `Default to the task's CURRENT OWNER; switch only if the input clearly moves the ` +
    `work into another discipline (e.g. a pricing task whose input raises a legal/refund ` +
    `question → Legal). Pick from this roster ONLY:\n${rosterList(team)}\n` +
    `Return {"name"}.`;
  const user =
    `TASK: ${task.name}\nDESCRIPTION: ${task.description || ""}\n` +
    `CURRENT OWNER: ${task.owner_persona || "(none)"}\nUSER INPUT: ${task.input}`;
  try {
    const out = await complete<{ name?: string }>({ system, user, model: config.models.nominate, purpose: "refine:route" });
    return persona(team, out?.name || "") || fallback!;
  } catch {
    return fallback!; // routing is best-effort; never block a refine on it
  }
}

/* ---------- Phase 2: a persona proposes tasks (+ may nominate others) ---------- */

async function propose(
  team: Team,
  p: Persona,
  ctx: ConsensusContext,
  complete: Completer,
  priorPile: TaskDraft[] = [],
): Promise<{ proposals: TaskDraft[]; nominations: Nomination[] }> {
  // Personas pulled in a later wave (handoff or completeness sweep) SEE what the
  // bench already proposed, so they add their slice instead of duplicating —
  // overlap prevented at the source rather than cleaned up in revision.
  const priorBlock = priorPile.length
    ? `\n\nALREADY PROPOSED BY THE BENCH (complement these — add only YOUR slice, do NOT ` +
      `duplicate or restate them; you MAY depend on them):\n${priorPile
        .map((t) => `- (${t.owner_persona}/${t.owner_area}) ${t.name}`)
        .join("\n")}`
    : "";
  const system =
    `${p.systemPrompt}\n\n${ECONOMY}\n\n` +
    `You are ${p.name} (${p.area}) on a planning bench WITH OTHER DISCIPLINES. Turn the WORK ` +
    `REQUESTS into concrete tasks that are YOUR DISCIPLINE'S SLICE — ground them in the PROJECT ` +
    `CONTEXT. Other personas are proposing in parallel; do NOT propose the whole job. If a ` +
    `request needs several disciplines (e.g. a pricing rewrite needs Finance amounts + Product ` +
    `packaging + Strategy positioning), propose ONLY your part. When several disciplines feed ONE ` +
    `shared deliverable (e.g. one doc), DON'T each re-propose "rewrite the doc" — propose your ` +
    `distinct contribution, and if a single task must own the file edit, make it depend on the ` +
    `inputs rather than duplicating it. Each WORK REQUEST in your area must yield at least one ` +
    `task unless an EXISTING task already covers the SAME scope. If a request is outside your ` +
    `specialty, leave it — do not stretch.\n\n` +
    `${TASK_CONTRACT}\n\n` +
    `If your work TOUCHES a domain another persona owns — you're pricing something ` +
    `(Finance), packaging it for customer types (Product), it has legal/contract/refund ` +
    `implications (Legal), it needs go-to-market (Marketing/Sales) or a real UI/UX flow — ` +
    `NOMINATE that persona rather than guessing in their lane. Don't stretch past your ` +
    `expertise; hand off instead.\n` +
    `Return {"proposals":[<task>...], "nominations":[{"name","area","why"}...]}. ` +
    `Either list may be empty.`;
  const out = await complete<{ proposals?: TaskDraft[]; nominations?: Nomination[] }>({
    system,
    user: `${contextBlock(ctx)}${priorBlock}${ctx.fileNote}`,
    model: config.models.plan,
    cwd: ctx.cwd,
    fileAccess: !!ctx.cwd,
    purpose: "consensus:propose",
  });
  const proposals = (Array.isArray(out) ? out : out?.proposals || []).map((t) => stamp(t, p));
  return { proposals, nominations: out?.nominations || [] };
}

/* ---------- Phase 3b: completeness sweep — who OWNS part of this but is absent? ---------- */

/**
 * After the bench has proposed, Caio checks the dump against the proposals for a
 * discipline that genuinely OWNS part of the work but is MISSING — the safety net
 * for "should have been routed but wasn't", including disciplines no one named.
 * Deliberately tight so it doesn't re-create the chorus the economy doctrine kills.
 */
async function sweep(
  team: Team,
  ctx: ConsensusContext,
  pile: TaskDraft[],
  spoken: Set<string>,
  complete: Completer,
): Promise<Nomination[]> {
  const caio = persona(team, "Caio");
  const proposed = pile.length
    ? pile.map((t) => `- (${t.owner_persona}/${t.owner_area}) ${t.name}`).join("\n")
    : "(nothing yet)";
  const system =
    `${caio?.systemPrompt || ""}\n\n${ECONOMY}\n\n` +
    `The bench has ALREADY PROPOSED the tasks below. Name ONLY a discipline that genuinely ` +
    `OWNS part of THIS work and is MISSING from the proposals — a real gap that will go ` +
    `unaddressed, or get done badly by a persona outside its expertise. This is a strict ` +
    `gap check: NOT nice-to-haves, NOT reviewers/approvers, NOT "for completeness", NOT a ` +
    `discipline whose part is already covered. If coverage is complete, return an empty list. ` +
    `Pick from this roster ONLY:\n${rosterList(team)}\n` +
    `Return {"missing":[{"name","area","why"}]} — "why" names the unaddressed part they own.`;
  const user =
    `${contextBlock(ctx)}\n\nALREADY PROPOSED (the part MISSING from the proposals — do not ` +
    `re-list these owners unless a DISTINCT part of their area is still uncovered):\n${proposed}`;
  const out = await complete<{ missing?: Nomination[] }>({
    system,
    user,
    model: config.models.nominate,
    purpose: "consensus:sweep",
  });
  return validNominations(team, out?.missing || [], spoken);
}

/* ---------- Phase 4: synthesis — merge overlapping proposals into the final set ---------- */

/**
 * One merge pass replaces the old peer-revision (which collapsed: symmetric
 * personas all deferred and withdrew everything → near-empty). This is NOT a
 * gatekeeper — it doesn't approve or kill work. It MERGES: tasks that produce the
 * SAME deliverable become one task carrying every contributing discipline's input;
 * distinct slices pass through untouched. Deterministic in intent, one sonnet call,
 * never drops a contribution. Caio runs it (neutral coordinator).
 */
async function synthesize(
  team: Team,
  ctx: ConsensusContext,
  pile: TaskDraft[],
  complete: Completer,
): Promise<TaskDraft[]> {
  if (pile.length <= 1) return pile;
  const caio = persona(team, "Caio");
  const system =
    `${caio?.systemPrompt || ""}\n\nYou are MERGING the bench's proposals into the final task ` +
    `list — a librarian, not a judge. RULES:\n` +
    `- Tasks producing the SAME deliverable (same file/doc/change) → MERGE into ONE task whose ` +
    `description + acceptance carry EVERY contributing discipline's input. Give it the single ` +
    `most-fitting owner (owner_persona + owner_area), and credit the others in the description.\n` +
    `- Tasks that are DISTINCT slices (different deliverables) → keep AS-IS, one owner each.\n` +
    `- NEVER delete a discipline's contribution — fold it in. The final set must cover everything ` +
    `proposed.\n` +
    `- SAME deliverable → merge into one. DISTINCT deliverables that touch the SAME FILE/surface ` +
    `(e.g. two RLS-policy migrations, two edits to one module) → keep BOTH but CHAIN them via ` +
    `depends_on per COLLISION-SAFETY — never leave same-surface tasks parallel-independent.\n` +
    `- Preserve depends_on, label, acceptance, and source on every task.\n\n` +
    `${TASK_CONTRACT}\n\n` +
    `Return {"tasks":[<final task, each WITH owner_persona and owner_area>...]}.`;
  const user =
    `${contextBlock(ctx)}\n\nPROPOSED BY THE BENCH (merge same-deliverable, keep distinct ` +
    `slices, fold in every owner's input):\n${pile
      .map((t) => `- [${t.owner_persona}/${t.owner_area}] ${t.name} [${t.label || ""}] :: ${t.description || ""}`)
      .join("\n")}${ctx.fileNote}`;
  const out = await complete<{ tasks?: TaskDraft[] }>({
    system,
    user,
    model: config.models.plan,
    cwd: ctx.cwd,
    fileAccess: !!ctx.cwd,
    purpose: "consensus:synthesize",
  });
  const merged = (out?.tasks || []).filter((t) => t && t.name);
  return merged.length ? merged : pile; // safety: never return empty
}

/* ---------- Baseline: single strong planner (Caio's A/B control) ---------- */

/**
 * One opus call, the whole team's lenses injected, repo grounding on — the
 * "simplest thing that works" baseline to measure the multi-agent pipeline
 * against. No fan-out, no merge, no sweep. The planner adopts the relevant
 * disciplines itself and tags each task with the owner it judges fits.
 *
 * DELIBERATELY THIN (do not "fix"): this control arm injects only name/area
 * roster lines, while the consensus path injects each persona's FULL
 * systemPrompt (context.md + rules.md, verbatim — voice is load-bearing).
 * That asymmetry is the design: it measures "consensus + full persona voice"
 * against "one strong generalist with labels". Any A/B conclusion drawn from
 * it therefore confounds fan-out with voice — if you ever need to isolate the
 * voice variable, add a THIRD arm (single planner + full persona contexts)
 * rather than fattening this one.
 */
export async function planSingle(
  team: Team,
  ctx: ConsensusContext,
  complete: Completer = completeJSON,
  report: (text: string) => void = () => {},
): Promise<ConsensusResult> {
  report("⟳ Single planner (opus) drafting…");
  const lenses = team.personas.map((p) => `- ${p.name} (${p.area})`).join("\n");
  const system =
    `You are the PLANNING LEAD with the whole team's lenses available:\n${lenses}\n\n` +
    `${ECONOMY}\n\n` +
    `Turn the WORK REQUESTS into concrete tasks, applying the RELEVANT disciplines' judgment ` +
    `YOURSELF — for pricing think Finance (unit economics) + Product (packaging per customer ` +
    `type) + Strategy (positioning); for refunds/contracts think Legal; for go-to-market think ` +
    `Marketing + Sales; for a flow think UX + UI + the engineer. TAILOR to the specifics — never ` +
    `copy one product's template onto others. Tag each task with owner_persona + owner_area = the ` +
    `discipline that owns it.\n\n` +
    `${TASK_CONTRACT}\n\n` +
    `Return {"tasks":[<task, each WITH owner_persona and owner_area>...]}.`;
  const out = await complete<{ tasks?: TaskDraft[] }>({
    system,
    user: `${contextBlock(ctx)}${ctx.fileNote}`,
    model: config.models.nominate, // the opus tier
    cwd: ctx.cwd,
    fileAccess: !!ctx.cwd,
    purpose: "plan:single",
  });
  const drafts = (Array.isArray(out) ? out : out?.tasks || []).filter((t) => t && t.name);
  report(`Single planner produced ${drafts.length} task${drafts.length === 1 ? "" : "s"}`);
  const transcript: ConsensusEvent[] = [
    { kind: "propose", by: "Single planner", area: "opus", tasks: drafts.map((t) => t.name), at: Date.now() },
  ];
  return { drafts, transcript };
}

/* ---------- Orchestrator ---------- */

export async function planConsensus(
  team: Team,
  ctx: ConsensusContext,
  complete: Completer = completeJSON,
  report: (text: string) => void = () => {},
): Promise<ConsensusResult> {
  const transcript: ConsensusEvent[] = [];
  const now = () => Date.now();

  // Phase 1 + 2 + 3: nominate → propose → converge (fixpoint on nominations).
  const spoken = new Set<string>();
  report("⟳ Caio routing the dump…");
  const { scope, nominees } = await nominate(team, ctx, complete);
  let queue = nominees;
  report(`Caio nominated ${queue.map((n) => n.name).join(", ")} (${scope})`);
  transcript.push({ kind: "nominate", by: "Caio", nominees: queue, at: now() });

  let pile: TaskDraft[] = [];
  while (true) {
    // Drain the nomination queue: each wave proposes seeing the prior pile, and
    // may hand off to others (convergence fixpoint, speak-once).
    while (queue.length) {
      const snapshot = pile.slice(); // this wave complements what's already proposed
      const round = queue
        .map((n) => persona(team, n.name))
        .filter((p): p is Persona => !!p && !spoken.has(p.name.toLowerCase()));
      for (const p of round) spoken.add(p.name.toLowerCase());
      if (!round.length) break;

      report(`⟳ ${round.map((p) => p.name).join(", ")} proposing…`);
      const results = await Promise.all(round.map((p) => propose(team, p, ctx, complete, snapshot)));

      const nextNoms: Nomination[] = [];
      results.forEach((r, i) => {
        const p = round[i];
        pile.push(...r.proposals);
        report(`${p.name} (${p.area}) proposed ${r.proposals.length}`);
        transcript.push({
          kind: "propose",
          by: p.name,
          area: p.area,
          tasks: r.proposals.map((t) => t.name),
          at: now(),
        });
        if (r.nominations.length)
          transcript.push({ kind: "nominate", by: p.name, nominees: r.nominations, at: now() });
        nextNoms.push(...r.nominations);
      });

      queue = validNominations(team, nextNoms, spoken);
    }

    // Completeness sweep — only for genuinely cross-domain work. A narrow,
    // single-discipline dump doesn't need the extra Opus gap-check.
    if (scope === "single") break;
    report("⟳ Caio checking for missing disciplines…");
    // validNominations(spoken) can only return NEW personas, so this terminates.
    const missing = await sweep(team, ctx, pile, spoken, complete);
    if (!missing.length) break;
    report(`Caio pulled ${missing.map((n) => n.name).join(", ")} (gap)`);
    transcript.push({ kind: "nominate", by: "Caio (completeness)", nominees: missing, at: now() });
    queue = missing;
  }

  // Phase 4: synthesis. One merge pass folds same-deliverable proposals into a
  // single owned task and passes distinct slices through. Replaces the peer
  // revision that collapsed (symmetric defer → near-empty). synthesize() never
  // returns empty (falls back to the raw pile).
  const before = pile.length;
  if (before > 1) report(`⟳ Caio merging ${before} proposals…`);
  const drafts = await synthesize(team, ctx, pile, complete);
  report(`Merged ${before} → ${drafts.length} final task${drafts.length === 1 ? "" : "s"}`);
  transcript.push({ kind: "merge", by: "Caio", before, after: drafts.length, at: now() });

  return { drafts, transcript };
}
