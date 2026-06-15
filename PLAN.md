# whale — build plan

> The strategy brain on top of krill. You dump anything; whale captures it,
> distills it into living context, plans work with the AI team, triages what
> needs your eyes vs. what bypasses, and drives krill to execute.
>
> Krill feeds the whale: krill runs tasks → PRs; **whale** decides which tasks
> exist, why, and who reviews them.

Status: **planning**. Source personas live in `ai-team/` (separate repo,
read-only to whale). Execution engine is `krill` (separate repo, unchanged).

---

## 1. Problem

Today krill is "give me a repo/folder → create task → here's a PR." That forces
the human to (a) hold all project context in their head, (b) hand-write every
task, (c) set every review/bypass flag. The user wants high-level interaction
only: dump information, set direction, approve the few things that matter —
across many projects (krill itself, meu veleiro, saas factory, arqtrack, …),
fully operational and as automated as safely possible.

## 2. Goal

A capture-once, route-everywhere strategy layer that:

- takes any input (a thought, a chat snippet, a request) into one inbox;
- maintains living context per project so the team plans from real ground;
- proposes backlog the user reviews, and **wisely** assigns each task to human
  review or autonomous bypass based on risk;
- can spin up work in existing projects, or propose new projects;
- keeps the user at high-level: dump, approve a batch, decide the high-risk few.

## 3. Two systems, one-way boundary

```
ai-team/ (SOURCE OF TRUTH)            whale + krill (WHERE WORK HAPPENS)
──────────────────────────           ───────────────────────────────────
WHO thinks & HOW they decide   ──▶    capture → distill → plan → triage → execute
- AGENTS.md (routing, risk            whale READS personas; never writes them.
  rubric, handoff, economy)           Personas never know krill/whale exist.
- ai/professionals/*/
  context.md + rules.md
```

- `ai-team` stays **personas-only**. whale depends on it; it does not depend on whale.
- whale depends on `krill` only through krill's **HTTP API** (Section 6).
- Dependency direction is strictly: `ai-team ← whale → krill`. No cycles.

## 4. The sync layer — `persona-loader` (core of the design)

A single module in whale, pointed at the personas repo via config:

```
PERSONAS_DIR=/Users/gustavokrause/code/ai-team
```

It parses that folder into three artifacts whale consumes at runtime:

1. **Routing rules** ← `AGENTS.md` — manual / auto-route / handoff / routing-economy.
2. **Risk rubric** ← `AGENTS.md` — 🟢 low / 🟡 medium / 🔴 high + safe-words.
   This drives triage (Section 7).
3. **Persona registry** ← `ai/professionals/*/context.md` (+ `rules.md`) —
   one system prompt per persona, keyed by name/area.

Rules:

- **Live-read each run** (single-user, cheap). Optional: pin a commit hash for
  reproducibility later.
- **One-way, read-only.** whale never writes back to `ai-team`.
- **No copy, no submodule, no MCP** for the personas. Add an MCP wrapper only if
  a second consumer ever needs the team (YAGNI until then).
- Editing a persona in `ai-team` changes whale's behavior on the next run.
  That is the entire sync mechanism.

## 5. whale components

```
you dump anything ─▶ CAPTURE INBOX (global, append-only, zero friction)
        │
        ├─▶ DISTILLER ─▶ CONTEXT.md per project (+ a global living file)
        │                 (goals, constraints, decisions, open questions)
        │
request "do X" ─▶ ROUTER (uses routing rules) ─┬─▶ task → existing project (proposed)
                                               ├─▶ new project → 🔴 approve before scaffold
                                               ├─▶ pure context → back to inbox
                                               └─▶ ambiguous → ask one question
        │
   PLANNER (personas + CONTEXT.md + project state) ─▶ proposed backlog ─▶ you approve/cull
        │
   TRIAGE (risk rubric) ─▶ sets krill priority + skip flags
        │
   krill (unchanged) ─▶ BACKLOG → TODO → … → PR → DONE
```

- **Capture inbox**: one place, any input. Append-only file/store; never lose raw input.
- **Distiller**: one LLM step; raw inbox entries → structured living `CONTEXT.md`
  per project. No vector DB / RAG — markdown fits a single-user context window.
  Add retrieval only when a living file actually outgrows the window.
