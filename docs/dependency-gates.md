# Dependency gates and the re-evaluation loop

How whale's two edge types encode intent, and why the re-evaluation loop exists
to surface the consequences of a gate result — not to apply them automatically.

> TL;DR: A gate edge says "this task only exists if the upstream returns GO."
> When a gate resolves, whale flags dependents with a per-task verdict
> (`keep / revise / park / kill`) and stops — a human applies the verdict.
> Nothing is auto-applied; the loop's job is to surface the fork, not decide it.

## Why this exists

One project's plan began with an interview-driven track: landing page →
copy → hero image → thank-you flow, all wired together. Interviews pivoted the
strategy to a survey approach. The landing-page task got rejected. Under the old
behavior, its four dependents were silently orphaned — the dep edge disappeared
from their records and no one was told. The operator only found out when `push`
hit krill with a dangling dep, or worse, when the tasks were pushed with deps
quietly dropped.

That's the failure this system fixes. Reject now flags every dependent with a
`pending` verdict and a plain-language note. The dep edge stays. The operator
sees the badge in Proposed and resolves each one explicitly. Same machinery
covers the gate path: if the interview memo had come back "survey wins, no
landing page," the downstream tasks would have received `revise`/`kill` verdicts
from the re-eval model instead of silently surviving as if the premise still held.

This doc exists for the same reason `consensus-planner.md` names the "17→2
peer-self-withdrawal" case: the rationale needs to outlive the operators who
lived it.

## The two edge types

| Type | Stored as | What it means |
|------|-----------|---------------|
| `"order"` | absent from `dep_types` (default) | The upstream's **artifact** is needed to start the downstream. Ordering only; no go/no-go semantics. |
| `"gate"` | `dep_types[upstreamName] = "gate"` | The upstream's **result decides whether the downstream should exist**. A discovery, research, or go/no-go task. |

Both fields are editable after the fact: the **Gates** button on an expanded
proposal (any task with deps, not yet pushed) toggles each edge order↔gate and
edits the premise, via `PATCH /api/proposed/:id`. The planner gets edge types
wrong sometimes, and every dump distilled before `dep_types` existed reads as
all-order — without an editor the only way to tag a gate was a direct DB write.
The PATCH validates: a type on a name that is not one of the task's own deps is
rejected (it would be invisible in the UI and silently wrong at push time), and
the submitted map fully replaces the stored one.

Missing key in `dep_types` always reads as `"order"` — every legacy edge is
safe without backfill.

### How the planner decides which to emit

Every proposer (and the synthesis and duo paths) shares one `TASK_CONTRACT`
(`src/lib/consensus.ts:94`). The contract's rule:

> Discovery / research / go-no-go / spike tasks are gates by default: a task
> whose existence depends on a decision task's outcome **MUST** declare that
> decision as a gate edge **AND** state the premise.

In practice: if the downstream only exists when the upstream returns GO (e.g. a
build task that only runs if an interview memo approves a direction), the
proposer returns `{label, type: "gate"}` in `depends_on`. String form or
`{label, type: "order"}` is an order edge. Normalized by `normalizeDraftDeps`
in `src/lib/stages.ts:46`.

Schema anchor: `dep_types` column in `src/db/schema.ts:65`.

### Premise: what it is and why every gate-dependent task declares one

`premise` is one sentence naming the assumption the task rests on
(`src/db/schema.ts:68`). `""` means unconditional. Gate-dependent tasks **must**
state it (enforced by `TASK_CONTRACT` in `consensus.ts:105-106`):

> `"premise": one sentence naming the assumption this task rests on; "" when
> unconditional. Gate-dependent tasks MUST state the premise
> (e.g. "assumes GO on spike-auth").`

The premise is load-bearing during re-evaluation: `reevaluateReal` in
`src/lib/stages.ts:670` feeds each dependent's premise + the gate result to the
model with the rule:

> `1. A premise contradicted by the gate result → verdict MUST be "kill" or
> "revise", NEVER "keep".`

Refine is explicitly forbidden from nulling a stated premise
(`src/lib/pipeline.ts:434-435`):

```ts
// Never null out a stated premise — it protects downstream re-evaluation.
premise: r.premise?.trim() || t.premise,
```

## The re-evaluation loop

