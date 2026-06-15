// whale — storage (node:sqlite, zero deps)
//
// inbox_entries  : the global capture stream (Phase 1)
// proposed_tasks : planner output awaiting human review / push to krill (Phase 1-2)

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export function openDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_entries (
      id           TEXT PRIMARY KEY,
      text         TEXT NOT NULL,
      source       TEXT NOT NULL DEFAULT 'manual',
      project_hint TEXT,
      status       TEXT NOT NULL DEFAULT 'raw',   -- raw | distilled
      lane         TEXT,                          -- router decision: task | context | new_project | ask
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inbox_created_idx ON inbox_entries(created_at);

    CREATE TABLE IF NOT EXISTS proposed_tasks (
      id            TEXT PRIMARY KEY,
      project_key   TEXT NOT NULL,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      priority      TEXT NOT NULL DEFAULT 'P2',    -- P0..P3
      mode          TEXT NOT NULL DEFAULT 'non-dev',
      risk_tier     TEXT,                          -- low | medium | high
      rationale     TEXT NOT NULL DEFAULT '',
      bypass        INTEGER NOT NULL DEFAULT 0,    -- 1 => skip_plan_review in krill
      auto_publish  INTEGER NOT NULL DEFAULT 0,    -- 1 => krill auto_publish (auto-finish; A2)
      deps          TEXT NOT NULL DEFAULT '[]',    -- JSON: names of sibling tasks this depends on (B2)
      status        TEXT NOT NULL DEFAULT 'proposed', -- proposed|approved|rejected|pushed|push_failed
      krill_task_id TEXT,
      push_error    TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS proposed_status_idx ON proposed_tasks(status);

    -- Runtime config overrides (singleton). NULL column = fall back to env/default.
    -- Only UI-tunable settings live here; the self-edit guard (WHALE_PROTECTED)
    -- and infra wiring stay env-only by design — see docs/config-ui-overrides.md.
    CREATE TABLE IF NOT EXISTS config (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      runner             TEXT,
      model_distill      TEXT,
      model_plan         TEXT,
      model_route        TEXT,
      bypass             TEXT,
      auto_push          INTEGER,
      allow_new_projects INTEGER
    );
  `);
  // idempotent migrations for pre-existing databases
  try { db.exec(`ALTER TABLE proposed_tasks ADD COLUMN auto_publish INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE proposed_tasks ADD COLUMN deps TEXT NOT NULL DEFAULT '[]'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE proposed_tasks ADD COLUMN refine_log TEXT NOT NULL DEFAULT '[]'`); } catch { /* exists */ }
  return db;
}

/* ---- runtime config (UI-overridable subset; see config.mjs) ---- */

// Columns the UI may write. NOT including the self-edit guard — that stays env-only.
export const CONFIG_FIELDS = [
  "runner", "model_distill", "model_plan", "model_route",
  "bypass", "auto_push", "allow_new_projects",
];

/** The singleton override row (or {} if never set). NULL fields = not overridden. */
export const readConfig = (db) =>
  db.prepare(`SELECT * FROM config WHERE id = 1`).get() || {};

/** Upsert the singleton, writing only the given (whitelisted) fields. */
export function writeConfig(db, fields) {
  db.prepare(`INSERT OR IGNORE INTO config (id) VALUES (1)`).run();
  const keys = CONFIG_FIELDS.filter((k) => k in fields);
  if (keys.length) {
    const set = keys.map((k) => `${k} = ?`).join(", ");
    db.prepare(`UPDATE config SET ${set} WHERE id = 1`).run(...keys.map((k) => fields[k]));
  }
  return readConfig(db);
}

/* ---- inbox ---- */

export function addEntry(db, { text, projectHint = null, source = "manual" }) {
  const trimmed = (text || "").trim();
  if (!trimmed) throw new Error("empty entry");
  const id = randomUUID();
  db.prepare(
    `INSERT INTO inbox_entries (id, text, source, project_hint, status, created_at)
     VALUES (?, ?, ?, ?, 'raw', ?)`
  ).run(id, trimmed, source, projectHint, Date.now());
  return getEntry(db, id);
}
export const getEntry = (db, id) =>
  db.prepare(`SELECT * FROM inbox_entries WHERE id = ?`).get(id);
export const listEntries = (db, limit = 50) =>
  db.prepare(`SELECT * FROM inbox_entries ORDER BY created_at DESC LIMIT ?`).all(limit);
export const rawEntries = (db) =>
  db.prepare(`SELECT * FROM inbox_entries WHERE status = 'raw' ORDER BY created_at`).all();
export function markEntries(db, ids, status) {
  const stmt = db.prepare(`UPDATE inbox_entries SET status = ? WHERE id = ?`);
  for (const id of ids) stmt.run(status, id);
}
/** Persist the router's decision: set the lane, and fill project_hint if empty. */
export function setEntryLane(db, id, { lane, projectHint = null }) {
  db.prepare(
    `UPDATE inbox_entries
       SET lane = ?, project_hint = COALESCE(NULLIF(TRIM(project_hint),''), ?)
     WHERE id = ?`
  ).run(lane, projectHint, id);
  return getEntry(db, id);
}
/** distinct project keys seen in the inbox (null hint => 'global') */
export const projectKeys = (db) =>
  db
    .prepare(`SELECT DISTINCT COALESCE(NULLIF(TRIM(project_hint),''),'global') k FROM inbox_entries`)
    .all()
    .map((r) => r.k);

/* ---- proposed tasks ---- */

export function addProposed(db, t) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO proposed_tasks
       (id, project_key, name, description, priority, mode, risk_tier, rationale, bypass, auto_publish, deps, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`
  ).run(
    id, t.project_key, t.name, t.description || "", t.priority || "P2",
    t.mode || "non-dev", t.risk_tier || null, t.rationale || "", t.bypass ? 1 : 0, t.auto_publish ? 1 : 0,
    JSON.stringify(Array.isArray(t.deps) ? t.deps : []), Date.now()
  );
  return getProposed(db, id);
}
export const getProposed = (db, id) =>
  db.prepare(`SELECT * FROM proposed_tasks WHERE id = ?`).get(id);
export const listProposed = (db, status) =>
  status
    ? db.prepare(`SELECT * FROM proposed_tasks WHERE status = ? ORDER BY created_at DESC`).all(status)
    : db.prepare(`SELECT * FROM proposed_tasks ORDER BY created_at DESC`).all();
export function updateProposed(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return getProposed(db, id);
  const set = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE proposed_tasks SET ${set} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  return getProposed(db, id);
}

/* ---- hard delete (manual cleanup; whale-local only, never touches krill) ---- */
export const deleteEntry = (db, id) =>
  db.prepare(`DELETE FROM inbox_entries WHERE id = ?`).run(id);
export const deleteProposed = (db, id) =>
  db.prepare(`DELETE FROM proposed_tasks WHERE id = ?`).run(id);
