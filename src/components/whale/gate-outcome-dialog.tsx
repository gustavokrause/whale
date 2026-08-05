"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, FileText, MessageSquare, HelpCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog";

const btn =
  "px-3 py-1.5 rounded-sm text-sm border border-border-strong disabled:opacity-50 disabled:cursor-not-allowed";

/** Where the outcome text came from — decides how much the operator should trust it. */
export type OutcomeSource = "result" | "diff" | "notes" | "diff+notes" | "pasted" | null;

export type GatePreview = {
  result: string | null;
  resultSource: OutcomeSource;
  krillStatus?: string | null;
  dependents: string[];
  /** Dependents already holding another gate's unreviewed verdict. */
  skipped: { id: string; name: string; verdict: string; heldBy: string }[];
};

const PROVENANCE: Record<
  Exclude<OutcomeSource, null>,
  { icon: typeof FileText; label: string; hint: string; tone: string }
> = {
  result: {
    icon: FileText,
    label: "krill result field",
    hint: "krill recorded this as the task's own result.",
    tone: "text-success",
  },
  diff: {
    icon: FileText,
    label: "assembled from the diff",
    hint: "The deliverable's file changes. For a doc task this IS the document.",
    tone: "text-info",
  },
  notes: {
    icon: MessageSquare,
    label: "assembled from stage notes",
    hint: "No files changed — this is what the stages and AI review reported.",
    tone: "text-warning",
  },
  "diff+notes": {
    icon: FileText,
    label: "assembled from the diff + stage notes",
    hint: "The deliverable's file changes plus what the stages reported.",
    tone: "text-info",
  },
  pasted: {
    icon: MessageSquare,
    label: "pasted by you",
    hint: "Your text, not krill's.",
    tone: "text-text-2",
  },
};

/**
 * Review the gate outcome BEFORE spending a model call on the whole subtree.
 *
 * This exists because krill's stored outcome can be stale or thin: a research
 * task marked DONE months before its findings land still reads as whatever diff
 * it produced at the time, and judging a dozen downstream proposals against the
 * wrong text produces confident nonsense. So the operator sees the real text at
 * real size, is told where it came from, sees exactly which tasks will be judged
 * and which are spoken for by another gate, and edits before committing.
 */
export function GateOutcomeDialog({
  open,
  gateName,
  gateRef,
  krillTaskId,
  preview,
  refOf,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  gateName: string;
  gateRef: string;
  krillTaskId?: string | null;
  preview: GatePreview;
  /** Task name → short ref ("MV-17 wedge-call"). Full titles run 100 chars. */
  refOf: (name: string) => string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (result: string, overwrite: boolean) => void;
}) {
  const [text, setText] = useState(preview.result ?? "");
  const [overwrite, setOverwrite] = useState(false);
  useEffect(() => {
    setText(preview.result ?? "");
    setOverwrite(false);
  }, [preview]);

  const found = !!preview.result?.trim();
  const prov = preview.resultSource ? PROVENANCE[preview.resultSource] : null;
  const ProvIcon = prov?.icon ?? HelpCircle;
  const skippedNames = new Set(preview.skipped.map((s) => s.name));
  const willJudge = overwrite
    ? preview.dependents
    : preview.dependents.filter((n) => !skippedNames.has(n));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        size="large"
        title={found ? "Confirm the gate outcome" : "Paste the gate result"}
        description={
          found
            ? "Every verdict below is judged against this text — edit it if the real outcome landed after the task finished."
            : "whale found no outcome on this krill task. Paste the decision or research result the dependents should be judged against."
        }
      >
        <DialogBody className="space-y-4">
          {/* provenance — the operator's basis for trusting or replacing the text */}
          <div className="flex items-start gap-2 text-xs">
            <ProvIcon className={`h-4 w-4 shrink-0 mt-0.5 ${prov?.tone ?? "text-text-3"}`} />
            <div className="min-w-0">
              <div className="text-text-2">
                <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-border text-text-2">
                  {gateRef}
                </span>{" "}
                {gateName}
              </div>
              <div className="text-text-3 mt-1">
                {krillTaskId ? `krill ${krillTaskId}` : "no krill task"}
                {preview.krillStatus ? ` · ${preview.krillStatus}` : ""}
                {prov ? ` · ${prov.label}` : " · nothing found"}
                {prov ? ` — ${prov.hint}` : ""}
              </div>
            </div>
          </div>

          {/* the artifact under judgement, at a size you can actually read */}
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. NO-GO — survey returned N=12 (<30), 18% at R$21+ …"
            className="w-full h-[50vh] min-h-[240px] px-3 py-2.5 bg-surface text-text border border-border-strong rounded font-mono text-xs leading-relaxed focus:outline-none focus:border-primary resize-y"
          />

          {/* who gets judged */}
          <div className="text-xs space-y-1.5">
            <div className="text-text-2">
              Will judge <b>{willJudge.length}</b> task{willJudge.length === 1 ? "" : "s"}:
            </div>
            <div className="flex flex-wrap gap-1">
              {willJudge.length === 0 ? (
                <span className="text-text-3">nothing downstream is available to judge</span>
              ) : (
                willJudge.map((n) => (
                  <span
                    key={n}
                    className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-border text-text-2 max-w-full truncate"
                    title={n}
                  >
                    {refOf(n)}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* collision — another gate already judged some of this subtree */}
          {preview.skipped.length > 0 && (
            <div className="rounded border border-warning/40 bg-warning/10 p-3 space-y-2 text-xs">
              <div className="flex items-start gap-2 text-warning">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <b>{preview.skipped.length}</b> of these already carry an unreviewed verdict from
                  another gate. Two gates over one subtree both reach the same tasks — re-running
                  here would replace judgements you have not looked at yet.
                </div>
              </div>
              <ul className="pl-6 space-y-0.5 text-text-2">
                {preview.skipped.map((s) => (
                  <li key={s.id} className="truncate" title={s.name}>
                    {refOf(s.name)} — <span className="text-warning">{s.verdict}</span> from{" "}
                    {refOf(s.heldBy)}
                  </li>
                ))}
              </ul>
              <label className="flex items-center gap-2 pl-6 cursor-pointer text-text-2">
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                  className="accent-warning"
                />
                Replace them with this gate&apos;s verdicts
              </label>
            </div>
          )}
        </DialogBody>

        <DialogFooter className="gap-2">
          <button type="button" className={btn} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`${btn} bg-primary text-white border-transparent`}
            onClick={() => onConfirm(text, overwrite)}
            disabled={busy || !text.trim() || willJudge.length === 0}
            title={
              !text.trim()
                ? "No outcome to judge against"
                : willJudge.length === 0
                  ? "Every dependent is held by another gate — tick the box to replace their verdicts"
                  : undefined
            }
          >
            {busy ? "Re-evaluating…" : `Re-evaluate ${willJudge.length} task${willJudge.length === 1 ? "" : "s"}`}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
