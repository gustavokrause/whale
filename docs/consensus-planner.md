# Dynamic peer-consensus planner

How whale turns a project's pending dumps into proposed tasks using the **whole
ai-team bench** — wisely, not by spawning everyone every time.

> TL;DR: Caio nominates the relevant personas → each proposes tasks only
> in its specialty (and may nominate others) → the set converges by fixpoint →
> Caio merges same-deliverable proposals into the final set. No numeric caps;
> termination is by natural convergence.

## Why this exists

The first version of whale's planner hard-wired **Augusto (Strategy) + Maria
(Product)** into every plan, ignoring the other 12 personas the ai-team roster
defines. A billing dump never reached Fernanda; a legal-risk dump never reached
Patrícia. The bench existed but only 3 players ever took the field.

This planner unlocks the full roster while honoring the AGENTS.md **routing
economy**: bring the minimum, escalate only on a real cross-area dependency.

## The hard constraint that shapes the design

whale runs each persona as a **separate sandboxed `claude` CLI call** with the
`Task` tool **blocked** (`runner.ts` `SANDBOX_DISALLOWED`). Personas therefore
**cannot spawn each other inside Claude.** Every nomination is JSON returned to
whale, and **whale's TS loop** (`src/lib/consensus.ts`) does the dispatching.
There is no in-Claude agent recursion — the orchestration is deterministic and
lives in our code, which is what makes it testable and bounded.

## The four phases

```
                 ┌──────────────── src/lib/consensus.ts ────────────────┐
  dumps ─▶ 1. NOMINATE ─▶ 2. PROPOSE ─▶ 3. CONVERGE ─▶ 4. SYNTHESIZE ─▶ TaskDraft[]
            (Caio)         (per persona)  (fixpoint)    (Caio merges)
```

1. **NOMINATE** — Caio (AI/Orchestration) reads the work requests and names the
   persona(s) whose specialty is genuinely required — one for a narrow ask,
   several when the work spans disciplines. Runs on Caio's **routing** model
   (`model_nominate`, default opus) — routing wisdom is the bottleneck, so it
   gets the strongest model. If Caio names no one valid, it falls back to
   the Augusto+Maria duo so a dump never plans blind.

2. **PROPOSE** — each nominee proposes tasks **only in its specialty**, tagged
   with `owner_persona` / `owner_area`, and **may nominate others** when planning
   genuinely depends on another discipline. Runs on `model_plan` (default
   sonnet). Nominees in a round run in parallel.

3. **CONVERGE** — newly-nominated personas run in further rounds until a round
   names nobody new (a **fixpoint**). Each persona **speaks once** per plan run —
   not an arbitrary cap, just "you already brought your view." The roster is
   finite (14), so this always terminates; it reaches all of them only if the
   dump genuinely spans everything (rare, and that's the team's call). Personas
   pulled in a **later wave see what the bench already proposed** and are told to
   *complement, not duplicate* — overlap is prevented at the source.

3b. **COMPLETENESS SWEEP** — once nominations drain, Caio (on `model_nominate`)
   checks the dump against the proposals for a discipline that genuinely **owns**
   part of the work but is **absent** — the safety net for "should've been routed
   but wasn't," including disciplines no one named (e.g. a dump where Sales/DevOps/
   Metrics/Legal owns a slice nobody covered). Strict by design — owners only, not
   nice-to-haves or reviewers — so it doesn't undo the economy. Anyone it pulls
   proposes (seeing the pile), then the sweep repeats until coverage is clean.
   Speak-once bounds it; it terminates. Costs ~1 Opus call per plan even when
   nothing's missing — the price of the coverage guarantee.

4. **SYNTHESIZE** — one merge pass (`synthesize`, Caio on `model_plan`) folds the
   pile into the final set: tasks producing the **same deliverable** (same
   file/doc/change) become **one task** whose description + acceptance carry every
   contributing discipline's input; **distinct slices pass through untouched**, one
   owner each. It is a **librarian, not a judge** — it never approves, gates, or
   deletes a contribution, only merges overlaps. Never returns empty (falls back to
   the raw pile). One call, not a loop.

   > **Why a merge pass, not peer revision.** Earlier versions had each persona
   > **revise its own** tasks ("withdraw what a peer covers"). On a heavily-
   > overlapping multi-persona plan (7 personas all proposing a "rewrite precos.md"
   > variant), **symmetric agents all deferred** — each withdrew assuming a peer
   > would keep theirs — collapsing 17 tasks → 2 (one arbitrary owner), over 6
   > sequential rounds (~30 min). Sequential + a floor stopped *zero* but not
   > *near-zero*: the model is structurally wrong for dedup. A single merge step
   > resolves same-deliverable overlap deterministically in one call, preserves
   > every discipline's slice, and runs in seconds. This is the one coordinating
   > step in an otherwise no-arbiter design — chosen on evidence, after two live
   > collapses.

The survivors are flattened into `TaskDraft[]` and handed to the existing
triage + store path unchanged.

## Refine routing (Input flow)

The Input/Refine flow is routed the same way. It used to hardcode **Maria**; now
`pickRefiner` (Caio on `model_nominate`) sends a refine to the persona best
suited to it — defaulting to the task's **current owner**, switching only when the
input pushes the work into another discipline (a pricing task whose input raises
a refund question → Legal). The refined task is re-stamped with the new owner, so
the owner chip reflects the handoff. Best-effort: a routing error falls back to
the owner, then Maria — a refine never blocks on it. Off when `WHALE_CONSENSUS=0`
(reverts to Maria).

## What does NOT change (the brakes stay on)

