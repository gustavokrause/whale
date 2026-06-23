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
  "SELECT id,name,priority,risk_tier,status FROM proposed_tasks WHERE project_key='arqtrack';"

# whale store dumps not yet distilled
sqlite3 -header -column data/whale.db \
  "SELECT id,text,lane FROM inbox_entries WHERE status='raw';"

# krill tasks / projects
sqlite3 -header -column ../krill/data/tasks.db "SELECT id,name,status FROM tasks;"
sqlite3 -header -column ../krill/data/tasks.db "SELECT * FROM projects;"
```