```
  Gate task resolves (DONE/CANCELED in krill)
         │
         ▼
  enrichPushed detects DONE/CANCELED gate
  → stamps each same-project gate-dependent:
      reeval_status = "pending"
      reeval_source = gate.id
      reeval_note   = `gate "<name>" observed DONE`
  [pipeline.ts:636-656, inside enrichPushed:590]
         │
         ▼ (operator triggers manually, or POST /api/proposed/:gateId/reevaluate)
         │
  reevaluateSubtree [pipeline.ts:481]
  → fetches gate result from krill (or operator paste)
  → collects transitive gate-dependents (BFS)
  → calls reevaluateReal [stages.ts:670]
     model evaluates premise vs result per dependent
     → verdict: keep | revise | park | kill
     → revision blob when verdict=revise
  → persists reeval_status + reeval_note + reeval_revision per dependent
         │
         ▼ (operator reviews badge in Proposed tab)
         │
  ┌──────┴──────┐
  │             │
  APPLY         DISMISS
  POST /api/proposed/:depId/reeval-apply     POST .../reeval-dismiss
  reevalApply [pipeline.ts:531]              reevalDismiss [pipeline.ts:571]
  sole writer of revised canonical fields    clears stamp without applying
  keep→clears stamp                          reeval_status → null
  park→disabled=true                         reeval_note   → null
  kill→status=rejected                       reeval_source → null
  revise→patches name/desc/acceptance/deps   reeval_revision → null
  ── both append the gate id to reeval_resolved, so the flag stays down ──
```

Trigger 1 (automatic): `enrichPushed` is called on every Proposed tab load
(`GET /api/proposed`). It reads back live krill statuses for pushed tasks and,
as a side-effect, flips the `reeval_status` of every gate-dependent whose gate
just landed DONE or CANCELED (`pipeline.ts:636-656`). No operator action needed
to get the badge; it appears on next page load.

Trigger 2 (manual): **Re-evaluate** — `POST /api/proposed/:gateId/reevaluate`
running `reevaluateSubtree`. This is what actually calls the model and writes the
per-dependent verdict.

It runs from **two places, one handler**: the gate's own row, and the band on
every flagged dependent. The band's button is the important one — it names the
gate (`Re-evaluate MV-17 wedge-call`) and runs it from where the operator already
is. Before, the band said "open MV-17 and hit Re-evaluate" in plain text, on a
board where that row could be a screen away. Both surfaces gate on the same
`gateHasOutcome()` predicate, so neither can offer what the other refuses, and
the trigger name is a jump link to the gate's row.

### Reviewing the outcome (`GateOutcomeDialog`)

krill has no single "result" column, so `krill.getTaskOutcome` assembles one from
`diff_text` (for a non-dev task the deliverable *is* the doc) plus the task's
stage comments, and reports which of those it used as `source`. Metadata alone
(name, acceptance) is deliberately NOT an outcome — evaluating against a stub
produces confident nonsense — so it returns null and the operator pastes instead.

`preview: true` returns that text, its provenance, krill's status, the dependent
list and any collisions **without spending a model call**. The UI opens it in
`GateOutcomeDialog`: the outcome in a half-viewport editor, where it came from,
who will be judged, and one primary button. It is editable because krill's stored
outcome can be stale — a research task marked DONE months before its findings
land still reads as whatever diff it produced at the time, and a dozen downstream
verdicts are only as good as this text.

### Two gates over one subtree

`collectDescendants` walks every edge, not just gate edges, so two gates over the
same branch both reach the same tasks — the normal shape, not an edge case. A
dependent already carrying a **real verdict** (not a bare `pending` flag) from a
*different* gate is therefore skipped and returned in `skipped[]`, naming the
gate that holds it. `preview` reports the collision up front so the dialog can
say "6 of 14 already carry verdicts from MV-17"; replacing them is an explicit
`overwrite: true` opt-in. Without this the second gate silently overwrote
judgements the operator had not read yet.

### Resolution is durable (`reeval_resolved`)

Apply and dismiss both clear the verdict fields, so nothing in them can record
that a gate was already dealt with. `reeval_resolved` — a JSON array of gate ids
on the dependent — carries that fact instead. Without it two things break, and
both did:

- `enrichPushed` sees "gate DONE, no verdict" on the next poll (seconds later)
  and re-stamps `pending`, undoing the operator's apply forever.
- The push guard keyed on `reeval_status == null`, which is *also* the state
  after a verdict is applied — so a resolved task was deferred permanently.

The guard is now `unresolvedGates()` (`pipeline.ts`): a gate blocks the push
while the verdict is `pending`, or while that gate's id is absent from
`reeval_resolved`. A gate that hasn't finished yet is already blocked by ordinary
dependency ordering, so this only has to cover "gate finished, verdict not
resolved". Because the set is appended and never replaced, a task with two gate
edges is re-evaluated once per gate and then settles instead of ping-ponging.

The guard **fails open on an upstream that is not a proposal** — deleted, or an
edge naming something never distilled. A gate with no row behind it can't be
re-evaluated (no Re-evaluate button) and may carry no verdict band to dismiss, so
failing closed would strand the dependent with no in-app way out. Ordinary
dependency ordering still refuses a genuinely unsatisfied name; a gate that isn't
there gates nothing.

### One guard, shipped as data (`gated_by`)

