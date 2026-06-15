import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// Shared enums (also used by the reused krill ui primitives, e.g. badges).
export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];
// krill task statuses — whale mirrors them so shared badges compile and the
// gap-A krill→whale sync-back can render real krill states.
export const TASK_STATUSES = [
  "BACKLOG", "TODO", "PLANNING", "IMPLEMENTING", "AI-REVIEW",
  "PUBLISHING", "NEEDS_REVIEW", "DONE", "CANCELED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// The global capture stream (Phase 1).
export const inboxEntries = sqliteTable(
  "inbox_entries",
  {
    id: text("id").primaryKey(),
    text: text("text").notNull(),
    source: text("source").notNull().default("manual"),
    project_hint: text("project_hint"),
    status: text("status").notNull().default("raw"), // raw (pending) | planned
    lane: text("lane"), // router: task | context | new_project | ask
    created_at: integer("created_at").notNull(),
  },
  (t) => ({ createdIdx: index("inbox_created_idx").on(t.created_at) }),
);

// Planner output awaiting human review / push to krill (Phase 1-2).
export const proposedTasks = sqliteTable(
  "proposed_tasks",
  {
    id: text("id").primaryKey(),
    project_key: text("project_key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    priority: text("priority").notNull().default("P2"), // P0..P3
    mode: text("mode").notNull().default("non-dev"),
    risk_tier: text("risk_tier"), // low | medium | high
    rationale: text("rationale").notNull().default(""),
    bypass: integer("bypass", { mode: "boolean" }).notNull().default(false),
    auto_publish: integer("auto_publish", { mode: "boolean" }).notNull().default(false),
    deps: text("deps").notNull().default("[]"), // JSON: sibling task names (B2)
    refine_log: text("refine_log").notNull().default("[]"), // JSON: refine turns (B3)
    status: text("status").notNull().default("proposed"), // proposed|approved|rejected|pushed|push_failed
    krill_task_id: text("krill_task_id"),
    push_error: text("push_error"),
    created_at: integer("created_at").notNull(),
  },
  (t) => ({ statusIdx: index("proposed_status_idx").on(t.status) }),
);

// Runtime config overrides (singleton id=1). NULL column = fall back to env.
// The self-edit guard (WHALE_PROTECTED) is intentionally NOT here — env-only.
export const config = sqliteTable("config", {
  id: integer("id").primaryKey(),
  runner: text("runner"),
  model_plan: text("model_plan"),
  model_route: text("model_route"),
  bypass: text("bypass"),
  auto_push: integer("auto_push", { mode: "boolean" }),
  allow_new_projects: integer("allow_new_projects", { mode: "boolean" }),
});

export type InboxEntry = typeof inboxEntries.$inferSelect;
export type ProposedTask = typeof proposedTasks.$inferSelect;
export type ConfigRow = typeof config.$inferSelect;
