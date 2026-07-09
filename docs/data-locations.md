# Where tasks & data live (whale + krill)

When asked about "tasks" or "proposed tasks", query the SQLite DBs directly. No API round-trip needed.

## whale — `data/whale.db`

| Table | What |
|---|---|
| `proposed_tasks` | The backlog whale proposes. Key cols: `project_key`, `name`, `description`, `priority` (P0–P3), `risk_tier` (low/medium/high), `status` (proposed/approved/rejected/pushed/push_failed), `bypass`, `deps` (JSON array of task **names**), `mode`, `krill_task_id`. |
| `inbox_entries` | **Store dumps** — raw captures the user drops in. Cols: `text`, `source`, `project_hint`, `status` (raw/distilled), `lane` (task/context/new_project/ask). |
| `blockers` | — |
| `config` | UI/config overrides. |

Approved/pushed tasks get an `krill_task_id` and flow into krill.

Not everything is SQLite:

- **`data/context/*.md`** — one living CONTEXT.md per project (+ `global`),
  written by onboarding/manual saves. Two H2 sections are **distilled ledgers**
  maintained by whale itself: `## Decisions` (one bullet per proposed task per
  plan run) and `## Standing principles` (refine/reject WHY capture). Writes are
  merge-aware — these sections survive a re-onboard or manual save (see
  `PRESERVED_SECTIONS` in `src/lib/context-store.ts`). `*.meta.json` sidecars
  hold the audited git HEAD (staleness check).
- **`data/usage.jsonl`** — append-only LLM metering: one row per real `claude`
  call (`at`, `model`, `purpose`, token counts, `total_cost_usd`, `session_id`).
  Read via `GET /api/usage` (last 200 rows) or `tail`/`jq` directly.

## krill — `krill/data/tasks.db`

Active DB is `data/tasks.db` (set by `DB_PATH` in `krill/.env.local`; `dev.db` is empty, ignore it).

| Table | What |
|---|---|
| `tasks` | Executable tasks krill runs. |
| `projects` | Per-project config. |
| `blockers`, `comments`, `followups`, `global_config` | supporting. |

## Quick queries

```bash
# whale proposed tasks for a project
sqlite3 -header -column data/whale.db \
  "SELECT id,name,priority,risk_tier,status FROM proposed_tasks WHERE project_key='my-project';"

# whale store dumps not yet distilled
sqlite3 -header -column data/whale.db \
  "SELECT id,text,lane FROM inbox_entries WHERE status='raw';"

# krill tasks / projects
sqlite3 -header -column ../krill/data/tasks.db "SELECT id,name,status FROM tasks;"
sqlite3 -header -column ../krill/data/tasks.db "SELECT * FROM projects;"
```
