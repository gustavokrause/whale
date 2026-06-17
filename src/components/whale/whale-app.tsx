"use client";

import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  Circle,
  Trash2,
  ArrowRight,
  Pencil,
  Sun,
  Moon,
  RotateCw,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Ban,
  Pause,
  Play,
  Lock,
  Inbox as InboxIcon,
  BookOpen,
  ListChecks,
  Settings as SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog-provider";
import { PushReview, type PushEdit } from "@/components/whale/push-review";
import { BlockersBanner } from "@/components/whale/blockers-banner";
import { WhaleIcon } from "@/components/app/whale-icon";
import type { InboxEntry, ProposedTask } from "@/db/schema";

type Status = {
  runner: string;
  autonomy: { bypass: string; autoPush: boolean };
  inbox: { total: number; raw: number };
  proposed: { total: number };
  krill: { up: boolean; url: string };
};

type ConfigSnap = {
  runner: string;
  models: { plan: string; route: string };
  autonomy: { bypass: string; autoPush: boolean; allowNewProjects: boolean; planFileAccess: boolean };
  envLocked: { protected: string[]; krillUrl: string; personasDir: string };
};

const TABS = ["inbox", "context", "proposed", "settings"] as const;
type Tab = (typeof TABS)[number];

const NAV: { id: Tab; label: string; Icon: LucideIcon }[] = [
  { id: "inbox", label: "Inbox", Icon: InboxIcon },
  { id: "context", label: "Context", Icon: BookOpen },
  { id: "proposed", label: "Proposed", Icon: ListChecks },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
];

// Native <select> with the OS chevron suppressed and a real right-pad so the
// value never collides with our own chevron. Drop-in for raw <select>.
function NativeSelect({
  className = "",
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative inline-flex">
      <select
        {...props}
        className={`appearance-none bg-surface text-text border border-border-strong rounded-lg font-mono pl-3 pr-9 py-2.5 focus:outline-none focus:border-primary ${className}`}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-text-2" />
    </div>
  );
}