- **Triage** (`stages.ts` `triage`) still runs per surviving task — risk rubric,
  safe-words, self-edit guard. The consensus bench proposes; triage still gates.
- **Self-edit guard**: tasks targeting `whale`/`krill` still force human review
  on every dial. The bench cannot auto-merge changes to itself.
- Push/approve/dependency ordering are untouched.

## Config

### Planner modes (Settings → Engine, toggle live)

`planner` picks how a dump becomes tasks — UI-toggleable (DB override, no restart),
env default `WHALE_PLANNER`:

| Mode | Cost | What it is | Use when |
| --- | --- | --- | --- |
| **single** | ~1 opus call, ~1 min | One Opus planner with the whole team's lenses in a single pass (`planSingle`). | Routine dumps — cheap + fast, deeply grounded. |
| **consensus** | ~9 calls, slower | The multi-agent bench below (nominate → propose → merge). | Big cross-domain work where you want each discipline's distinct slice. |
| **duo** | 1 call | Legacy Augusto + Maria pair. | Fallback / comparison. |

Both real planners share the rest of the engine knobs:

| Knob | Default | Effect |
| --- | --- | --- |
| `WHALE_CONSENSUS` | **on** (`!= "0"`) | Legacy toggle; `0` makes the default planner the duo. Superseded by `planner`. |
| `WHALE_MODEL_NOMINATE` | **opus** | Caio's **routing** model — nomination + refine routing. Routing wisdom (seeing a dump spans Finance+Strategy+Product) is the bottleneck, so it runs on the strongest model. |
| `model_route` | haiku | Inbox-entry classify (task/context/new_project/ask) — a simpler call, stays cheap. |
| `model_plan` | sonnet | Propose + synthesis (merge) calls. |

### Routing doctrine (don't re-collapse it)

Caio sizes the work first — **single / multi / broad** — then nominates a panel
to match. The `ECONOMY` constant deliberately leans toward **pulling the
discipline that owns part of the work** (pricing→Finance+Product+Strategy,
refunds→Legal, GTM→Marketing+Sales, a flow→UX+UI+engineer) and against padding
with echo-only personas. An earlier version tuned this too tight ("usually ONE")
and collapsed every plan onto a single persona — under-staffing real
cross-domain work produced shallow, templated output (e.g. copying one product's
3-tier pricing onto 17 others). If you see single-owner plans on clearly
multi-domain dumps, the fix is here + the nomination model, not the machinery.

The toggle is also a UI/DB override (`config.consensus`), so you can A/B without
a restart via `PATCH /api/config`. **Rollback** to the duo: set
`WHALE_CONSENSUS=0` and restart (or flip the override).

### Cost reality

The legacy duo was **one** `claude` spawn per plan. Consensus is **1 (Caio
nominate) + N proposers + extra convergence rounds + 1 (Caio completeness sweep,
cross-domain only) + 1 (Caio synthesis/merge)**. A single-owner dump is ~3
spawns; a cross-domain dump can be ~9. Mitigations already in place: proposers
run in parallel within each round, the completeness sweep is skipped for
`scope=single`, and the synthesis merge is skipped when ≤1 proposal. This is the
real price of using the whole bench — it's mode-gated (`planner`) so you can fall
back to `single` or `duo`.

## Observability

Every proposed task carries:

- `owner_persona` / `owner_area` — who proposed it (shown as a chip on the
  Proposed tab).
- `consensus_log` — the full transcript for that plan run (nomination graph +
  per-persona proposals + the final merge), stamped identically on every task of
  the run. Events are `nominate` / `propose` / `merge`. Rendered as the
  expandable **"consensus · N personas"** trail in the task's expanded card
  (`ConsensusTrail` in `whale-app.tsx`). Mirrors the `refine_log` pattern.

`[]` / `NULL` owner = a legacy duo plan (pre-consensus or flag off).

## Code map

| File | Role |
| --- | --- |
| `src/lib/consensus.ts` | The orchestration loop (`planConsensus`), the phase functions, the `single` baseline (`planSingle`), and refine routing (`pickRefiner`). Completer is injectable for tests. |
| `src/lib/stages.ts` | `planRealOrConsensus` branches on the `planner` mode (`single` / `consensus` / `duo`); `planSingle`/`planConsensus` are the real paths, `planRealDuo` is the legacy fallback; `triageAndStore` carries owner + transcript. |
| `src/lib/config.ts` | `config.planner` mode (`WHALE_PLANNER`) + the legacy `config.autonomy.consensus` (`WHALE_CONSENSUS`). |
| `src/db/schema.ts` + migrations `0007_*`/`0008_*`/`0009_*` | `owner_persona`, `owner_area`, `consensus_log`, and the `config.consensus` / `config.planner` columns. |
| `src/components/whale/whale-app.tsx` | Owner chip + `ConsensusTrail`. |
| `tests/consensus.test.ts` | Scripted-completer tests: convergence, completeness sweep, synthesis merge (+ empty fallback), speak-once, `planSingle`, `pickRefiner`, duo fallback. |

## Testing it

`tests/consensus.test.ts` drives `planConsensus` with a **scripted completer**
(no `claude` spawn), so the loop itself is covered offline: nomination →
propose+nominate → fixpoint convergence → completeness sweep → synthesis merge
(same-deliverable folds, distinct slices survive, empty-merge falls back to the
pile) → speak-once dedup → `planSingle` → `pickRefiner` routing → empty-nomination
duo fallback. Run `npm test`.

To see it live: set the project's runner to `real`, capture a cross-domain dump
(e.g. "add paid plans with refunds"), click **Plan**, and open a proposed task —
the owner chip names who proposed it and the consensus trail shows Caio's
nomination, each persona's contribution, and the final merge.
