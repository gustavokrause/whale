"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog";
import type { ProposedTask } from "@/db/schema";

// Mirrors the krill task toggles whale can set at push. `bypass` is krill's
// skip_plan_review (legacy name). skip_verify: null = inherit krill's mode
// default (dev verifies, non-dev skips); true = explicit skip.
export type PushEdit = {
  mode: string;
  skip_plan: boolean;
  bypass: boolean;
  skip_ai_review: boolean;
  skip_verify: boolean | null;
  auto_publish: boolean;
};

const btn =
  "px-3 py-1.5 rounded-sm text-sm border border-border-strong disabled:opacity-50 disabled:cursor-not-allowed";

const seedOf = (t: ProposedTask): PushEdit => ({
  mode: t.mode,
  skip_plan: !!t.skip_plan,
  bypass: !!t.bypass,
  skip_ai_review: !!t.skip_ai_review,
  skip_verify: t.skip_verify ?? null,
  auto_publish: !!t.auto_publish,
});

// Pre-send review: shows whale's suggested krill settings per task, lets you
// override them inline, and enforces the self-edit guard in the view (protected
// projects can't skip planning / plan-review / auto-finish — the push path
// forces them off regardless, so the UI shows that instead of lying).
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
  // Self-edit target (whale/krill): the human-gate toggles are forced off at push.
  const [prot, setProt] = useState(false);

  useEffect(() => {
    if (!open) return;
    const seed: Record<string, PushEdit> = {};
    for (const t of tasks) seed[t.id] = seedOf(t);
    setEdits(seed);
    setArmed(undefined);
    setProt(false);
    fetch(`/api/krill/arm-check?key=${encodeURIComponent(projectKey)}`)
      .then((r) => r.json())
      .then((d) => {
        setArmed(d.armed);
        setProt(!!d.protected);
      })
      .catch(() => setArmed(null));
  }, [open, projectKey, tasks]);

  const set = (id: string, patch: Partial<PushEdit>) =>
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  // Guard mirrors buildCreateArgs in pipeline.ts: protected forces these off.
  const anyAuto = !prot && Object.values(edits).some((e) => e.auto_publish);
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
          {prot && (
            <div className="rounded-sm border border-info/40 bg-info/10 text-info px-3 py-2 text-xs leading-relaxed">
              🛡 <b>{projectKey}</b> is a self-edit target — <b>skip planning</b> and
              <b> auto-finish</b> are disabled. Planning always runs and the deliverable
              always gets a human review before merge. (Skip plan-review, AI-review, and
              verify are still up to you.)
            </div>
          )}
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
              const e = edits[t.id] ?? seedOf(t);
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
                    <label
                      className={`inline-flex items-center gap-1.5 ${prot ? "opacity-40" : "cursor-pointer"}`}
                      title={prot ? "Self-edit guard: planning is always run for whale/krill" : undefined}
                    >
                      <input
                        type="checkbox"
                        disabled={prot}
                        checked={!prot && e.skip_plan}
                        onChange={(ev) => set(t.id, { skip_plan: ev.target.checked })}
                      />
                      Skip planning
                    </label>
                    <label
                      className={`inline-flex items-center gap-1.5 ${e.skip_plan ? "opacity-40" : "cursor-pointer"}`}
                      title={e.skip_plan ? "No plan to review when planning is skipped" : undefined}
                    >
                      <input
                        type="checkbox"
                        disabled={e.skip_plan}
                        checked={!e.skip_plan && e.bypass}
                        onChange={(ev) => set(t.id, { bypass: ev.target.checked })}
                      />
                      Skip plan review
                    </label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={e.skip_ai_review}
                        onChange={(ev) => set(t.id, { skip_ai_review: ev.target.checked })}
                      />
                      Skip AI review
                    </label>
                    <label className="inline-flex items-center gap-1.5">
                      Verify
                      <select
                        value={e.skip_verify === true ? "skip" : e.skip_verify === false ? "on" : "auto"}
                        onChange={(ev) =>
                          set(t.id, {
                            skip_verify: ev.target.value === "skip" ? true : ev.target.value === "on" ? false : null,
                          })
                        }
                        className="bg-surface-2 border border-border rounded px-1.5 py-1"
                        title="auto = krill default by mode (dev verifies, non-dev skips)"
                      >
                        <option value="auto">auto (by mode)</option>
                        <option value="skip">skip</option>
                        <option value="on">force on</option>
                      </select>
                    </label>
                    <label
                      className={`inline-flex items-center gap-1.5 ${prot ? "opacity-40" : "cursor-pointer"}`}
                      title={prot ? "Self-edit guard: whale/krill tasks always get deliverable review" : undefined}
                    >
                      <input
                        type="checkbox"
                        disabled={prot}
                        checked={!prot && e.auto_publish}
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