const j = async (url: string, opts?: RequestInit) => (await fetch(url, opts)).json();
const post = (url: string, body?: unknown) =>
  j(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

// colored status dot (filled lucide Circle) — literal classes so Tailwind JIT keeps them
const DOT = {
  danger: "fill-danger text-danger",
  success: "fill-success text-success",
  warning: "fill-warning text-warning",
  orange: "fill-orange-500 text-orange-500",
} as const;
function Dot({ tone, className = "" }: { tone: keyof typeof DOT; className?: string }) {
  return <Circle className={`h-2 w-2 shrink-0 ${DOT[tone]} ${className}`} />;
}

function flowOf(p: ProposedTask): React.ReactNode {
  if (p.risk_tier === "high") return <><Dot tone="danger" /> full review</>;
  if (p.auto_publish) return <><Dot tone="success" /> auto-finish→DONE</>;
  if (p.bypass) return <><Dot tone="warning" /> →deliverable</>;
  return "plan review";
}

const curTab = (): Tab => {
  const h = (typeof window !== "undefined" ? window.location.hash.slice(1) : "") as Tab;
  return TABS.includes(h) ? h : "inbox";
};

export function WhaleApp() {
  const [tab, setTab] = useState<Tab>("inbox");
  const [busy, setBusy] = useState(0);
  const [busyLabel, setBusyLabel] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [jobs, setJobs] = useState<{ kind: string; key: string }[]>([]);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    setTheme((document.documentElement.dataset.theme as "dark" | "light") || "dark");
  }, []);
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("whale-theme", next);
    } catch { }
    setTheme(next);
  };

  const withBusy = useCallback(async <T,>(label: string, p: Promise<T>): Promise<T> => {
    setBusy((n) => n + 1);
    setBusyLabel(label);
    try {
      return await p;
    } finally {
      setBusy((n) => n - 1);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await j("/api/status"));
    } catch {
      setStatus(null);
    }
    try {
      setJobs((await j("/api/jobs")).running || []);
    } catch {
      /* keep last */
    }
  }, []);

  // hash routing
  useEffect(() => {
    const sync = () => setTab(curTab());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    loadStatus();
    // poll so krill going down/recovering reflects in the footer without a mutation
    const id = setInterval(() => !document.hidden && loadStatus(), 15000);
    return () => clearInterval(id);
  }, [loadStatus]);

  // SSE: live push on any data mutation. `rev` bumps → mounted tabs reload.
  const [rev, setRev] = useState(0);
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onmessage = () => {
      setRev((r) => r + 1);
      loadStatus();
    };
    es.onerror = () => { }; // browser auto-reconnects
    return () => es.close();
  }, [loadStatus]);

  const go = (t: Tab) => {
    window.location.hash = t;
  };

  const counts: Partial<Record<Tab, number>> = {
    inbox: status?.inbox.raw || 0,
    proposed: status?.proposed.total || 0,
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {busy > 0 && <div className="fixed top-0 left-0 h-0.5 w-[30%] bg-primary animate-[ind_1.1s_linear_infinite] z-50" />}

      {/* command rail */}
      <aside className="w-56 shrink-0 flex flex-col border-r border-border bg-surface-2">
        <div className="flex items-center gap-2.5 px-4 h-14 border-b border-border">
          <span className="inline-flex items-center justify-center h-7 w-7 rounded-full bg-primary text-white shrink-0" aria-label="whale">
            <WhaleIcon className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-bold tracking-wide">whale</div>
            <div className="text-[10px] text-text-3 uppercase tracking-[0.15em]">strategy brain</div>
          </div>
        </div>

        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {NAV.map(({ id, label, Icon }) => {
            const on = tab === id;
            const n = counts[id] || 0;
            return (
              <button
                key={id}
                onClick={() => go(id)}
                className={`group relative w-full flex items-center gap-2.5 pl-3.5 pr-2.5 py-2 rounded-lg text-sm transition-colors ${on ? "bg-surface text-text" : "text-text-2 hover:text-text hover:bg-surface/60"
                  }`}
              >
                <span className={`absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary transition-opacity ${on ? "opacity-100" : "opacity-0"}`} />
                <Icon className={`h-4 w-4 shrink-0 ${on ? "text-primary" : ""}`} />
                <span className="flex-1 text-left">{label}</span>
                {n > 0 && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${on ? "bg-primary/15 text-primary" : "bg-border text-text-2"}`}>
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-border p-3 space-y-2">
          {status ? (
            <div className="text-[11px] text-text-2 leading-relaxed space-y-0.5">
              <div>runner <span className="text-text">{status.runner}</span></div>
              <div>bypass <span className="text-text">{status.autonomy.bypass}</span></div>
              <div className="inline-flex items-center gap-1">
                krill
                <Circle className={`h-2 w-2 ${status.krill.up ? "fill-success text-success" : "fill-danger text-danger"}`} />
                <span className="text-text">{status.krill.up ? "up" : "down"}</span>
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-text-3">connecting…</div>
          )}
          {jobs.length > 0 && (
            <div className="text-[11px] text-info inline-flex items-center gap-1" title={jobs.map((x) => `${x.kind} ${x.key}`).join(", ")}>
              <Loader2 className="h-3 w-3 animate-spin" /> {jobs.length} job{jobs.length === 1 ? "" : "s"} running
            </div>
          )}
          <button
            onClick={toggleTheme}
            className="w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs text-text-2 hover:text-text border border-border hover:bg-surface"
            title="Toggle dark/light"
          >
            {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
      </aside>

      {/* working area — full width */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 border-b border-border flex items-center gap-3 px-6">
          <h1 className="text-base font-bold capitalize">{tab}</h1>
          {busy > 0 && (
            <span className="text-xs text-warning inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> {busyLabel}…
            </span>
          )}
          {status && (
            <span className="ml-auto text-xs text-text-2">
              inbox {status.inbox.raw}/{status.inbox.total} · proposed {status.proposed.total} · autoPush {String(status.autonomy.autoPush)}
            </span>
          )}
        </header>

        <main className="flex-1 overflow-y-auto px-6 py-6">
          {/* Unblock queue — paused units (MCP auth / CLI login) needing attention. */}
          <BlockersBanner rev={rev} />
          {/* keep all tabs mounted (hidden) so typed text / selections survive a tab
              switch, like the original display:none UI. Polling is gated by `active`. */}
          <div hidden={tab !== "inbox"}>
            <InboxTab withBusy={withBusy} onChange={loadStatus} active={tab === "inbox"} rev={rev} jobs={jobs} />
          </div>
          <div hidden={tab !== "context"}>
            <ContextTab withBusy={withBusy} rev={rev} jobs={jobs} />
          </div>
          <div hidden={tab !== "proposed"}>
            <ProposedTab withBusy={withBusy} onChange={loadStatus} active={tab === "proposed"} rev={rev} krillDown={status?.krill.up === false} />
          </div>
          <div hidden={tab !== "settings"}>
            <SettingsTab withBusy={withBusy} onSaved={loadStatus} rev={rev} />
          </div>
        </main>
      </div>

      <style>{`@keyframes ind{0%{left:-30%}100%{left:100%}}`}</style>
    </div>
  );
}

type Busy = <T>(label: string, p: Promise<T>) => Promise<T>;

const hint = "text-xs text-text-2 mb-3 p-2 bg-surface-2 border border-border border-l-2 border-l-info rounded";
const btn = "px-4 py-2 rounded-lg text-sm font-semibold";
const actBtn = `${btn} bg-success text-white`;
const ghost = `${btn} bg-surface-2 text-text border border-border`;
const danger = `${btn} bg-danger/10 text-danger border border-danger/40`;
// Discreet bulk action (Push batch / Push group): secondary to the per-task
// Approve/Push primary, so the main flow stays the visual focus.
const subtleBtn =
  "inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-text-2 border border-border hover:bg-surface-2 hover:text-text";
// Per-task primary (Approve / Push / Retry / Unpark): same compact size as the
// bulk buttons, but green outline — the most-used action, distinct yet not loud.
const pushBtn =
  "inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-success border border-success/50 hover:bg-success/10";
// Compact destructive (Reject / delete) — same size family, danger outline.
const dangerSm =
  "inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-danger border border-danger/40 hover:bg-danger/10";

function InboxTab({ withBusy, onChange, active, rev, jobs }: { withBusy: Busy; onChange: () => void; active: boolean; rev: number; jobs: { kind: string; key: string }[] }) {
  const isJob = (kind: string, key: string) => jobs.some((x) => x.kind === kind && x.key === key);
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [text, setText] = useState("");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const { push } = useToast();
  const dlg = useDialog();

  const load = useCallback(async () => {
    setEntries((await j("/api/inbox")).entries);
    // only ONBOARDED projects (those with context) are dumpable — Onboard gates it
    const ps: string[] = (await j("/api/context")).keys || [];
    setProjects(ps);
    // default to "" (unassigned/capture); keep a still-valid selection
    setProject((p) => (p && ps.includes(p) ? p : ""));
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(() => active && !document.hidden && load(), 5000);
    return () => clearInterval(id);
  }, [load, active, rev]);

  const dump = async () => {
    if (!text.trim()) return;
    await withBusy("Capturing", post("/api/inbox", { text: text.trim(), project_hint: project || null }));
    setText("");
    load();
    onChange();
  };
  const planProject = async (key: string) => {
    if (!key) return;
    const r = await post("/api/plan", { key });
    if (r.running) push({ variant: "info", title: `Planning ${key}…`, description: "running in background — Proposed updates when it lands" });
    else if (r.error) push({ variant: "danger", title: "Plan failed", description: r.error });
    load();
    onChange();
  };
  const moveEntry = async (id: string) => {
    const k = await dlg.prompt({
      title: "Move to project",
      description: `Onboarded projects: ${projects.join(", ") || "none yet"}`,
      placeholder: "project key",
      confirmLabel: "Move",
    });
    const key = k?.trim();
    if (!key) return;
    await withBusy("Moving", j(`/api/inbox/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_hint: key }) }));
    load();
    onChange();
  };
  const makeProject = async (id: string, body: string) => {
    const k = await dlg.prompt({
      title: "Make project",
      description: "New project key seeded from this idea.",
      placeholder: "e.g. arqtrack",
      confirmLabel: "Create",
    });
    const key = k?.trim();
    if (!key) return;
    await withBusy(`Creating ${key}`, post("/api/context", { key, md: `# CONTEXT — ${key}\n\n## Idea\n${body}\n` }));
    await j(`/api/inbox/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_hint: key }) });
    push({ variant: "success", title: `Created ${key}`, description: "seeded + request moved — Plan it" });
    load();
    onChange();
  };
  const del = async (id: string) => {
    if (!(await dlg.confirm({ title: "Delete request?", description: "This permanently removes the request.", confirmLabel: "Delete", confirmVariant: "danger" }))) return;
    await withBusy("Deleting", j(`/api/inbox/${id}`, { method: "DELETE" }));
    load();
    onChange();
  };

  const grouped = entries.reduce<Record<string, InboxEntry[]>>((acc, e) => {
    const k = e.project_hint || "(unassigned)";
    (acc[k] ||= []).push(e);
    return acc;
  }, {});
  const groupKeys = Object.keys(grouped).sort();
  const pendingIn = (list: InboxEntry[]) => list.filter((e) => e.status === "raw").length;
  const dis = "disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <section>
      <p className={hint}>
        Dump <b>work requests</b> for a project — or leave it <b>unassigned</b> to just capture an idea
        (⌘/Ctrl-Enter). Each is queued <i>pending</i>. <b>Plan</b> (per group) turns a project&apos;s pending
        requests into proposed tasks; <b>unassigned</b> ones you <b>Move</b> to a project or <b>Make</b> a new one.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && dump()}
        placeholder="A thought, a chat snippet, a request, whatever…"
        className="w-full min-h-[110px] p-3 bg-surface text-text border border-border-strong rounded-lg font-mono"
        autoFocus
      />
      <div className="flex gap-2.5 mt-2.5 flex-wrap items-center">
        <NativeSelect
          value={project}
          onChange={(e) => setProject(e.target.value)}
          className="min-w-[180px]"
        >
          <option value="">— unassigned (capture) —</option>
          {projects.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </NativeSelect>
        <button className={`${actBtn} ${dis}`} onClick={dump} disabled={!text.trim()}>
          {project ? "Dump request" : "Capture"}
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="text-text-2 mt-4">No requests yet — dump one above.</p>
      ) : (
        groupKeys.map((p) => {
          const un = p === "(unassigned)";
          return (
            <div key={p} className="mt-4 border border-border rounded-lg overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-3 py-2 bg-surface-2 border-b border-border">
                <span className="text-sm">
                  <b>{un ? "unassigned" : p}</b>{" "}
                  <span className="text-text-2">· {un ? "scratchpad — promote items to a project" : `${pendingIn(grouped[p])} pending`}</span>
                </span>
                {!un && (
                  <button
                    className={`${actBtn} ${dis} inline-flex items-center gap-1 !px-3 !py-1.5`}
                    onClick={() => planProject(p)}
                    disabled={pendingIn(grouped[p]) === 0 || isJob("plan", p)}
                    title={`Plan all pending requests for ${p}`}
                  >
                    {isJob("plan", p) ? (
                      <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Planning…</>
                    ) : (
                      <>Plan <ArrowRight className="h-3.5 w-3.5" /></>
                    )}
                  </button>
                )}
              </div>
              <ul className="divide-y divide-border">
                {grouped[p].map((e) => (
                  <li key={e.id} className="px-3 py-2.5">
                    {e.text}
                    {e.plan_error ? (
                      <div className="mt-1.5 rounded-sm border border-danger/40 bg-danger/10 text-danger text-xs px-2 py-1.5 break-words inline-flex items-start gap-1">
                        <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" /> <span>Plan failed: {e.plan_error}</span>
                      </div>
                    ) : null}
                    <div className="text-xs text-text-2 mt-1.5 flex gap-2 flex-wrap items-center">
                      <span className={`px-2 rounded-full ${e.status === "raw" ? "bg-warning/20 text-warning" : "bg-success/20 text-success"}`}>
                        {e.status === "raw" ? "pending" : e.status}
                      </span>
                      {e.source === "krill-followup" && (
                        <span className="px-2 rounded-full bg-info/15 text-info" title="Auto-captured follow-up from a krill task">↩ from krill</span>
                      )}
                      <span>{new Date(e.created_at).toLocaleString()}</span>
                      {un && (
                        <>
                          <button className={`${ghost} !px-2 !py-1`} onClick={() => moveEntry(e.id)} title="Move to an onboarded project">Move to…</button>
                          <button className={`${ghost} !px-2 !py-1`} onClick={() => makeProject(e.id, e.text)} title="Seed a new project from this idea">Make project</button>
                        </>
                      )}
                      <button className={`${danger} inline-flex items-center !px-2 !py-1`} title="Delete request" onClick={() => del(e.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

function ContextTab({ withBusy, rev, jobs }: { withBusy: Busy; rev: number; jobs: { kind: string; key: string }[] }) {
  const isJob = (kind: string, key: string) => jobs.some((x) => x.kind === kind && x.key === key);
  const [keys, setKeys] = useState<string[]>([]);
  const [stale, setStale] = useState<Record<string, { behind: number }>>({});
  const [available, setAvailable] = useState<string[]>([]);
  const [obk, setObk] = useState("");
  const [seedMd, setSeedMd] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [md, setMd] = useState("");
  const { push } = useToast();
  const dlg = useDialog();
  const obkRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await j("/api/context?stale=1");
    const k: string[] = r.keys || [];
    setKeys(k);
    setStale(r.stale || {});
    const ps: string[] = (await j("/api/projects")).projects || [];
    setAvailable(ps.filter((p) => !k.includes(p))); // krill projects without context yet
  }, []);

  // Prefill the onboard/seed form with a project, then focus it — intent-driven,
  // no auto-audit on click (plan auto-derives; this is the "do it now" shortcut).
  const pick = (p: string) => {
    setObk(p);
    obkRef.current?.focus();
  };
  useEffect(() => {
    load();
  }, [load, rev]);

  const view = async (k: string) => {
    setSel(k);
    setMd((await j(`/api/context?key=${encodeURIComponent(k)}`)).md || "(empty)");
  };
  const audit = async (key: string, refresh = false) => {
    if (!key) return;
    const r = await post("/api/onboard", { key });
    if (r.running) push({ variant: "info", title: `${refresh ? "Auditing" : "Onboarding"} ${key}…`, description: "running in background — context updates when it lands" });
    else if (r.error) push({ variant: "danger", title: "Failed", description: r.error });
    load();
  };
  const del = async (k: string) => {
    if (!(await dlg.confirm({ title: `Delete context for ${k}?`, description: "Permanently removes whale's background context for this project. Does not touch krill or the repo.", confirmLabel: "Delete", confirmVariant: "danger" }))) return;
    await withBusy(`Deleting ${k}`, j(`/api/context?key=${encodeURIComponent(k)}`, { method: "DELETE" }));
    if (sel === k) {
      setSel(null);
      setMd("");
    }
    load();
  };
  const onboardOrSeed = async () => {
    const key = obk.trim();
    if (!key) return;
    if (seedMd.trim()) {
      const r = await withBusy(`Seeding ${key}`, post("/api/context", { key, md: seedMd }));
      if (r.ok) push({ variant: "success", title: `Seeded ${key}`, description: `${r.chars} chars of context` });
      else push({ variant: "danger", title: "Seed failed", description: r.error });
      load();
      if (sel === key) view(key);
    } else {
      await audit(key);
    }
    setObk("");
    setSeedMd("");
  };

  const dis = "disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <section>
      <p className={hint}>
        Per-project <b>background context</b> that <b>grounds Plan</b>. Planning a repo project
        <b> auto-builds</b> this on first run — onboard by hand only to seed an <b>idea project</b> (no repo)
        or pre-build it. <b>Audit ↻</b> re-runs the audit; the <span className="text-warning inline-flex items-center gap-0.5 align-middle"><AlertTriangle className="h-3 w-3" /> N</span> badge
        means the repo moved N commits since the last audit.
      </p>
      <div className="space-y-2.5">
        <input
          ref={obkRef}
          value={obk}
          onChange={(e) => setObk(e.target.value)}
          placeholder="project key (e.g. arqtrack, krill)"
          className="w-full px-3 py-2.5 bg-surface text-text border border-border-strong rounded-lg font-mono"
        />
        <textarea
          value={seedMd}
          onChange={(e) => setSeedMd(e.target.value)}
          placeholder="optional: paste background context to seed by hand (e.g. an idea project with no repo). Leave empty to audit the repo via krill."
          className="w-full min-h-[90px] p-3 bg-surface text-text border border-border-strong rounded-lg font-mono text-sm"
        />
        <button
          className={`${actBtn} ${dis} inline-flex items-center gap-1`}
          onClick={onboardOrSeed}
          disabled={!obk.trim()}
        >
          {seedMd.trim() ? "Seed context" : "Onboard (audit repo)"} <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
      {available.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-text-2 mb-1.5">krill projects without context yet — click to onboard:</p>
          <div className="flex gap-2 flex-wrap">
            {available.map((p) => (
              <button key={p} type="button" className={`${ghost} !px-2.5 !py-1.5 text-sm`} onClick={() => pick(p)}>
                + {p}
              </button>
            ))}
          </div>
        </div>
      )}
      {keys.length === 0 ? (
        <p className="text-text-2 mt-4">No context yet — it builds automatically when you Plan a repo project, or seed an idea project above.</p>
      ) : (
        <>
          <h3 className="mt-4 mb-2 text-text-2 text-xs uppercase tracking-wide">onboarded projects</h3>
          <div className="flex gap-2 flex-wrap">
            {keys.map((k) => (
              <span key={k} className="inline-flex items-center border border-border rounded-lg bg-surface-2">
                <button className="px-2.5 py-1.5 text-sm text-text hover:text-primary" onClick={() => view(k)}>{k}</button>
                {stale[k]?.behind ? (
                  <span title={`Repo moved ${stale[k].behind} commit(s) since the audit — re-audit to refresh`} className="pr-1.5 text-warning text-xs font-mono inline-flex items-center gap-0.5">
                    <AlertTriangle className="h-3 w-3" />
                    {stale[k].behind}
                  </span>
                ) : null}
                <button className="px-2 py-1.5 text-text-2 hover:text-text border-l border-border disabled:opacity-50" title="Re-audit (refresh context)" onClick={() => audit(k, true)} disabled={isJob("onboard", k)}>
                  {isJob("onboard", k) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
                </button>
                <button className="px-2 py-1.5 text-text-2 hover:text-danger border-l border-border disabled:opacity-50" title="Delete context" onClick={() => del(k)} disabled={isJob("onboard", k)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        </>
      )}
      {sel && (
        <div className="mt-4">
          <div className="flex items-center gap-2.5 mb-3">
            <b>{sel}</b>
            <span className="text-xs text-text-2">background context — Plan it from the Inbox tab</span>
          </div>
          <pre className="whitespace-pre-wrap bg-surface-2 border border-border rounded-lg p-3.5 font-mono text-sm">{md}</pre>
        </div>
      )}
    </section>
  );
}

type EnrichedTask = ProposedTask & { krill_status?: string | null; source_entry_text?: string | null };

function ProposedTab({ withBusy, onChange, active, rev, krillDown }: { withBusy: Busy; onChange: () => void; active: boolean; rev: number; krillDown: boolean }) {
  const [items, setItems] = useState<EnrichedTask[]>([]);
  const [showRej, setShowRej] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [review, setReview] = useState<{ tasks: EnrichedTask[]; key: string; kind: "single" | "batch" | "group"; sourceEntryId?: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (id: string) =>
    setCollapsedGroups((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  // Cards are collapsed by default (scannable list); expand one for full detail.
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const toggleCard = (id: string) =>
    setExpandedCards((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const { push } = useToast();
  const dlg = useDialog();

  // Send-to-krill, after the pre-send review modal. Persists any inline
  // overrides (PATCH per task), then pushes with confirm (the modal IS the gate).
  const sendReview = async (edits: Record<string, PushEdit>) => {
    if (!review) return;
    setSending(true);
    try {
      for (const t of review.tasks) {
        const e = edits[t.id];
        if (e) await j(`/api/proposed/${t.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e) });
      }
      let r;
      if (review.kind === "single") r = await post(`/api/proposed/${review.tasks[0].id}/push`, { confirm: true });
      else if (review.kind === "group") r = await post("/api/proposed/push-group", { key: review.key, source_entry_id: review.sourceEntryId, confirm: true });
      else r = await post("/api/proposed/push-batch", { key: review.key, confirm: true });
      if (r.error) push({ variant: "danger", title: "Push failed", description: r.error });
      else if (review.kind === "single") push({ variant: "success", title: "Pushed to krill" });
      else push({ variant: "success", title: `Pushed ${r.pushed}/${r.total || r.pushed} to krill` });
      if (r.warning) push({ variant: "warning", title: "Heads up", description: r.warning });
    } finally {
      setSending(false);
      setReview(null);
      load();
      onChange();
    }
  };

  // ?sync=1 reads back live krill status for pushed tasks (Gap A — no more stale rows)
  const load = useCallback(async () => {
    setItems((await j("/api/proposed?sync=1")).proposed);
    setProjects((await j("/api/context")).keys || []);
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(() => active && !document.hidden && load(), 5000);
    return () => clearInterval(id);
  }, [load, active, rev]);

  const act = async (id: string, action: string) => {
    let r = await withBusy(action, post(`/api/proposed/${id}/${action}`));
    if (r.needsConfirm) {
      if (!(await dlg.confirm({ title: "Arm auto-finish", description: r.message, confirmLabel: "Arm", confirmVariant: "danger" }))) return load();
      r = await withBusy(action, post(`/api/proposed/${id}/${action}`, { confirm: true }));
    }
    if (r.error) push({ variant: "danger", title: "Failed", description: r.error });
    else if (r.warning) push({ variant: "warning", title: "Auto-finish not armed in krill", description: r.warning });
    else if (r.note) push({ variant: "info", title: r.note });
    load();
    onChange();
  };
  const refine = async (id: string) => {
    const input = await dlg.prompt({
      title: "Refine task",
      description: "What should change about this task?",
      placeholder: "e.g. split into two, lower the risk, add tests…",
      multiline: true,
      confirmLabel: "Refine",
    });
    if (!input?.trim()) return;
    const r = await withBusy("Refining task (real Claude)", post(`/api/proposed/${id}/refine`, { input }));
    if (r.error) push({ variant: "danger", title: "Refine failed", description: r.error });
    else push({ variant: "success", title: `Refined → ${r.task.name}`, description: `flow: ${r.flow}` });
    load();
  };
  const reassign = async (id: string) => {
    const k = await dlg.prompt({
      title: "Reassign task",
      description: `Projects: ${projects.join(", ") || "none yet"}`,
      placeholder: "project key",
      confirmLabel: "Reassign",
    });
    const key = k?.trim();
    if (!key) return;
    const r = await withBusy("Reassigning + re-triaging", post(`/api/proposed/${id}/reassign`, { project_key: key }));
    if (r.error) push({ variant: "danger", title: "Reassign failed", description: r.error });
    load();
  };
  const del = async (id: string) => {
    if (!(await dlg.confirm({ title: "Delete proposal?", description: "whale-local — does not touch krill.", confirmLabel: "Delete", confirmVariant: "danger" }))) return;
    await withBusy("Deleting", j(`/api/proposed/${id}`, { method: "DELETE" }));
    load();
    onChange();
  };
  const togglePark = async (id: string, disabled: boolean) => {
    await j(`/api/proposed/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ disabled }) });
    load();
    onChange();
  };
  const rejN = items.filter((p) => p.status === "rejected").length;
  const show = showRej ? items : items.filter((p) => p.status !== "rejected");
  const grouped = show.reduce<Record<string, EnrichedTask[]>>((a, p) => {
    (a[p.project_key] ||= []).push(p);
    return a;
  }, {});
  const groupKeys = Object.keys(grouped).sort();
  const pushable = (list: EnrichedTask[]) =>
    list.filter((p) => !p.disabled && ["proposed", "approved", "push_failed"].includes(p.status)).length;
  const dis = "disabled:opacity-40 disabled:cursor-not-allowed";
  // Execution order: a task lands after every dep it has in the set (topo sort).
  const topoSort = (list: EnrichedTask[]) => {
    const byName = new Map(list.map((t) => [t.name, t]));
    const seen = new Set<string>();
    const out: EnrichedTask[] = [];
    const visit = (t: EnrichedTask) => {
      if (seen.has(t.name)) return;
      seen.add(t.name);
      for (const d of JSON.parse(t.deps || "[]") as string[]) {
        const dep = byName.get(d);
        if (dep) visit(dep);
      }
      out.push(t);
    };
    for (const t of list) visit(t);
    return out;
  };
  // Sub-group a project's tasks by source dump (plan run), each in execution order.
  const dumpGroups = (list: EnrichedTask[]) => {
    const m = new Map<string, EnrichedTask[]>();
    for (const t of list) {
      const k = t.source_entry_id ?? "__none__";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(t);
    }
    return [...m.entries()].map(([id, ts]) => ({
      id,
      text: ts.find((t) => t.source_entry_text)?.source_entry_text ?? null,
      tasks: topoSort(ts),
    }));
  };
  // task name -> its dump (to flag cross-dump deps) and -> its short label.
  const nameToDump = new Map(items.map((t) => [t.name, t.source_entry_id ?? "__none__"]));
  const shortName = (s: string) => (s.length > 22 ? s.slice(0, 21) + "…" : s);
  const nameToTask = new Map(items.map((t) => [t.name, t]));
  // Reference a dep/dependent by its stable id (krill id once pushed, else TEMP)
  // + its handle; `done` (synced krill status) lets the UI strike completed ones.
  const depMeta = (name: string) => {
    const t = nameToTask.get(name);
    if (!t) return { ref: shortName(name), done: false };
    const id = t.krill_task_id ?? `TEMP-${t.id.slice(0, 4).toUpperCase()}`;
    return { ref: `${id} ${t.label || shortName(name)}`, done: t.krill_status === "DONE" };
  };
  const renderRefs = (names: string[]) =>
    names.map((d, i) => {
      const m = depMeta(d);
      return (
        <span key={d} className={m.done ? "line-through opacity-60" : ""}>
          {i > 0 ? " + " : ""}{m.ref}
        </span>
      );
    });
  // Reverse edges: task name -> names of tasks that depend on it (it unblocks).
  const dependents = new Map<string, string[]>();
  for (const t of items)
    for (const d of JSON.parse(t.deps || "[]") as string[])
      dependents.set(d, [...(dependents.get(d) ?? []), t.name]);
  // Actionable = not parked and not yet pushed (can still go to krill).
  const actionable = (p: EnrichedTask) =>
    !p.disabled && ["proposed", "approved", "push_failed"].includes(p.status);
  // Deps that aren't DONE yet — the things still blocking this task from krill.
  const blockingDeps = (p: EnrichedTask) =>
    (JSON.parse(p.deps || "[]") as string[]).filter((d) => !depMeta(d).done);
  // Ready for krill = actionable + every dep DONE (no-dep tasks are trivially ready).
  const readyForKrill = (p: EnrichedTask) => actionable(p) && blockingDeps(p).length === 0;
  // Per-project rollup: how many tasks are unblocked and ready to push now.
  const readyCount = (list: EnrichedTask[]) => list.filter(readyForKrill).length;
  // Risk → a single signal: colored left border + one dot. Kills the risk pill.
  const riskDot = (t?: string | null) => (
    <Dot tone={t === "high" ? "danger" : t === "low" ? "success" : "orange"} />
  );
  const riskBorder = (t?: string | null) =>
    t === "high" ? "border-l-danger" : t === "low" ? "border-l-success" : "border-l-orange-500";

  return (
    <section>
      <p className={hint}>
        The review gate, <b>grouped by project</b>. Each task shows <b>risk</b> + whether it&apos;ll
        <b> bypass</b> (<Dot tone="success" className="inline align-middle" />) or wait (<Dot tone="danger" className="inline align-middle" />/<Dot tone="orange" className="inline align-middle" />). Push a task alone (<b>Approve</b> → <b>Push to krill</b>) or
        <b> Push batch</b> a whole project in dependency order.
      </p>
      {rejN > 0 && (
        <p className="text-xs text-text-2 mt-1">
          {rejN} rejected hidden ·{" "}
          <button className={ghost} onClick={() => setShowRej((v) => !v)}>{showRej ? "hide" : "show"}</button>
        </p>
      )}
      {show.length === 0 ? (
        <p className="text-text-2 mt-4">Nothing to review yet — dump requests and <b>Plan</b> a project in the Inbox tab.</p>
      ) : (
        groupKeys.map((key) => (
          <div key={key} className="mt-4 border border-border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 py-2 bg-surface-2 border-b border-border">
              <span className="text-sm">
                <b>{key}</b>{" "}
                <span className="text-text-2">
                  · {grouped[key].length} task{grouped[key].length === 1 ? "" : "s"}
                  {pushable(grouped[key]) > 0 ? `, ${pushable(grouped[key])} pushable` : ""}
                </span>
                {readyCount(grouped[key]) > 0 && (
                  <span className="ml-2 inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-success/20 text-success font-medium" title="Unblocked — every dependency is DONE, ready to push to krill now">
                    <CheckCircle2 className="h-3 w-3" /> {readyCount(grouped[key])} ready
                  </span>
                )}
              </span>
              <button
                className={`${subtleBtn} ${dis}`}
                onClick={() => setReview({ tasks: grouped[key].filter((p) => ["proposed", "approved", "push_failed"].includes(p.status)), key, kind: "batch" })}
                disabled={pushable(grouped[key]) === 0 || krillDown}
                title={krillDown ? "krill is down — can't push" : `Push all pushable ${key} tasks to krill (dependency-ordered)`}
              >
                Push batch <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
            {dumpGroups(grouped[key]).map((g) => (
              <div key={g.id} className={`border-b border-border last:border-b-0 ${!collapsedGroups.has(g.id) ? "bg-gray-100" : ""}`}>
                <div className={`flex items-center justify-between gap-2 px-3 py-2 border-l-2 border-l-primary/50 ${collapsedGroups.has(g.id) ? "bg-white" : ""}`}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.id)}
                    className="flex-1 text-xs font-medium text-text min-w-0 truncate inline-flex items-center gap-1 hover:text-primary"
                    title={collapsedGroups.has(g.id) ? "Expand" : "Collapse"}
                  >
                    <span className="shrink-0 text-text-3 inline-flex">{collapsedGroups.has(g.id) ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</span>
                    {g.id === "__none__" ? (
                      "Ungrouped"
                    ) : (
                      <span className="text-xs">{(g.text ?? "dump").slice(0, 90)}</span>
                    )}
                    <span className="text-text-3">· {g.tasks.length} task{g.tasks.length === 1 ? "" : "s"}</span>
                  </button>
                  {g.id !== "__none__" && pushable(g.tasks) > 0 && (
                    <button
                      className={`${subtleBtn} ${dis} shrink-0`}
                      onClick={() => setReview({ tasks: g.tasks.filter((p) => !p.disabled && ["proposed", "approved", "push_failed"].includes(p.status)), key, kind: "group", sourceEntryId: g.id })}
                      disabled={krillDown}
                      title={krillDown ? "krill is down — can't push" : "Push this dump's tasks to krill (dependency-ordered)"}
                    >
                      Push group <ArrowRight className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {!collapsedGroups.has(g.id) && (


                  <ul className="flex-1 divide-y divide-border">
                    {g.tasks.map((p) => {
                      const open = expandedCards.has(p.id);
                      const deps = JSON.parse(p.deps || "[]") as string[];
                      const blocking = blockingDeps(p);
                      const depsCleared = readyForKrill(p);
                      const blockedByDeps = actionable(p) && blocking.length > 0;
                      const blocks = dependents.get(p.name) ?? [];
                      const crossDep = deps.some((d) => nameToDump.get(d) !== (p.source_entry_id ?? "__none__"));
                      const refines = JSON.parse(p.refine_log || "[]").length;
                      return (
                        <li key={p.id} className={`border-l-2 ${riskBorder(p.risk_tier)} ${p.disabled ? "opacity-50" : ""} ${depsCleared ? "bg-success/5" : "bg-white"}`}>
                          {/* collapsed header — one scannable row: ref · label · name · risk · status · primary action */}
                          <div className="flex items-center gap-2 px-3 py-2 pl-7 hover:bg-surface-2/40 transition-colors">
                            <button
                              type="button"
                              onClick={() => toggleCard(p.id)}
                              className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer hover:text-text"
                              title={open ? "Collapse" : "Expand"}
                            >
                              <span className="shrink-0 text-text-3 inline-flex">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</span>
                              <span
                                className={`shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded ${p.krill_task_id ? "bg-info/15 text-info" : "bg-border text-text-2"}`}
                                title={p.krill_task_id ? `krill task ${p.krill_task_id}` : `temp ref (until pushed to krill) · ${p.id}`}
                              >
                                {p.krill_task_id ?? `TEMP-${p.id.slice(0, 4).toUpperCase()}`}
                              </span>
                              {p.label ? (
                                <span className="shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary">{p.label}</span>
                              ) : null}
                              <span className="text-sm font-medium break-words">{p.name}</span>
                            </button>
                            <span className="shrink-0 inline-flex items-center gap-1 text-xs text-text-2 whitespace-nowrap" title={`${p.risk_tier || "?"} risk`}>
                              {riskDot(p.risk_tier)} {p.risk_tier || "?"}
                            </span>
                            {p.status === "pushed" && p.krill_status ? (
                              <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full ${p.krill_status === "DONE" ? "bg-success/20 text-success" : p.krill_status === "CANCELED" ? "bg-muted/20 text-muted" : "bg-info/20 text-info"}`}>
                                {p.krill_status}
                              </span>
                            ) : (
                              <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-border text-text-2">{p.status}</span>
                            )}
                            {p.disabled && <span className="shrink-0 inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full bg-muted/20 text-muted" title="parked"><Pause className="h-3 w-3" /></span>}
                            {depsCleared && (
                              <span className="shrink-0 inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-success/20 text-success font-medium" title={deps.length === 0 ? "No dependencies — ready to push to krill" : `All ${deps.length} ${deps.length === 1 ? "dependency is" : "dependencies are"} DONE — ready to push to krill`}>
                                <CheckCircle2 className="h-3 w-3" /> ready
                              </span>
                            )}
                            {blockedByDeps && (
                              <span className="shrink-0 inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-warning/20 text-warning" title={`Waiting on: ${blocking.join(", ")}`}>
                                <Ban className="h-3 w-3" /> blocked {blocking.length}
                              </span>
                            )}
                            {/* primary action, inline */}
                            {p.disabled ? (
                              <button className={pushBtn} onClick={() => togglePark(p.id, false)} title="Unpark — make it actionable again"><Play className="h-3.5 w-3.5" /></button>
                            ) : p.status === "proposed" ? (
                              <button className={pushBtn} onClick={() => act(p.id, "approve")}>Approve</button>
                            ) : p.status === "approved" ? (
                              <button className={`${pushBtn} ${dis}`} disabled={krillDown} title={krillDown ? "krill is down — can't push" : undefined} onClick={() => setReview({ tasks: [p], key: p.project_key, kind: "single" })}>Push</button>
                            ) : p.status === "push_failed" ? (
                              <button className={`${pushBtn} ${dis}`} disabled={krillDown} title={krillDown ? "krill is down — can't push" : undefined} onClick={() => setReview({ tasks: [p], key: p.project_key, kind: "single" })}>Retry</button>
                            ) : null}
                          </div>
                          {/* expanded detail — description, meta, rationale, secondary actions */}
                          {open && (
                            <div className="p-4 pt-1 pl-8 space-y-4">
                              {p.description && <p className="border border-dashed rounded-md p-3 text-xs text-text-2">{p.description}</p>}
                              <div className="text-xs text-text-2 flex gap-2 flex-wrap items-center">
                                <span className="px-2 rounded-full bg-border">{p.priority}</span>
                                <span className="px-2 rounded-full bg-border">{p.mode}</span>
                                <span className="px-2 rounded-full bg-border">{p.bypass ? "bypass review" : "needs review"}</span>
                                <span className="inline-flex items-center gap-1 px-2 rounded-full bg-info/15 text-info">flow: {flowOf(p)}</span>
                                {deps.length > 0 && (
                                  <span className={`px-2 rounded-full ${crossDep ? "bg-info/15 text-info" : "bg-border"}`} title={`runs after: ${deps.join(", ")}`}>
                                    ← depends on: {renderRefs(deps)}{crossDep ? " · x-dump" : ""}
                                  </span>
                                )}
                                {blocks.length > 0 && (
                                  <span className="px-2 rounded-full bg-border text-text-3" title={`unblocks: ${blocks.join(", ")}`}>
                                    → unblocks: {renderRefs(blocks)}
                                  </span>
                                )}
                              </div>
                              {(p.rationale || p.push_error || refines > 0) && (
                                <div className="text-xs text-text-2">
                                  {p.rationale}
                                  {p.push_error && <span className="inline-flex items-center gap-1">{" · "}<AlertTriangle className="h-3 w-3 text-danger" /> {p.push_error}</span>}
                                  {refines > 0 && (
                                    <span className="inline-flex items-center gap-0.5">{" · "}<Pencil className="h-3 w-3" /> refined {refines}×</span>
                                  )}
                                </div>
                              )}
                              <div className="flex gap-2 flex-wrap">
                                {!p.disabled && p.status === "proposed" && (
                                  <button className={dangerSm} onClick={() => act(p.id, "reject")}>Reject</button>
                                )}
                                {!p.disabled && p.status !== "pushed" && p.status !== "rejected" && (
                                  <>
                                    <button className={subtleBtn} onClick={() => refine(p.id)}>Input</button>
                                    <button className={subtleBtn} onClick={() => reassign(p.id)}>Reassign</button>
                                    <button className={subtleBtn} onClick={() => togglePark(p.id, true)} title="Park — can't handle now; dim it and exclude from pushes"><Pause className="h-3 w-3" /> Park</button>
                                  </>
                                )}
                                <button className={dangerSm} onClick={() => del(p.id)}>
                                  <Trash2 className="h-3.5 w-3.5" /> delete
                                </button>
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>

                )}
              </div>
            ))}
          </div>
        ))
      )}
      {review && (
        <PushReview
          open
          tasks={review.tasks}
          projectKey={review.key}
          busy={sending}
          onCancel={() => setReview(null)}
          onConfirm={sendReview}
        />
      )}
    </section>
  );
}