The UI must grey out exactly what the server refuses. It does not re-derive the
rule: `withGateState` (`pipeline.ts`) runs `unresolvedGates` over every row and
`GET /api/proposed` attaches the result as `gated_by` on **both** the `?sync=1`
and plain paths. The UI's `unresolvedGates(p)` is `p.gated_by ?? []` and nothing
more. A second copy of the rule drifts, and the visible failure is the UI
offering a Push the server then defers. `withGateState` re-reads each row from
the DB before checking, because callers routinely hold a copy taken before
`enrichPushed` stamped `pending` on it.

## Finding the work

The board carries ~100 proposals and only a handful ever want a human. The
Proposed tab is filtered by a lens bar — **Needs you · Ready · Blocked · All**,
each with a live count — and opens on *Needs you* whenever that count is
non-zero, without overriding a lens the operator picked.

*Needs you* = a flag or verdict sitting on the task, **or** a finished gate whose
subtree nobody has judged yet. That is the whole queue: five rows on a board of a
hundred. A dump group whose every task finished in krill collapses by default
(marked `all done`) — it is a receipt, not work. The sidebar badge counts flagged
tasks rather than the total, since nobody acts on "104"; the total is in the
tooltip. It is computed from the DB alone (`reeval_status != null`), so a gate
that is merely *ready to run* — which needs krill's live status — is counted by
the lens, not the badge.

## Why verdicts are never auto-applied

The model can be wrong. A premise may be ambiguous enough that two reasonable
operators would disagree on the verdict. Auto-applying on every gate result
would silently rewrite the backlog — killing tasks the operator wanted to park,
revising scope in ways that don't reflect the operator's intent, and doing so
without a second look. There is no undo.

The loop's job is to surface the fork: "this dependent assumed X; the gate says
Y — decide." The operator applies or dismisses each verdict explicitly. That
one-click confirm is the only thing standing between the model's read and a
permanent state change.

Stripping that confirm would trade a few seconds of operator time for an
automated rewrite that happens in the background, invisible, on every gate
resolution. The cost is not worth it.

## Reject/kill hygiene — flag the corpse, don't strip it

When a proposed task is rejected, `reject` in `pipeline.ts:380` calls
`flagDependents` (`pipeline.ts:357`), which stamps every same-project
non-rejected dependent with:

- `reeval_status = "pending"`
- `reeval_source = <rejected task id>`
- `reeval_note = 'depends on rejected "<name>" — re-evaluate or rewrite dep'`

The dep edge in `deps` is **not removed**. The comment on `flagDependents`
(`pipeline.ts:353-356`) is explicit:

> Does NOT strip the dep edge — visibility of the corpse is the point.

Why: if you strip the edge, the dependent looks self-contained — the operator
has no signal that it was only viable because the rejected upstream existed. The
dep stays visible so the operator can see exactly what's broken and decide: keep
(rewrite the dep or make the task unconditional), revise, park, or kill. Same
`reeval_status` machinery as the gate path — same badge, same apply/dismiss
endpoints.

This was the fix for that case (commit `e80824c`, WH-20): reject no
longer orphans dependents silently; it flags them and leaves the evidence in
place.

## Push behavior — gated dependents are deferred, not dropped

`pushBatch` (`pipeline.ts:267-273`) and `push` (`pipeline.ts:704-707`) both
check gate edges before touching krill:

```ts
const gates = gateDeps(t);
if (gates.length && t.reeval_status == null) {
  // defer — never push with an unresolved gate
}
```

A task with gate deps and `reeval_status == null` is deferred in `pushBatch`
(returned with `deferred: true, gatedBy: [...]`) and refused in single `push`
(returns the same shape). The gate must be resolved — via reevaluate → apply or
dismiss — before the dependent can land in krill.

A `reeval_status` of `"keep"` (applied or cleared after dismiss) satisfies the
guard. A `null` status means the gate result has not been evaluated for this
dependent, and the push is blocked.

This prevents the pre-WH-17 failure mode: a task dependent on a go/no-go
outcome being pushed into krill as if the outcome were decided when it isn't.

## Field and endpoint reference

