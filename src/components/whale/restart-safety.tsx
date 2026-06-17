"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

type Job = { id: string; kind: string; key: string; startedAt: number };

/**
 * Restart-safety footer. Polls /api/jobs for in-flight Claude runs (plan / onboard
 * audit). Busy → loud warning: a server restart kills the child `claude` processes
 * mid-run (they'd need re-triggering). Idle → muted "safe to restart" for positive
 * confirmation before `npm run rebuild`. Pairs with the rebuild.sh/stop.sh guard.
 */
export function RestartSafety() {
  const [running, setRunning] = useState<Job[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      fetch("/api/jobs")
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setRunning(d.running ?? []);
        })
        .catch(() => {
          /* transient — keep last known state */
        });
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (running === null) return null; // unknown until first fetch

  const busy = running.length > 0;
  const labels = running.map((j) => `${j.kind}:${j.key}`).join(", ");

  return (
    <div className="fixed bottom-0 inset-x-0 z-40 border-t border-border bg-bg/95 backdrop-blur px-3 py-1.5 text-xs flex items-center gap-2">
      {busy ? (
        <span
          className="inline-flex items-center gap-1.5 font-medium text-danger"
          title={`Running: ${labels}. A restart kills these mid-run — wait for them to finish.`}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            Working — don&apos;t stop/rebuild ({running.length} running: {labels})
          </span>
        </span>
      ) : (
        <span
          className="inline-flex items-center gap-1 text-text-2"
          title="No in-flight Claude jobs — safe to stop/rebuild whale."
        >
          <CheckCircle2 className="h-3.5 w-3.5 text-success/70" />
          safe to restart
        </span>
      )}
    </div>
  );
}