/* ---------- Settings: copy + the dial→outcome model ---------- */

const DIALS = [
  { id: "conservative", label: "Conservative", blurb: "Nothing skips you. Every proposed task waits for your plan review before krill builds it." },
  { id: "balanced", label: "Balanced", blurb: "Trivial work flows on its own; anything with real risk still waits for your review." },
  { id: "aggressive", label: "Aggressive", blurb: "Trivial work runs all the way to merged, unattended. Medium risk skips plan review. High risk still waits." },
  { id: "autonomous", label: "Autonomous", blurb: "Trusted routine work — low AND medium — runs to merged, unattended. High risk (migrations, auth, deploy, payments) still waits for your plan review. Self-edit always waits." },
  { id: "ludicrous", label: "Ludicrous", blurb: "Every tier — including high risk — runs to merged, unattended. Only self-edit (whale/krill) still stops you. Needs allow_auto_finish on the krill project, or tasks stop at review (whale warns)." },
] as const;

type Outcome = "review" | "bypass" | "auto";
const OUTCOME: Record<Outcome, { tone: keyof typeof DOT; label: string; note: string; cls: string }> = {
  review: { tone: "danger", label: "Human review", note: "Holds in Proposed until you approve the plan", cls: "text-info border-info/40 bg-info/10" },
  bypass: { tone: "warning", label: "Skip plan review", note: "Auto-plans & builds; you review the finished deliverable", cls: "text-warning border-warning/40 bg-warning/10" },
  auto: { tone: "success", label: "Auto-finish", note: "Runs to DONE and merges to main — no review at all", cls: "text-success border-success/40 bg-success/10" },
};

