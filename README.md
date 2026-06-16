# 🐋 whale

The strategy brain on top of [krill](../krill). You dump **work requests** per
project; whale plans them with the [ai-team](../ai-team) personas — grounded in
each project's living **context** (built by onboarding) — triages what needs your
review vs. what bypasses, and drives krill to execute.

> Krill feeds the whale. Krill runs tasks → PRs; whale decides which tasks
> exist, why, and who reviews them.

See **[PLAN.md](PLAN.md)** for the full architecture.

## Boundary

```
ai-team/  (personas, read-only)  ──▶  whale  ──HTTP──▶  krill (execution)
```

One-way: whale reads the personas, never writes them; talks to krill over its
HTTP API, never its DB.

## Run

```bash
cp .env.example .env      # optional — set runner, dials, ports (gitignored)
npm start                 # http://localhost:4100  (LAN URL printed for phone)
```

`.env` is loaded natively (Node 22, no deps). All knobs documented in
[.env.example](.env.example).

Tabs: **Inbox** (dump anything) · **Context** (living CONTEXT.md per project) ·
**Proposed** (review queue — approve / reject / push).

Flow: **Onboard** a project (Context) → **Dump** requests (Inbox) → **Plan** →
review in **Proposed** → **Approve** → **Push to krill**.

## Pipeline

```
onboard ─▶ CONTEXT.md (per project, background)    dump ─▶ work requests (pending)
                               │                              │
            PLANNER (Augusto + Maria): context + requests ─▶ proposed tasks
                               │
            TRIAGE (ai-team risk rubric) ─▶ 🟢 bypass / 🟡🔴 review
                               │
            krill POST /api/tasks (skip_plan_review = bypass)
```

Triage is **deterministic** — it reads the safe-words + risk tiers straight from
`AGENTS.md`, so "payment + migration" → 🔴 review and "fix typo" → 🟢 bypass with
no LLM needed.

Beyond the core flow, the pipeline also does:
- **Onboarding (B5)** — audit a code project read-only (`POST /api/onboard`) or
  seed an idea project by hand → its living CONTEXT.md. Awareness, not autonomy.
- **Batch handoff (B2)** — push a project's approved tasks in dependency order,
  wiring krill `depends_on` from the sibling name→id map.
- **Refine loop (B3)** — Approve / Decline / **Input**; Input re-evaluates one task
  (Maria) and re-triages, repeatable until you approve.
- **Flow preview** — each proposed task shows where it stops in krill (🔴 full
  review · 🟡 skips plan review · 🟢 auto-finish → DONE).
- **Arm-time double-confirm (B4)** — pushing a batch that will auto-finish requires
  an explicit second confirm.

## Going real

The repo default runner is `stub` (deterministic — the whole spine runs offline).
The fleet runs **real** via `.env` (`WHALE_RUNNER=real`); flip it yourself with:

```bash
WHALE_RUNNER=real npm start            # requires the `claude` CLI installed + authed
```

whale mirrors krill: it spawns the **Claude Code CLI** (`claude`) on your existing
Claude Code auth — **no API key, no separate billing**. Planner / router / audit /
refine then run real Claude (Haiku for route, Sonnet for plan/refine/audit);
triage stays deterministic. Set `CLAUDE_BIN` if `claude` isn't on PATH.

### Autonomy ladder (B1)

The `WHALE_BYPASS` dial sets how far a task runs before it reaches you:

| Dial | low risk | medium | high | self-edit |
|---|---|---|---|---|
| `conservative` (default) | review | review | review | review |
| `balanced` | skip plan review | review | review | review |
| `aggressive` | **auto-finish** | skip plan review | review | review |
| `autonomous` | **auto-finish** | **auto-finish** | review | review |
| `ludicrous` | **auto-finish** | **auto-finish** | **auto-finish** | review |

- **auto-finish** sets krill `auto_publish`; krill only honors it when the project
  also has `allow_auto_finish=true` (double-gated, AI review stays on). Ludicrous
  auto-finishes **every tier** — including high-risk (migrations/auth/deploy) — so
  it's the reckless setting; only the self-edit guard still stops it.
- **Warn, don't arm**: pushing auto-finish tasks to a project whose krill
  `allow_auto_finish` is OFF surfaces a warning (whale never patches krill).
- **Self-edit guard** (`WHALE_PROTECTED`, default `whale,krill`): tasks targeting the
  orchestrator itself are **always 🔴, never bypass/auto**, any dial.

Other dials (env): `WHALE_AUTOPUSH=1` (auto-push approved), `WHALE_ALLOW_NEW_PROJECTS=1`
(propose new projects — creation stays human-gated), `WHALE_PLAN_FILE_ACCESS=1`
(planner reads the project repo, for file-referencing dumps), `WHALE_NO_MCP=1`
(load zero MCP servers if one misbehaves), `KRILL_URL`, `PERSONAS_DIR`.

### Other capabilities

- **Pre-send review** — Push to krill (single / dump-group / project batch) opens a
  modal to review + override each task's settings, and warns before sending.
- **Proposed grouping** — proposals group by source dump in execution order, with
  short handles, `← depends on` / `→ unblocks` refs, and `TEMP-` ids (→ krill id on push).
- **Blocker queue** — if planning hits something interactive it can't answer headless
  (MCP auth, CLI login) it pauses and files a blocker; clear it to resume the plan.
- **Plan failures** surface on the dump (no more silent `raw`).

### Editing config at runtime

The **Settings** tab (`GET`/`PATCH /api/config`) makes the runtime dials —
`runner`, the model tiers, `bypass`, `autoPush`, `allowNewProjects` — editable
**live, no restart**. Precedence: **DB override wins over env**; env is the
bootstrap default. The self-edit guard (`WHALE_PROTECTED`) and infra wiring (ports,
paths, `KRILL_URL`) stay **env-only** and are read-only in the UI — a no-auth LAN UI
must not be able to weaken the guard. See [docs/config-ui-overrides.md](docs/config-ui-overrides.md).

## Status

All phases shipped and tested (10/10 smoke). The autonomy + execution work
(A1–A3 in krill, B0–B5 in whale) is tracked in
[`../bridge/CLOSING-THE-CYCLE.md`](../bridge/CLOSING-THE-CYCLE.md) — the source of
truth for what's built. `node:sqlite` is experimental (Node 22) — pin or swap if it
churns.
