# Config: env → UI-overridable settings (recommendation)

**Session 06 deliverable — design only, no code shipped.** Question: which whale
config should become UI-overridable at runtime, and how, mirroring krill's
existing `global_config` + `/settings` pattern.

## Problem

`src/config.mjs` builds one frozen object at module load, reading `process.env`
once. Changing any dial needs an `.env` edit **+ a restart**. krill already solved
this: a `global_config` singleton row + `GET/PATCH /api/config` read live per
request (no restart) + `broadcast()` for SSE. Mirror that for whale's runtime dials.

## Classification of every whale setting

### → UI-overridable (runtime tunable, no restart)
Behavior you'd flip per-session as trust grows:

| Setting | env today | Why runtime |
|---|---|---|
| `runner` | `WHALE_RUNNER` | flip stub↔real without bouncing the server |
| `models.plan` | `WHALE_MODEL_PLAN` | tier tuning is iterative |
| `models.route` | `WHALE_MODEL_ROUTE` | " |
| `autonomy.bypass` | `WHALE_BYPASS` | the core dial — loosen as override rate drops |
| `autonomy.autoPush` | `WHALE_AUTOPUSH` | toggle staged vs auto-push |
| `autonomy.allowNewProjects` | `WHALE_ALLOW_NEW_PROJECTS` | propose-new on/off (creation still gated) |

### → Keep in env (boot / infra, set once)
Wiring, not behavior. A restart to change these is correct:

`WHALE_PORT`, `WHALE_DB`, `WHALE_CONTEXT_DIR`, `PERSONAS_DIR`, `KRILL_URL`,
`CLAUDE_BIN`, `WHALE_CLAUDE_TIMEOUT`.

### → Safety-critical: **env-only floor, NOT UI-editable**
`WHALE_PROTECTED` (the self-edit guard list, default `whale,krill`).

**Recommendation: keep env-only and never expose it to PATCH.** This is the brake
that stops whale/krill from auto-finishing edits to themselves. The UI is **no-auth
on the LAN** — anyone who can reach `:4100` could otherwise shrink the protected
list and unlock self-edit auto-finish. Concretely:
- `getConfig().autonomy.protected` always reads `process.env.WHALE_PROTECTED`,
  never the DB layer.
- Enforce a **hard floor**: `whale` and `krill` are always in the set even if env
  omits them (union, not replace).
- The settings tab shows it **read-only** ("env-locked — self-edit guard").
- The `aggressive` dial stays UI-editable (it's the point), because auto-finish is
  already **double-gated** elsewhere (krill `allow_auto_finish` + whale arm-time
  double-confirm). The protected floor is the thing that must not move from the UI.

## Precedence model

**DB/UI override wins; env is the bootstrap seed + last-resort default.**

- First boot: seed the config row from current `process.env` values (krill's
  `readOrInit`, but seeded from env defaults instead of hardcoded).
- After that: PATCH writes win and persist; env is ignored for tunables until reset.
- `.env` stays the override-of-last-resort via a **"reset to env defaults"** action
  (clears the row → reseeds from env on next read).
- **Exception:** the safety floor (`protected`) never enters the DB layer — env
  always wins for it. This is the one place env beats UI, by design.

Justification: matches krill (one mental model), gives runtime tunability, keeps
`.env` as documented defaults + bootstrap, and structurally prevents the UI from
weakening the guard.

## Implementation shape (for the follow-up build session)

1. **whale.db** — a `config` singleton table (id=1), mirroring krill's
   `global_config`. Columns for the tunables only: `runner`,
   `model_plan`, `model_route`, `bypass`, `auto_push` (int bool),
   `allow_new_projects` (int bool). **No `protected` column.**
2. **`config.mjs` refactor — read live, not frozen.** Replace the module-level
   `export const config = {...}` with a live source: either `getConfig()` that
   merges `defaults ← env ← db row` on each call, or a getter-backed object so the
   existing `config.X` call sites keep working. Either is fine because **every
   consumer already reads `config.X` at call-time** (verified — see below), so no
   call-site rewrite is needed beyond swapping the export. `isReal()` →
   `getConfig().runner === "real"`. `autonomy.protected` getter reads env+floor only.
3. **`server.mjs`** — `GET /api/config` (returns merged values + an `envLocked`
   list so the UI can render protected read-only) and `PATCH /api/config` (validate
   against an allow-list of the 7 tunables; reject any attempt to set `protected`;
   write the row; respond — no restart).
4. **`ui.mjs`** — a Settings tab: `runner` + 3 model selects, `bypass` select,
   `autoPush` + `allowNewProjects` switches; `protected` shown read-only with the
   "env-locked" note.

**Consumers that read config live today (no rewrite needed):**
`stages.mjs` (models.*, autonomy.bypass default, autonomy.protected, isReal),
`pipeline.mjs` (autonomy.autoPush, models.plan), `krill-client.mjs` (krill.baseUrl —
infra, can stay static), `server.mjs` (startup log + health only).

## Risks

- **Dial change mid-run:** triage/auto_publish are decided at plan/push time and
  stored per-task; changing `bypass` later only affects *future* triage. Acceptable
  — document it. In-flight tasks are unaffected.
- **No-auth LAN UI on safety dials:** worst case reachable from the UI alone is
  `bypass=aggressive` — but self-edits stay protected (env floor) and auto-finish
  still needs krill's `allow_auto_finish` (off by default) + the arm-time confirm.
  Net new risk is bounded; the guard does not move.
- **runner stub↔real flip at runtime:** fine (each stage checks `isReal()` live);
  a flip mid-run just applies to the next stage call.
- **`.env` drift vs DB:** once the DB row exists, `.env` edits to tunables look
  ignored (confusing). Mitigate with the "reset to env" action + a UI note that DB
  overrides env for tunables.

## Done / not done
- ✅ migrate-list, keep-list, safety-gated-list, precedence, implementation shape,
  consumer audit, risks.
- ✅ self-edit guard stays protected: `protected` is env-only with a hard
  `whale,krill` floor, never PATCHable, read-only in the UI.
- ⛔ No code or schema changed this session (eval only). This doc is the spec for a
  follow-up build session.