const TIERS = [
  { id: "low", label: "Low", eg: "typo · rename · docs · comment · lint · copy" },
  { id: "medium", label: "Medium", eg: "most feature work — the default tier" },
  { id: "high", label: "High", eg: "delete · migration · schema · deploy · auth · payment · security — plus safe-words, new projects, and anything targeting whale/krill" },
] as const;

// Mirrors triage() in stages.ts. Ludicrous auto-finishes every tier (self-edit
// excepted — see the protected-projects note below). Otherwise high always
// reviews and the dial only moves low/medium.
function outcomeFor(dial: string, tier: string): Outcome {
  if (dial === "ludicrous") return "auto";
  if (dial === "autonomous") return tier === "high" ? "review" : "auto"; // low+medium auto
  if (tier === "high") return "review";
  if (tier === "low") return dial === "aggressive" ? "auto" : dial === "balanced" ? "bypass" : "review";
  return dial === "aggressive" ? "bypass" : "review"; // medium
}

function SettingCard({ title, kicker, children }: { title: string; kicker?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/60 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-text">{title}</h4>
        {kicker ? <p className="text-xs text-text-2 leading-relaxed mt-1">{kicker}</p> : null}
      </div>
      {children}
    </div>
  );
}

function ToggleRow({ on, onChange, title, desc, tone = "primary" }: {
  on: boolean; onChange: (v: boolean) => void; title: string; desc: React.ReactNode; tone?: "primary" | "warning";
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <span className={`mt-0.5 relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${on ? (tone === "warning" ? "bg-warning" : "bg-primary") : "bg-border-strong"}`}>
        <input type="checkbox" className="sr-only" checked={on} onChange={(e) => onChange(e.target.checked)} />
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-[18px]" : "translate-x-0.5"}`} />
      </span>
      <span className="min-w-0">
        <span className="text-sm text-text">{title}</span>
        <span className="block text-xs text-text-2 leading-relaxed mt-0.5">{desc}</span>
      </span>
    </label>
  );
}

