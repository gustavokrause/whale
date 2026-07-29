# Dependency gates and the re-evaluation loop

How whale's two edge types encode intent, and why the re-evaluation loop exists
to surface the consequences of a gate result — not to apply them automatically.

> TL;DR: A gate edge says "this task only exists if the upstream returns GO."
> When a gate resolves, whale flags dependents with a per-task verdict
> (`keep / revise / park / kill`) and stops — a human applies the verdict.
> Nothing is auto-applied; the loop's job is to surface the fork, not decide it.

## Why this exists

whale's idea-project plan began with an interview-driven track: landing page →
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
```

Trigger 1 (automatic): `enrichPushed` is called on every Proposed tab load
(`GET /api/proposed`). It reads back live krill statuses for pushed tasks and,
as a side-effect, flips the `reeval_status` of every gate-dependent whose gate
just landed DONE or CANCELED (`pipeline.ts:636-656`). No operator action needed
to get the badge; it appears on next page load.

Trigger 2 (manual): `POST /api/proposed/:gateId/reevaluate` runs
`reevaluateSubtree` (`pipeline.ts:481-528`). This is what actually calls the
model and writes the per-dependent verdict. The operator can also paste the gate
result directly in the body (`opts.result`) when krill's result field is blank.

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

This was the fix for the idea-project case (commit `e80824c`, WH-20): reject no
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
| `POST /api/proposed/:gateId/reevaluate` | Run the model against the gate result + dependents' premises; write per-dependent verdicts. Body: `{result?: string}` to override krill's result field. |
| `POST /api/proposed/:depId/reeval-apply` | Apply the pending verdict. Sole writer of revised canonical fields. |
| `POST /api/proposed/:depId/reeval-dismiss` | Clear the pending verdict stamp without applying. |

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
| `src/db/schema.ts:62` | `dep_types`, `premise`, `reeval_status`, `reeval_note`, `reeval_source`, `reeval_revision` columns. |
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
