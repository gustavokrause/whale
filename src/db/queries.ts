// whale — data access over the drizzle singleton (replaces the old node:sqlite
// db.mjs). Functions mirror the prior API but take no db handle.

import { randomUUID } from "node:crypto";
import { eq, asc, desc } from "drizzle-orm";
import { db } from "./client";
import { broadcast } from "@/lib/events";
import { keyToSlug } from "@/lib/context-store";
import {
  inboxEntries,
  proposedTasks,
  config as configTable,
  blockers,
  type InboxEntry,
  type ProposedTask,
  type ConfigRow,
  type Blocker,
} from "./schema";

/* ---- inbox ---- */

export function addEntry({
  text,
  projectHint = null,
  source = "manual",
}: {
  text: string;
  projectHint?: string | null;
  source?: string;
}): InboxEntry {
  const trimmed = (text || "").trim();
  if (!trimmed) throw new Error("empty entry");
  const id = randomUUID();
  db.insert(inboxEntries)
    .values({ id, text: trimmed, source, project_hint: projectHint, status: "raw", created_at: Date.now() })
    .run();
  broadcast();
  return getEntry(id)!;
}

export const getEntry = (id: string): InboxEntry | undefined =>
  db.select().from(inboxEntries).where(eq(inboxEntries.id, id)).get();

export const listEntries = (limit = 50): InboxEntry[] =>
  db.select().from(inboxEntries).orderBy(desc(inboxEntries.created_at)).limit(limit).all();

export const rawEntries = (): InboxEntry[] =>
  db.select().from(inboxEntries).where(eq(inboxEntries.status, "raw")).orderBy(asc(inboxEntries.created_at)).all();

/** Pending (un-planned) requests tagged to a project — the dumps Plan consumes. */
export const pendingRequests = (key: string): InboxEntry[] => {
  const want = keyToSlug(key);
  return rawEntries().filter((e) => keyToSlug(e.project_hint || "global") === want);
};

export function markEntries(ids: string[], status: string) {
  for (const id of ids)
    db.update(inboxEntries).set({ status }).where(eq(inboxEntries.id, id)).run();
  broadcast();
}

/** Persist the router's decision: set the lane, keep an existing hint else fill it. */
export function setEntryLane(
  id: string,
  { lane, projectHint = null }: { lane: string; projectHint?: string | null },
): InboxEntry | undefined {
  const e = getEntry(id);
  const hint = (e?.project_hint || "").trim() || projectHint || null;
  db.update(inboxEntries).set({ lane, project_hint: hint }).where(eq(inboxEntries.id, id)).run();
  broadcast();
  return getEntry(id);
}

export const deleteEntry = (id: string) => {
  const r = db.delete(inboxEntries).where(eq(inboxEntries.id, id)).run();
  broadcast();
  return r;
};

/** Reassign a request to a project (promote an unassigned/global dump). */
export function setEntryProject(id: string, projectHint: string | null): InboxEntry | undefined {
  db.update(inboxEntries).set({ project_hint: projectHint }).where(eq(inboxEntries.id, id)).run();
  broadcast();
  return getEntry(id);
}

/** distinct project keys seen in the inbox (null hint => 'global') */
export const projectKeys = (): string[] => {
  const rows = db.select({ h: inboxEntries.project_hint }).from(inboxEntries).all();
  return [...new Set(rows.map((r) => (r.h || "").trim() || "global"))];
};

/* ---- proposed tasks ---- */

type ProposedInput = {
  project_key: string;
  name: string;
  description?: string;
  priority?: string;
  mode?: string;
  risk_tier?: string | null;
  rationale?: string;
  bypass?: boolean;
  auto_publish?: boolean;
  deps?: string[];
};