const MODEL_NOTE: Record<string, string> = {
  haiku: "fastest · cheapest",
  sonnet: "balanced",
  opus: "deepest · slowest · priciest",
};

function SettingsTab({ withBusy, onSaved, rev }: { withBusy: Busy; onSaved: () => void; rev: number }) {
  const [c, setC] = useState<ConfigSnap | null>(null);
  const { push } = useToast();
  const load = useCallback(async () => setC(await j("/api/config")), []);
  useEffect(() => {
    load();
  }, [load, rev]);

  if (!c) return <p className="text-text-2">loading…</p>;

  const save = async (patch: Record<string, unknown>) => {
    const r = await withBusy("Saving settings", j("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }));
    if (r.error) {
      push({ variant: "danger", title: "Save failed", description: r.error });
    } else {
      setC(r);
      onSaved();
      push({ variant: "success", title: "Saved — applied live" });
    }
  };

  const M = ["haiku", "sonnet", "opus"];
  const activeDial = DIALS.find((d) => d.id === c.autonomy.bypass) ?? DIALS[0];

  return (
    <section className="space-y-4">
      <p className={hint}>
        How much whale does on its own. Changes save to whale&apos;s DB and apply <b>live</b> — no restart.
      </p>

      {/* ---- The autonomy dial: the one setting that decides how much runs without you ---- */}
      <SettingCard
        title="Autonomy dial"
        kicker="How far a proposed task travels before it needs you. whale scores each task's risk, then this dial decides what that risk is allowed to skip."
      >
        <div className="inline-flex rounded-lg border border-border-strong overflow-hidden font-mono text-sm">
          {DIALS.map((d) => {
            const on = c.autonomy.bypass === d.id;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => save({ bypass: d.id })}
                className={`px-3.5 py-2 transition-colors ${on ? "bg-primary text-white" : "bg-surface text-text-2 hover:text-text"} ${d.id !== "conservative" ? "border-l border-border-strong" : ""}`}
              >
                {d.label}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-text-2 leading-relaxed mt-2.5">{activeDial.blurb}</p>

        {/* outcome matrix: risk tier × dial → what happens */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="text-left font-medium text-text-3 p-2 w-[34%]">If a task is…</th>
                {DIALS.map((d) => (
                  <th key={d.id} className={`p-2 text-left font-medium ${c.autonomy.bypass === d.id ? "text-primary" : "text-text-3"}`}>
                    {d.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TIERS.map((t) => (
                <tr key={t.id} className="border-t border-border align-top">
                  <td className="p-2">
                    <div className="text-text font-medium">{t.label} risk</div>
                    <div className="text-text-3 text-[11px] leading-snug mt-0.5">{t.eg}</div>
                  </td>
                  {DIALS.map((d) => {
                    const o = OUTCOME[outcomeFor(d.id, t.id)];
                    const active = c.autonomy.bypass === d.id;
                    return (
                      <td key={d.id} className="p-1.5">
                        <div className={`rounded-md border px-2 py-1.5 transition-opacity ${o.cls} ${active ? "ring-1 ring-current" : "opacity-40"}`}>
                          <span className="inline-flex items-center gap-1 font-medium whitespace-nowrap"><Dot tone={o.tone} /> {o.label}</span>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* legend */}
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
          {(Object.keys(OUTCOME) as Outcome[]).map((k) => (
            <div key={k} className="flex items-start gap-1.5 text-[11px] text-text-2 leading-snug">
              <span className="inline-flex items-center pt-0.5"><Dot tone={OUTCOME[k].tone} /></span>
              <span><b className="text-text">{OUTCOME[k].label}</b> — {OUTCOME[k].note}</span>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-text-3 mt-3 border-t border-border pt-2.5">
          <b className="text-text-2">High risk and anything targeting whale/krill always wait for you</b> — the dial can never auto-merge those. That&apos;s the self-edit guard below.
        </p>
      </SettingCard>

      {/* ---- Push + new-project gates ---- */}
      <SettingCard title="Gates">
        <div className="space-y-4">
          <ToggleRow
            on={c.autonomy.autoPush}
            onChange={(v) => save({ auto_push: v })}
            title="Auto-push approved tasks"
            desc="On: approving a proposed task sends it to krill immediately. Off: approve, then push by hand — a second checkpoint before work leaves whale."
          />
          <ToggleRow
            on={c.autonomy.allowNewProjects}
            onChange={(v) => save({ allow_new_projects: v })}
            title="Allow proposing new projects"
            desc="On: the router may route an idea to a brand-new project. Even then it's held for you — a new project is always high-risk and never auto-created."
          />
          <ToggleRow
            on={c.autonomy.planFileAccess}
            onChange={(v) => save({ plan_file_access: v })}
            title="Planning can read the repo"
            desc="On: the planner gets read-only access (Read/Grep/Glob) to the project's folder, so requests that reference files (“read docs/X.md”) work. Off: prompt-only planning."
          />
        </div>
      </SettingCard>

      {/* ---- Engine: runner + models ---- */}
      <SettingCard
        title="Engine"
        kicker="What runs the thinking. Stub fakes outputs for wiring/tests; Real spawns the Claude Code CLI."
      >
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-text-2">Runner</span>
            <NativeSelect value={c.runner} onChange={(e) => save({ runner: e.target.value })}>
              {["stub", "real"].map((o) => <option key={o}>{o}</option>)}
            </NativeSelect>
          </label>
          {([
            { m: "plan" as const, role: "Plan", desc: "decomposes requests → tasks (Augusto + Maria)" },
            { m: "route" as const, role: "Route", desc: "classifies an inbox entry → its destination" },
          ]).map(({ m, role, desc }) => (
            <label key={m} className="flex flex-col gap-1.5">
              <span className="text-xs text-text-2">{role} model <span className="text-text-3">· {desc}</span></span>
              <div className="flex items-center gap-2">
                <NativeSelect value={c.models[m]} onChange={(e) => save({ [`model_${m}`]: e.target.value })}>
                  {M.map((o) => <option key={o}>{o}</option>)}
                </NativeSelect>
                <span className="text-[11px] text-text-3 font-mono">{MODEL_NOTE[c.models[m]]}</span>
              </div>
            </label>
          ))}
        </div>
      </SettingCard>

      {/* ---- Env-locked safety floor ---- */}
      <SettingCard
        title="Safety floor"
        kicker="Set by environment, not editable here — a no-auth LAN UI must not be able to weaken its own brakes."
      >
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-danger/15 text-danger font-mono">
            <Lock className="h-3 w-3" /> self-edit guard: {c.envLocked.protected.join(", ")}
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-border text-text-2 font-mono">
            krill: {c.envLocked.krillUrl}
          </span>
        </div>
        <p className="text-[11px] text-text-3 leading-relaxed mt-2.5">
          Tasks targeting these projects are forced to human review and can never bypass — that&apos;s how whale edits itself without a runaway loop.
        </p>
      </SettingCard>
    </section>
  );
}
