"use client";

import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Circle,
  Trash2,
  ArrowRight,
  Pencil,
  Sun,
  Moon,
  RotateCw,
  ChevronDown,
  Inbox as InboxIcon,
  BookOpen,
  ListChecks,
  Settings as SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog-provider";
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
  autonomy: { bypass: string; autoPush: boolean; allowNewProjects: boolean };
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

function flowOf(p: ProposedTask): string {
  if (p.risk_tier === "high") return "🔴 full review";
  if (p.auto_publish) return "🟢 auto-finish→DONE";
  if (p.bypass) return "🟡 →deliverable";
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
    } catch {}
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
    es.onerror = () => {}; // browser auto-reconnects
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
                className={`group relative w-full flex items-center gap-2.5 pl-3.5 pr-2.5 py-2 rounded-lg text-sm transition-colors ${
                  on ? "bg-surface text-text" : "text-text-2 hover:text-text hover:bg-surface/60"
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
          {/* keep all tabs mounted (hidden) so typed text / selections survive a tab
              switch, like the original display:none UI. Polling is gated by `active`. */}
          <div hidden={tab !== "inbox"}>
            <InboxTab withBusy={withBusy} onChange={loadStatus} active={tab === "inbox"} rev={rev} jobs={jobs} />
          </div>
          <div hidden={tab !== "context"}>
            <ContextTab withBusy={withBusy} rev={rev} jobs={jobs} />
          </div>
          <div hidden={tab !== "proposed"}>
            <ProposedTab withBusy={withBusy} onChange={loadStatus} active={tab === "proposed"} rev={rev} />
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
                    <div className="text-xs text-text-2 mt-1.5 flex gap-2 flex-wrap items-center">
                      <span className={`px-2 rounded-full ${e.status === "raw" ? "bg-warning/20 text-warning" : "bg-success/20 text-success"}`}>
                        {e.status === "raw" ? "pending" : e.status}
                      </span>
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
  const [available, setAvailable] = useState<string[]>([]);
  const [obk, setObk] = useState("");
  const [seedMd, setSeedMd] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [md, setMd] = useState("");
  const { push } = useToast();
  const dlg = useDialog();

  const load = useCallback(async () => {
    const k: string[] = (await j("/api/context")).keys || [];
    setKeys(k);
    const ps: string[] = (await j("/api/projects")).projects || [];
    setAvailable(ps.filter((p) => !k.includes(p))); // krill projects not yet onboarded
  }, []);
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
        Per-project <b>background context</b>. <b>Onboard</b> = read-only audit of the repo; or <b>paste</b> context
        to seed it by hand (idea projects with no repo). It <b>grounds Plan</b> — it&apos;s not where tasks live
        (those are requests in Inbox). <b>Audit ↻</b> re-runs the repo audit.
      </p>
      <div className="space-y-2.5">
        <input
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
          <p className="text-xs text-text-2 mb-1.5">krill projects not onboarded yet — click to audit:</p>
          <div className="flex gap-2 flex-wrap">
            {available.map((p) => (
              <button key={p} className={`${ghost} !px-2.5 !py-1.5 text-sm inline-flex items-center gap-1 disabled:opacity-40`} onClick={() => audit(p)} disabled={isJob("onboard", p)}>
                {isJob("onboard", p) ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> auditing {p}…</> : <>+ {p}</>}
              </button>
            ))}
          </div>
        </div>
      )}
      {keys.length === 0 ? (
        <p className="text-text-2 mt-4">No context yet. Onboard a project above to build its background.</p>
      ) : (
        <>
          <h3 className="mt-4 mb-2 text-text-2 text-xs uppercase tracking-wide">onboarded projects</h3>
          <div className="flex gap-2 flex-wrap">
            {keys.map((k) => (
              <span key={k} className="inline-flex items-center border border-border rounded-lg bg-surface-2">
                <button className="px-2.5 py-1.5 text-sm text-text hover:text-primary" onClick={() => view(k)}>{k}</button>
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

type EnrichedTask = ProposedTask & { krill_status?: string | null };

function ProposedTab({ withBusy, onChange, active, rev }: { withBusy: Busy; onChange: () => void; active: boolean; rev: number }) {
  const [items, setItems] = useState<EnrichedTask[]>([]);
  const [showRej, setShowRej] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const { push } = useToast();
  const dlg = useDialog();

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
      if (!(await dlg.confirm({ title: "⚠ Arm auto-finish", description: r.message, confirmLabel: "Arm", confirmVariant: "danger" }))) return load();
      r = await withBusy(action, post(`/api/proposed/${id}/${action}`, { confirm: true }));
    }
    if (r.error) push({ variant: "danger", title: "Failed", description: r.error });
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
  const pushBatch = async (key: string) => {
    let r = await withBusy(`Pushing ${key} to krill`, post("/api/proposed/push-batch", { key }));
    if (r.needsConfirm) {
      if (!(await dlg.confirm({ title: "⚠ Arm auto-finish", description: r.message, confirmLabel: "Arm", confirmVariant: "danger" }))) return load();
      r = await withBusy(`Pushing ${key} to krill`, post("/api/proposed/push-batch", { key, confirm: true }));
    }
    if (r.ok) push({ variant: "success", title: `Pushed ${r.pushed}/${r.total || r.pushed} to krill` });
    else push({ variant: "danger", title: "Batch push failed", description: r.error });
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
    list.filter((p) => ["proposed", "approved", "push_failed"].includes(p.status)).length;
  const dis = "disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <section>
      <p className={hint}>
        The review gate, <b>grouped by project</b>. Each task shows <b>risk</b> + whether it&apos;ll
        <b> bypass</b> (🟢) or wait (🔴/🟡). Push a task alone (<b>Approve</b> → <b>Push to krill</b>) or
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
              </span>
              <button
                className={`${actBtn} ${dis} inline-flex items-center gap-1 !px-3 !py-1.5`}
                onClick={() => pushBatch(key)}
                disabled={pushable(grouped[key]) === 0}
                title={`Push all pushable ${key} tasks to krill (dependency-ordered)`}
              >
                Push batch <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <ul className="divide-y divide-border">
              {grouped[key].map((p) => (
                <li key={p.id} className="px-3 py-2.5">
                  <b>{p.name}</b>
                  {p.description && <div className="text-xs text-text-2 mt-1">{p.description}</div>}
                  <div className="text-xs text-text-2 mt-1.5 flex gap-2 flex-wrap items-center">
                    <span className={`px-2 rounded-full ${p.risk_tier === "high" ? "bg-danger/20 text-danger" : p.risk_tier === "low" ? "bg-success/20 text-success" : "bg-warning/20 text-warning"}`}>
                      {p.risk_tier || "?"} risk
                    </span>
                    <span className="px-2 rounded-full bg-border">{p.priority}</span>
                    <span className="px-2 rounded-full bg-border">{p.mode}</span>
                    <span className="px-2 rounded-full bg-border">{p.bypass ? "bypass review" : "needs review"}</span>
                    <span className="px-2 rounded-full bg-border">{p.status}</span>
                    <span className="px-2 rounded-full bg-info/15 text-info">flow: {flowOf(p)}</span>
                    {p.status === "pushed" && p.krill_status && (
                      <span className={`px-2 rounded-full ${p.krill_status === "DONE" ? "bg-success/20 text-success" : p.krill_status === "CANCELED" ? "bg-muted/20 text-muted" : "bg-info/20 text-info"}`}>
                        krill: {p.krill_status}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-2 mt-1">
                    {p.rationale}
                    {p.push_error && ` · ⚠ ${p.push_error}`}
                    {JSON.parse(p.refine_log || "[]").length > 0 && (
                      <span className="inline-flex items-center gap-0.5">{" · "}<Pencil className="h-3 w-3" /> refined {JSON.parse(p.refine_log).length}×</span>
                    )}
                  </div>
                  <div className="flex gap-2 mt-2 flex-wrap">
                    {p.status === "proposed" && (
                      <>
                        <button className={actBtn} onClick={() => act(p.id, "approve")}>Approve</button>
                        <button className={danger} onClick={() => act(p.id, "reject")}>Reject</button>
                      </>
                    )}
                    {p.status === "approved" && <button className={actBtn} onClick={() => act(p.id, "push")}>Push to krill</button>}
                    {p.status === "push_failed" && <button className={actBtn} onClick={() => act(p.id, "push")}>Retry push</button>}
                    {p.status !== "pushed" && p.status !== "rejected" && (
                      <>
                        <button className={ghost} onClick={() => refine(p.id)}>Input</button>
                        <button className={ghost} onClick={() => reassign(p.id)}>Reassign</button>
                      </>
                    )}
                    <button className={`${danger} inline-flex items-center gap-1`} onClick={() => del(p.id)}>
                      <Trash2 className="h-3.5 w-3.5" /> delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

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

  return (
    <section>
      <p className={hint}>
        Runtime dials — saved to whale&apos;s DB, applied <b>live</b> (no restart). The <b>self-edit guard</b> is
        env-only and read-only here: a no-auth LAN UI must not weaken it.
      </p>
      <h3 className="mt-4 mb-2 text-text-2 text-xs uppercase tracking-wide">runner</h3>
      <NativeSelect value={c.runner} onChange={(e) => save({ runner: e.target.value })}>
        {["stub", "real"].map((o) => <option key={o}>{o}</option>)}
      </NativeSelect>
      <h3 className="mt-4 mb-2 text-text-2 text-xs uppercase tracking-wide">models</h3>
      <div className="flex gap-2 flex-wrap items-center">
        {(["plan", "route"] as const).map((m) => (
          <label key={m} className="flex items-center gap-1.5">
            {m}
            <NativeSelect value={c.models[m]} onChange={(e) => save({ [`model_${m}`]: e.target.value })}>
              {M.map((o) => <option key={o}>{o}</option>)}
            </NativeSelect>
          </label>
        ))}
      </div>
      <h3 className="mt-4 mb-2 text-text-2 text-xs uppercase tracking-wide">autonomy</h3>
      <label className="flex items-center gap-1.5">
        bypass
        <NativeSelect value={c.autonomy.bypass} onChange={(e) => save({ bypass: e.target.value })}>
          {["conservative", "balanced", "aggressive"].map((o) => <option key={o}>{o}</option>)}
        </NativeSelect>
      </label>
      <label className="flex items-center gap-2 mt-3">
        <input type="checkbox" checked={c.autonomy.autoPush} onChange={(e) => save({ auto_push: e.target.checked })} />
        auto-push approved tasks
      </label>
      <label className="flex items-center gap-2 mt-2">
        <input type="checkbox" checked={c.autonomy.allowNewProjects} onChange={(e) => save({ allow_new_projects: e.target.checked })} />
        allow proposing new projects
      </label>
      <h3 className="mt-4 mb-2 text-text-2 text-xs uppercase tracking-wide">env-locked (read-only)</h3>
      <div className="text-xs text-text-2 flex gap-2 flex-wrap">
        <span className="px-2 py-1 rounded-full bg-danger/15 text-danger">self-edit guard: {c.envLocked.protected.join(", ")}</span>
        <span className="px-2 py-1 rounded-full bg-border">krill: {c.envLocked.krillUrl}</span>
      </div>
    </section>
  );
}