export function addProposed(t: ProposedInput): ProposedTask {
  const id = randomUUID();
  db.insert(proposedTasks)
    .values({
      id,
      project_key: t.project_key,
      name: t.name,
      description: t.description || "",
      priority: t.priority || "P2",
      mode: t.mode || "non-dev",
      risk_tier: t.risk_tier ?? null,
      rationale: t.rationale || "",
      bypass: !!t.bypass,
      auto_publish: !!t.auto_publish,
      deps: JSON.stringify(Array.isArray(t.deps) ? t.deps : []),
      status: "proposed",
      created_at: Date.now(),
    })
    .run();
  broadcast();
  return getProposed(id)!;
}

export const getProposed = (id: string): ProposedTask | undefined =>
  db.select().from(proposedTasks).where(eq(proposedTasks.id, id)).get();

export const listProposed = (status?: string): ProposedTask[] =>
  status
    ? db.select().from(proposedTasks).where(eq(proposedTasks.status, status)).orderBy(desc(proposedTasks.created_at)).all()
    : db.select().from(proposedTasks).orderBy(desc(proposedTasks.created_at)).all();

export function updateProposed(
  id: string,
  fields: Partial<typeof proposedTasks.$inferInsert>,
): ProposedTask {
  if (Object.keys(fields).length)
    db.update(proposedTasks).set(fields).where(eq(proposedTasks.id, id)).run();
  broadcast();
  return getProposed(id)!;
}

export const deleteProposed = (id: string) => {
  const r = db.delete(proposedTasks).where(eq(proposedTasks.id, id)).run();
  broadcast();
  return r;
};

/* ---- runtime config (UI-overridable subset; see lib/config.ts) ---- */

export const CONFIG_FIELDS = [
  "runner", "model_plan", "model_route",
  "bypass", "auto_push", "allow_new_projects",
] as const;

export const readConfig = (): ConfigRow | undefined =>
  db.select().from(configTable).where(eq(configTable.id, 1)).get();

export function writeConfig(fields: Partial<typeof configTable.$inferInsert>): ConfigRow | undefined {
  db.insert(configTable).values({ id: 1 }).onConflictDoNothing().run();
  const { id: _omit, ...rest } = fields;
  if (Object.keys(rest).length)
    db.update(configTable).set(rest).where(eq(configTable.id, 1)).run();
  broadcast();
  return readConfig();
}

/* ---- blockers (the unblock queue) ---- */

export function listBlockers(status?: string): Blocker[] {
  const rows = db.select().from(blockers).orderBy(desc(blockers.created_at)).all();
  return status ? rows.filter((b) => b.status === status) : rows;
}

export function getBlocker(id: string): Blocker | undefined {
  return db.select().from(blockers).where(eq(blockers.id, id)).get();
}

/**
 * File a blocker. Deduped on (kind, trigger_kind, trigger_ref) while still open —
 * a job that keeps re-blocking the same unit refreshes one row, not a pile.
 */
export function addBlocker(b: {
  kind: string;
  trigger_kind: string;
  trigger_ref: string;
  summary: string;
  detail?: string;
  action_url?: string | null;
  source?: string;
}): Blocker {
  const existing = listBlockers("open").find(
    (x) => x.kind === b.kind && x.trigger_kind === b.trigger_kind && x.trigger_ref === b.trigger_ref,
  );
  if (existing) {
    db.update(blockers)
      .set({ summary: b.summary, detail: b.detail ?? "", action_url: b.action_url ?? null, created_at: Date.now() })
      .where(eq(blockers.id, existing.id))
      .run();
    broadcast();
    return getBlocker(existing.id)!;
  }
  const row = {
    id: randomUUID(),
    source: b.source ?? "whale",
    kind: b.kind,
    status: "open",
    trigger_kind: b.trigger_kind,
    trigger_ref: b.trigger_ref,
    summary: b.summary,
    detail: b.detail ?? "",
    action_url: b.action_url ?? null,
    created_at: Date.now(),
    resolved_at: null,
  };
  db.insert(blockers).values(row).run();
  broadcast();
  return row as Blocker;
}

export function resolveBlocker(id: string, status: "resolved" | "dismissed" = "resolved"): Blocker | undefined {
  db.update(blockers).set({ status, resolved_at: Date.now() }).where(eq(blockers.id, id)).run();
  broadcast();
  return getBlocker(id);
}