| Field / Endpoint | Semantics |
|-----------------|-----------|
| `dep_types` | JSON map `{depName: "gate"\|"order"}`. Missing key = `"order"`. |
| `premise` | One sentence: the assumption this task rests on. `""` = unconditional. Required on gate-dependent tasks. |
| `reeval_status` | Current verdict: `null` (not evaluated), `"pending"` (flagged, model not yet run), `"keep"`, `"revise"`, `"park"`, `"kill"`. |
| `reeval_note` | Why the verdict — which gate result or rejection triggered it, + model's reasoning. |
| `reeval_source` | `id` of the gate task or rejected task that triggered re-evaluation. |
| `reeval_revision` | JSON blob `{revised_name?, revised_description?, revised_acceptance?, revised_depends_on?}`. Written on `verdict=revise`, applied by `reeval-apply`, cleared by both apply and dismiss. |
| `reeval_resolved` | JSON array of gate ids already resolved for this task. Appended by apply/dismiss; survives the verdict being cleared. Stops the poll re-stamping and the push guard deferring forever. |
| `POST /api/proposed/:gateId/reevaluate` | Run the model against the gate result + dependents' premises; write per-dependent verdicts. Body: `{result?}` overrides krill's outcome, `{preview:true}` reads it without a model call, `{overwrite:true}` re-judges dependents held by another gate. |
| `POST /api/proposed/:depId/reeval-apply` | Apply the pending verdict. Sole writer of revised canonical fields. |
| `POST /api/proposed/:depId/reeval-dismiss` | Clear the pending verdict stamp without applying. Counts as a resolution. |
| `PATCH /api/proposed/:id` | Accepts `premise`, `dep_types` and `deps` (all full replacement, validated against the task's own edges and its project's tasks) — the Gates editor's endpoint. Dropping an edge drops its type with it. |

## Code map

| File | What |
|------|------|
| `src/lib/consensus.ts:94` | `TASK_CONTRACT` — gate vs order decision rule + premise requirement shared by all proposers. |
| `src/lib/stages.ts:46` | `normalizeDraftDeps` — normalizes `depends_on` entries into `deps[]` + `dep_types{}`. |
| `src/lib/stages.ts:670` | `reevaluateReal` — calls the model with gate result + dependents' premises; applies the "premise contradicted → kill or revise, NEVER keep" rule. |
| `src/lib/pipeline.ts:357` | `flagDependents` — stamps dependents pending on reject or explicit flag; does NOT strip the dep edge. |
| `src/lib/pipeline.ts:380` | `reject` — rejects a task, calls `flagDependents`, distils the rejection to project context. |
| `src/lib/pipeline.ts:481` | `reevaluateSubtree` — orchestrates the model call; persists per-dependent verdicts + revision blobs. |
| `src/lib/pipeline.ts:531` | `reevalApply` — sole writer of revised canonical fields (keep/park/kill/revise branches). |
| `src/lib/pipeline.ts:571` | `reevalDismiss` — clears the verdict stamp without applying. |
| `src/lib/pipeline.ts:590` | `enrichPushed` — krill status sync; gate-completion detection loop at `:636-656` auto-flips `reeval_status` on observed DONE/CANCELED. |
| `src/lib/pipeline.ts` | `unresolvedGates` — the push guard: a gate blocks while the verdict is pending or its id is not in `reeval_resolved`; fails open when the upstream is not a proposal. |
| `src/lib/pipeline.ts` | `withGateState` — attaches `gated_by` to each row (re-read from the DB) so the UI reads the guard instead of re-deriving it. |
| `src/app/api/proposed/route.ts` | Attaches `gated_by` on both the `?sync=1` and plain list paths. |
| `src/lib/pipeline.ts` | `heldByAnotherGate` — the anti-clobber rule: a real verdict from a different gate is skipped, a bare `pending` flag is not. |
| `src/lib/krill-client.ts` | `getTaskOutcome` — assembles a gate outcome from `diff_text` + stage comments and reports which it used; `null` (→ operator paste) when neither exists. `getTaskResult` is its text-only view. |
| `src/components/whale/gate-outcome-dialog.tsx` | `GateOutcomeDialog` — the outcome at readable size, its provenance, who gets judged, and the overlap opt-in. |
| `src/components/whale/whale-app.tsx` | `gateHasOutcome` (one readiness rule for the gate row and every band), `ReevalBand` (the live action per flag state), `GatesEditor` (edges, types, premise), the lens bar. Reads `gated_by`; owns no gate rule of its own. |
| `src/db/schema.ts:62` | `dep_types`, `premise`, `reeval_status`, `reeval_note`, `reeval_source`, `reeval_revision`, `reeval_resolved` columns. |
| `tests/smoke.test.ts:447` | Round-trip test: typed dep edges + premise/reeval columns. |
| `tests/smoke.test.ts:514` | Gate-edge push deferral + DONE-gate flip test (WH-17). |

## Testing it

`npm test` covers the round-trip: `smoke.test.ts:447` verifies the schema
columns and dep_types/premise/reeval_status round-trip through
`addProposed`/`getProposed`; `smoke.test.ts:514` covers the gate-edge push
deferral and the DONE-gate `reeval_status` flip in `enrichPushed`. For the live
path: reject a proposal → its dependents immediately show pending badges in the
Proposed tab; complete a gate task in krill → refresh Proposed → dependents show
pending, then click Reevaluate to run the model and get per-task verdicts.
