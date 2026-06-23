# Cron & job durability — exploration (deferred)

Placeholder for two separate ideas. Neither is built; this is a thinking doc.

## 1. Cadenced surfacing (the interesting one)

Today **Plan** is a manual, per-project click and the whole batch of proposed tasks
lands at once. A cron/scheduler could make the fleet feel like a **steady digest**
instead of a manual pull:

- **Auto-plan accumulated requests.** On a per-project cadence (e.g. daily), plan the
  project's pending requests → proposed, so you get a regular "here's what I'd
  propose" digest rather than remembering to Plan.
- **Paced proposed surfacing.** Rather than revealing every proposed task at once,
  release them at a digestible rate per project (e.g. N/day) so the review queue
  never floods. The rest stay queued/hidden until their turn.
- **Dump triage cadence.** Periodically sweep the `(unassigned)` scratchpad and
  suggest a project (the old router idea, but on a cadence + as a suggestion, not
  auto-filing).

Open questions:
- Per-project cadence config (off by default; opt-in). Where it lives (the `config`
  table / a per-project setting in krill?).
- **Cost control** — auto-planning spends real Claude. Needs an explicit per-project
  opt-in + maybe a cap, so a cron never burns tokens by surprise.
- Interaction with the autonomy dial: does a cadenced auto-plan also auto-push
  (aggressive), or always stop at Proposed for review?
- "Digest" delivery — just the Proposed tab filling on a cadence, or a summary
  (count + highlights) somewhere.

This is the one worth prototyping if whale starts running always-on.

## 2. Job durability (deferred — context from the async-jobs work)

Current state: **in-memory job registry** (`lib/jobs.ts`) — long ops (audit/plan)
run fire-and-forget, survive a **client reload**, but a **server restart** cancels
in-flight jobs (the child `claude` dies with the parent).

Two tiers if we ever want more:

- **Tier 2 — durable log + manual re-run (low complexity).** Persist job records to
  the DB (`running|done|error`). On boot, mark orphaned `running` jobs as
  `interrupted` and show them in the UI with a **Re-run** button. Survives restart +
  shows what was interrupted, no worker.
- **Tier 3 — krill-style auto-resume (high complexity).** `jobs` table + a cron
  worker (start in `instrumentation.ts`) with atomic **claim + TTL**: enqueue →
  worker claims → runs → done/error; jobs stuck `running` past their TTL get
  reclaimed on restart → **re-run** (resume = re-run, since `claude --print` can't
  continue). Catches: plan idempotency (don't double-propose on re-run), an
  attempts cap, and a concurrency cap on `claude` spawns.

Decision rule: **single-user + manual restarts → tier 2 or nothing. Always-on
service → tier 3.** Audit/plan are single-shot LLM calls, so "resume" always means
"re-run from scratch" — weigh the real-Claude cost of auto-re-running on every boot.
