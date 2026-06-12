# 🐋 baleia

The strategy brain on top of [krill](../ai-auto-worflow). You dump anything;
baleia captures it, distills it into living context, plans work with the
[ai-team](../ai-team) personas, triages what needs your review vs. what
bypasses, and drives krill to execute.

> Krill feeds the whale. Krill runs tasks → PRs; baleia decides which tasks
> exist, why, and who reviews them.

See **[PLAN.md](PLAN.md)** for the full architecture.

## Boundary

```
ai-team/  (personas, read-only)  ──▶  baleia  ──HTTP──▶  krill (execution)
```

One-way: baleia reads the personas, never writes them; talks to krill over its
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

Flow: dump → `Distill all` → open a project in Context → `Plan this` →
review in Proposed → `Approve` → `Push to krill`.

## Pipeline

```
dump ─▶ inbox ─▶ DISTILLER ─▶ CONTEXT.md (per project)
                                   │
                     PLANNER (Augusto + Maria) ─▶ proposed tasks
                                   │
                     TRIAGE (ai-team risk rubric) ─▶ 🟢 bypass / 🟡🔴 review
                                   │
                     krill POST /api/tasks (skip_plan_review = bypass)
ROUTER: a raw dump ─▶ task | new_project (gated) | context | ask
```

Triage is **deterministic** — it reads the safe-words + risk tiers straight from
`AGENTS.md`, so "payment + migration" → 🔴 review and "fix typo" → 🟢 bypass with
no LLM needed.

## Going real

Default runner is `stub` (deterministic — the whole spine runs offline).
Flip to persona-driven Claude. baleia mirrors krill: it spawns the **Claude Code
CLI** (`claude`), using your existing Claude Code auth — **no API key, no
separate billing**.

```bash
BALEIA_RUNNER=real npm start            # requires the `claude` CLI installed + authed
```

Distiller/planner/router then run real Claude (Haiku/Sonnet); triage stays
deterministic. Set `CLAUDE_BIN` if `claude` isn't on PATH.

Dials (env): `BALEIA_BYPASS=conservative|balanced|aggressive`,
`BALEIA_AUTOPUSH=1`, `BALEIA_ALLOW_NEW_PROJECTS=1`, `KRILL_URL`, `PERSONAS_DIR`.

## Status — all phases (stub-runnable)

- [x] Phase 0 — persona-loader (sync foundation)
- [x] Phase 1 — capture inbox + distiller + planner
- [x] Phase 2 — triage (risk → krill skip flags) + krill HTTP push
- [x] Phase 3 — request router (task / new_project / context / ask)
- [x] Phase 4 — gates (new-project always human) + autonomy dials

### Hardening left (real-mode)

- Verify krill `POST /api/tasks` accepts `skip_*` + `priority` on create (else PATCH after).
- Real planner/distiller quality pass once a key is wired (stub is heuristic).
- `node:sqlite` is experimental (Node 22) — pin or swap if it churns.
