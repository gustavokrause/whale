"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog";
import type { ProposedTask } from "@/db/schema";

export type PushEdit = { mode: string; bypass: boolean; auto_publish: boolean };

const btn =
  "px-3 py-1.5 rounded-sm text-sm border border-border-strong disabled:opacity-50 disabled:cursor-not-allowed";

// Pre-send review: shows whale's suggested settings per task, lets you override
// them inline, and warns BEFORE sending if auto-finish won't fire in krill.
export function PushReview({
  open,
  tasks,
  projectKey,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  tasks: ProposedTask[];
  projectKey: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (edits: Record<string, PushEdit>) => void;
}) {
  const [edits, setEdits] = useState<Record<string, PushEdit>>({});
  // undefined = loading; true/false = krill project allow_auto_finish; null = unknown
  const [armed, setArmed] = useState<boolean | null | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    const seed: Record<string, PushEdit> = {};
    for (const t of tasks)
      seed[t.id] = { mode: t.mode, bypass: !!t.bypass, auto_publish: !!t.auto_publish };
    setEdits(seed);
    setArmed(undefined);
    fetch(`/api/krill/arm-check?key=${encodeURIComponent(projectKey)}`)
      .then((r) => r.json())
      .then((d) => setArmed(d.armed))
      .catch(() => setArmed(null));
  }, [open, projectKey, tasks]);

  const set = (id: string, patch: Partial<PushEdit>) =>
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const anyAuto = Object.values(edits).some((e) => e.auto_publish);
  const warnUnarmed = anyAuto && armed === false;
  const warnUnknown = anyAuto && armed === null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent
        title="Review before sending to krill"
        description={`${tasks.length} task${tasks.length === 1 ? "" : "s"} → ${projectKey}`}
        size="large"
      >
        <DialogBody className="space-y-3">
          {warnUnarmed && (
            <div className="rounded-sm border border-warning/40 bg-warning/10 text-warning px-3 py-2 text-xs leading-relaxed">
              ⚠ Auto-finish is on, but krill project <b>{projectKey}</b> has{" "}
              <code>allow_auto_finish</code> OFF — these tasks will stop at deliverable
              review, not run unattended. Enable it on the project in krill, or send anyway.
            </div>
          )}
          {warnUnknown && (
            <div className="rounded-sm border border-info/40 bg-info/10 text-info px-3 py-2 text-xs leading-relaxed">
              Couldn&apos;t read the krill project&apos;s auto-finish setting (unreachable
              or the project isn&apos;t created yet). Auto-finish may not fire.
            </div>
          )}
          <ul className="divide-y divide-border border border-border rounded-sm">
            {tasks.map((t) => {
              const e = edits[t.id] ?? { mode: t.mode, bypass: !!t.bypass, auto_publish: !!t.auto_publish };
              return (
                <li key={t.id} className="px-3 py-2.5 space-y-2">
                  <div className="text-sm font-medium">{t.name}</div>
                  <div className="text-xs text-text-2">
                    {t.risk_tier || "?"} risk · {t.priority}
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs items-center">
                    <label className="inline-flex items-center gap-1.5">
                      Mode
                      <select
                        value={e.mode}
                        onChange={(ev) => set(t.id, { mode: ev.target.value })}
                        className="bg-surface-2 border border-border rounded px-1.5 py-1"
                      >
                        <option value="dev">dev</option>
                        <option value="non-dev">non-dev</option>
                      </select>
                    </label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={e.bypass}
                        onChange={(ev) => set(t.id, { bypass: ev.target.checked })}
                      />
                      Skip plan review
                    </label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={e.auto_publish}
                        onChange={(ev) => set(t.id, { auto_publish: ev.target.checked })}
                      />
                      Auto-finish <span className="text-text-3">(no review)</span>
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
        </DialogBody>
        <DialogFooter className="gap-2">
          <button type="button" className={btn} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`${btn} ${warnUnarmed ? "bg-warning text-black" : "bg-primary text-white"} border-transparent`}
            onClick={() => onConfirm(edits)}
            disabled={busy}
          >
            {busy ? "Sending…" : warnUnarmed ? "Send anyway" : "Send to krill"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