- **Router**: classifies a request to a destination. Multi-project aware (reads
  krill's project registry).
- **Planner**: proposes tasks from distilled context + current project state.
- **Triage**: maps risk tier → krill fields (Section 7).

User touch points (the only ones): **dump**, **approve a proposed batch**,
**decide the 🔴 items**, **set direction**.

## 6. krill integration — write surface (confirmed)

whale writes to krill over **HTTP** (krill binds `0.0.0.0:3000`, LAN, no auth):

- `POST /api/projects` — register a new project (gated; Section 8).
- `POST /api/tasks` — create a task in `BACKLOG`.
- `PATCH /api/tasks/[id]` — set `priority`, `skip_plan`, `skip_plan_review`,
  `skip_ai_review`, `depends_on`.
- `POST /api/tasks/[id]/transition` — promote `BACKLOG → TODO` when whale
  decides it's ready for the autonomous pick.
- Read state for the Planner via `GET /api/tasks`, `GET /api/projects`.

Do **not** touch krill's SQLite directly (couples to migrations) and do **not**
hijack krill's MCP server (that's krill↔its-own-Claude). whale is just another
HTTP client.

**Build-time check:** confirm `POST /api/tasks` accepts `skip_*` + `priority`
on create; if not, create then `PATCH`.

## 7. The triage bridge (risk rubric → krill flags)

This is how "wisely assigned to me or bypassed" becomes mechanical. The
`AGENTS.md` risk tiers map directly onto krill's existing flags:

| Risk (from AGENTS.md) | Examples | krill effect |
| --- | --- | --- |
| 🟢 Low | mechanical, reversible, in an existing project | `skip_plan_review=true` → bypasses human |
| 🟡 Medium | feature/scope change | normal plan + human review at `NEEDS_REVIEW(plan)` |
| 🔴 High / safe-word | pricing, legal, schema/irreversible, architecture, **new project** | force `NEEDS_REVIEW`, assigned to you |

Start **conservative** (bypass only the truly trivial); loosen as the override
rate falls (Section 9).

## 8. Guardrails (non-negotiable)

- **One-way sync** — whale can't corrupt the persona strategy.
- **New-project / scaffold creation is always 🔴-gated** — most irreversible action.
- Respect krill's **kill switch** (`automation_enabled`) and `max_parallel_tasks`.
- whale proposes; **krill still stages** (plan → review → implement → AI review →
  publish). whale never bypasses krill's own safety, only sets its review flags.

## 9. Eval — override rate

The single metric that governs autonomy: **how often the user overrides whale's
triage/plan.**

- Rarely overriding → widen bypass (more 🟢, more autonomy).
- Often overriding → context is too thin or triage too loose; tighten and fix the
  distiller before adding lanes.

## 10. Phased build

- **Phase 0 — Sync foundation.** `persona-loader`: read `ai-team/` → routing +
  risk rubric + persona registry. Prove whale can assume any persona and apply
  the rubric. Smallest; unblocks everything.
- **Phase 1 — Thin slice (one project).** Capture inbox + distiller + `CONTEXT.md`
  + Planner → proposed → human approve → write to krill `BACKLOG`. Measure
  override rate over ~2 weeks.
- **Phase 2 — Triage automation.** Risk → skip flags + priority; multi-project.
- **Phase 3 — Request router.** Route a raw dump across all projects.
- **Phase 4 — New-project generation (gated) + autonomy dials.** The
  "fully operational" end state.

Future goals come for free: loader + inbox + CONTEXT model are generic, so new
projects, new personas, and more automation are **config, not rework.**

## 11. Decisions (resolved)

- **Capture inbox**: one **global** inbox (capture-once, route-everywhere),
  backed by a small SQLite table; minimal LAN web box (textarea + recent list,
  phone-friendly like krill). Optional project hint at capture; else the Router
  decides. No mandatory tagging at capture.
- **Distiller cadence**: **lazy, never cron** — on-demand before a Planner run,
  plus a debounced auto-distill after new dumps settle. No idle-token burn.
- **whale runtime**: **separate process** beside krill (own port), talks to
  krill over HTTP, reads `ai-team`. Keeps krill's surface minimal; independent
  lifecycle. Wrap both in one launcher later if desired.
- **Stack**: Node/TS (matches krill, one skillset).
- **CONTEXT.md ownership**: lives **inside whale**, keyed by `project_id`
  (global living file + per-project). whale owns its memory; user project repos
  stay clean.

### Still to pin at Phase 1 (not blocking Phase 0)

- Model tiering: Haiku (distill) / Sonnet (plan) / Opus (🔴 triage).
- Debounce window + exact distill trigger.

## 12. Personas involved (per ai-team routing)

- **Caio (AI/Orchestration)** — architecture, this plan, pattern calls.
- **Augusto (Strategy)** — scope discipline, build sequence, worth-it gates.
- **Rafael (Backend)** — krill write surface, whale ↔ krill integration, schema of `CONTEXT.md`.
- Pulled as needed: **Fernanda (Finance)** for cost/ROI of autonomy, **Patrícia (Legal)** if a 🔴 item carries legal exposure.
