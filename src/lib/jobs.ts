// whale — in-memory registry for long-running ops (onboard audit, plan). Real
// Claude calls take 1-3 min; running them fire-and-forget here (not tied to the
// HTTP request) means they survive a client reload. The server process keeps them
// alive; /api/jobs exposes what's running so the UI can show + resume the view, and
// each start/finish broadcasts over SSE so the UI updates when work lands.
//
// Single-process (next start). A *server* restart cancels in-flight jobs (the child
// `claude` processes die with the parent) — those would need re-triggering.

import { broadcast } from "./events";

export type Job = { id: string; kind: string; key: string; startedAt: number; steps: string[] };
export type DoneJob = Job & { endedAt: number; ok: boolean; note?: string };

const running = new Map<string, Job>();
const recent: DoneJob[] = []; // last few finished, for one-shot UI toasts

export function isRunning(kind: string, key: string): boolean {
  for (const j of running.values()) if (j.kind === kind && j.key === key) return true;
  return false;
}

export function runningJobs(): Job[] {
  return [...running.values()];
}

export function recentJobs(): DoneJob[] {
  return [...recent];
}

/**
 * Start a tracked job and run `fn` fire-and-forget. Returns the job immediately.
 * `fn` receives a `report(text)` to stream live progress lines — each one is
 * appended to the job's `steps` and broadcast, so the UI can show what the run is
 * doing behind the scenes (e.g. the consensus bench's nominate → propose → merge).
 */
export function startJob(
  kind: string,
  key: string,
  fn: (report: (text: string) => void) => Promise<{ ok: boolean; note?: string }>,
): Job {
  const id = `${kind}:${key}:${Date.now()}`;
  const job: Job = { id, kind, key, startedAt: Date.now(), steps: [] };
  running.set(id, job);
  broadcast();
  const report = (text: string) => {
    job.steps.push(text);
    if (job.steps.length > 60) job.steps.shift(); // bound memory on a long run
    broadcast();
  };
  (async () => {
    let ok = false;
    let note: string | undefined;
    try {
      const r = await fn(report);
      ok = r.ok;
      note = r.note;
    } catch (e) {
      note = e instanceof Error ? e.message : String(e);
    } finally {
      running.delete(id);
      recent.unshift({ ...job, endedAt: Date.now(), ok, note });
      if (recent.length > 10) recent.pop();
      broadcast();
    }
  })();
  return job;
}
