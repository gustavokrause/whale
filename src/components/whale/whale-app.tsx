"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Circle, Trash2, ArrowRight, Pencil, Sun, Moon, RotateCw } from "lucide-react";
import { useToast } from "@/components/ui/toast";
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

  return (
    <div>
      {busy > 0 && <div className="fixed top-0 left-0 h-0.5 w-[30%] bg-primary animate-[ind_1.1s_linear_infinite] z-10" />}
      <header className="px-5 py-3 border-b border-border flex flex-wrap items-center gap-x-3">
        <b className="text-lg inline-flex items-center gap-1.5">
          <WhaleIcon className="h-5 w-5 text-primary" /> whale
        </b>
        {status ? (
          <span className="text-xs text-text-2 inline-flex items-center gap-1">
            runner={status.runner} · bypass={status.autonomy.bypass} · autoPush={String(status.autonomy.autoPush)} · krill
            <Circle className={`h-2.5 w-2.5 ${status.krill.up ? "fill-success text-success" : "fill-danger text-danger"}`} />
            · inbox {status.inbox.raw}/{status.inbox.total} · proposed {status.proposed.total}
          </span>
        ) : (
          <span className="text-xs text-text-2">…</span>
        )}
        {busy > 0 && (
          <span className="text-xs text-warning inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> {busyLabel}…
          </span>
        )}
        <button onClick={toggleTheme} className="ml-auto p-1.5 rounded-lg text-text-2 hover:text-text" title="Toggle dark/light">
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </header>

      <div className="max-w-3xl mx-auto px-5 pt-3">
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => go(t)}
              className={`px-4 py-2 rounded-t-lg text-sm capitalize border border-b-0 ${
                tab === t
                  ? "border-border text-text bg-gradient-to-b from-primary/20 to-white dark:bg-none dark:bg-surface dark:text-text -mb-px relative z-10"
                  : "text-text-2 border-transparent hover:text-text"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>

        <main className="border border-border rounded-b-lg bg-bg dark:bg-surface p-5">
        {/* keep all tabs mounted (hidden) so typed text / selections survive a tab
            switch, like the original display:none UI. Polling is gated by `active`. */}
        <div hidden={tab !== "inbox"}>
          <InboxTab withBusy={withBusy} onChange={loadStatus} active={tab === "inbox"} rev={rev} />
        </div>
        <div hidden={tab !== "context"}>
          <ContextTab withBusy={withBusy} rev={rev} />
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

function InboxTab({ withBusy, onChange, active, rev }: { withBusy: Busy; onChange: () => void; active: boolean; rev: number }) {
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [text, setText] = useState("");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const { push } = useToast();

  const load = useCallback(async () => {
    setEntries((await j("/api/inbox")).entries);
    const ps: string[] = (await j("/api/projects")).projects || [];
    setProjects(ps);
    setProject((p) => p || ps[0] || "");
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(() => active && !document.hidden && load(), 5000);
    return () => clearInterval(id);
  }, [load, active, rev]);

  const dump = async () => {
    if (!text.trim() || !project) return;
    await withBusy("Saving request", post("/api/inbox", { text: text.trim(), project_hint: project }));
    setText("");
    load();
    onChange();
  };
  const planProject = async (key: string) => {
    if (!key) return;
    const r = await withBusy(`Planning ${key} (real Claude)`, post("/api/plan", { key }));
    push({ variant: "success", title: `Proposed ${(r.proposed || []).length} task(s) for ${key}`, description: "Review in the Proposed tab" });
    load();
    onChange();
  };
  const del = async (id: string) => {
    if (!confirm("Delete this request permanently?")) return;
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
        Dump <b>work requests</b> for a project (⌘/Ctrl-Enter) — each is queued as <i>pending</i>. Then
        <b> Plan</b> (below) turns <b>all</b> of a project&apos;s pending requests into proposed tasks, grounded
        by its Context. Onboard a project in the <b>Context</b> tab first.
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
        <select
          value={project}
          onChange={(e) => setProject(e.target.value)}
          className="px-3 py-2.5 bg-surface text-text border border-border-strong rounded-lg font-mono min-w-[160px]"
        >
          {projects.length === 0 && <option value="">(no projects — onboard one)</option>}
          {projects.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <button className={`${actBtn} ${dis}`} onClick={dump} disabled={!project}>
          Dump request
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="text-text-2 mt-4">No requests yet — dump one above.</p>
      ) : (
        groupKeys.map((p) => (
          <div key={p} className="mt-4 border border-border rounded-lg overflow-hidden">
            {/* per-project group: requests + its own Plan (acts on this project's pending) */}
            <div className="flex items-center justify-between gap-2 px-3 py-2 bg-surface-2 border-b border-border">
              <span className="text-sm">
                <b>{p}</b> <span className="text-text-2">· {pendingIn(grouped[p])} pending</span>
              </span>
              <button
                className={`${actBtn} ${dis} inline-flex items-center gap-1 !px-3 !py-1.5`}
                onClick={() => planProject(p)}
                disabled={pendingIn(grouped[p]) === 0}
                title={`Plan all pending requests for ${p}`}
              >
                Plan <ArrowRight className="h-3.5 w-3.5" />
              </button>
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
                    <button className={`${danger} inline-flex items-center !px-2 !py-1`} title="Delete request" onClick={() => del(e.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
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

function ContextTab({ withBusy, rev }: { withBusy: Busy; rev: number }) {
  const [keys, setKeys] = useState<string[]>([]);
  const [obk, setObk] = useState("");
  const [seedMd, setSeedMd] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [md, setMd] = useState("");
  const { push } = useToast();

  const load = useCallback(async () => setKeys((await j("/api/context")).keys), []);
  useEffect(() => {
    load();
  }, [load, rev]);

  const view = async (k: string) => {
    setSel(k);
    setMd((await j(`/api/context?key=${encodeURIComponent(k)}`)).md || "(empty)");
  };
  const audit = async (key: string, refresh = false) => {
    if (!key) return;
    const r = await withBusy(`${refresh ? "Auditing" : "Onboarding"} ${key} (real Claude — 1-3 min)`, post("/api/onboard", { key }));
    if (r.ok) push({ variant: "success", title: `${refresh ? "Refreshed" : "Onboarded"} ${r.key}`, description: `${r.chars} chars of context` });
    else push({ variant: "danger", title: "Audit failed", description: r.note || r.error });
    load();
    if (sel === key) view(key);
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
      {keys.length === 0 ? (
        <p className="text-text-2 mt-4">No context yet. Onboard a project above to build its background.</p>
      ) : (
        <>
          <h3 className="mt-4 mb-2 text-text-2 text-xs uppercase tracking-wide">onboarded projects</h3>
          <div className="flex gap-2 flex-wrap">
            {keys.map((k) => (
              <span key={k} className="inline-flex items-center border border-border rounded-lg bg-surface-2">
                <button className="px-2.5 py-1.5 text-sm text-text hover:text-primary" onClick={() => view(k)}>{k}</button>
                <button className="px-2 py-1.5 text-text-2 hover:text-text border-l border-border" title="Re-audit (refresh context)" onClick={() => audit(k, true)}>
                  <RotateCw className="h-3.5 w-3.5" />
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
  const [batchKey, setBatchKey] = useState("");
  const { push } = useToast();

  // ?sync=1 reads back live krill status for pushed tasks (Gap A — no more stale rows)
  const load = useCallback(async () => setItems((await j("/api/proposed?sync=1")).proposed), []);
  useEffect(() => {
    load();
    const id = setInterval(() => active && !document.hidden && load(), 5000);
    return () => clearInterval(id);
  }, [load, active, rev]);

  const act = async (id: string, action: string) => {
    let r = await withBusy(action, post(`/api/proposed/${id}/${action}`));
    if (r.needsConfirm) {
      if (!confirm(`⚠ ARM AUTO-FINISH\n\n${r.message}`)) return load();
      r = await withBusy(action, post(`/api/proposed/${id}/${action}`, { confirm: true }));
    }
    if (r.error) push({ variant: "danger", title: "Failed", description: r.error });
    else if (r.note) push({ variant: "info", title: r.note });
    load();
    onChange();
  };
  const refine = async (id: string) => {
    const input = prompt("Input — what should change about this task?");
    if (!input) return;
    const r = await withBusy("Refining task (real Claude)", post(`/api/proposed/${id}/refine`, { input }));
    if (r.error) push({ variant: "danger", title: "Refine failed", description: r.error });
    else push({ variant: "success", title: `Refined → ${r.task.name}`, description: `flow: ${r.flow}` });
    load();
  };
  const reassign = async (id: string) => {
    const k = prompt("Reassign to which project? (e.g. whale, krill, arqtrack)");
    if (!k) return;
    const r = await withBusy("Reassigning + re-triaging", post(`/api/proposed/${id}/reassign`, { project_key: k.trim() }));
    if (r.error) push({ variant: "danger", title: "Reassign failed", description: r.error });
    load();
  };
  const del = async (id: string) => {
    if (!confirm("Delete this proposal permanently?\n(whale-local — does not touch krill.)")) return;
    await withBusy("Deleting", j(`/api/proposed/${id}`, { method: "DELETE" }));
    load();
    onChange();
  };
  const pushBatch = async () => {
    if (!batchKey.trim()) return;
    let r = await withBusy("Pushing batch to krill", post("/api/proposed/push-batch", { key: batchKey.trim() }));
    if (r.needsConfirm) {
      if (!confirm(`⚠ ARM AUTO-FINISH\n\n${r.message}`)) return load();
      r = await withBusy("Pushing batch to krill", post("/api/proposed/push-batch", { key: batchKey.trim(), confirm: true }));
    }
    if (r.ok) push({ variant: "success", title: `Pushed ${r.pushed}/${r.total || r.pushed} to krill` });
    else push({ variant: "danger", title: "Batch push failed", description: r.error });
    load();
  };

  const rejN = items.filter((p) => p.status === "rejected").length;
  const show = showRej ? items : items.filter((p) => p.status !== "rejected");

  return (
    <section>
      <p className={hint}>
        The review gate. Each task shows <b>risk</b> + whether it&apos;ll <b>bypass</b> (🟢) or wait (🔴/🟡).
        <b> Approve</b> → <b>Push</b>, or <b>Push batch</b> for a whole project in dependency order.
      </p>
      <div className="flex gap-2.5 flex-wrap">
        <input
          value={batchKey}
          onChange={(e) => setBatchKey(e.target.value)}
          placeholder="project key for batch push"
          className="flex-1 min-w-[160px] px-3 py-2.5 bg-surface text-text border border-border-strong rounded-lg font-mono"
        />
        <button className={`${actBtn} inline-flex items-center gap-1`} onClick={pushBatch}>
          Push batch <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
      {rejN > 0 && (
        <p className="text-xs text-text-2 mt-3">
          {rejN} rejected hidden ·{" "}
          <button className={ghost} onClick={() => setShowRej((v) => !v)}>{showRej ? "hide" : "show"}</button>
        </p>
      )}
      {show.length === 0 ? (
        <p className="text-text-2 mt-4">Nothing to review yet — dump requests and <b>Plan</b> a project in the Inbox tab.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {show.map((p) => (
            <li key={p.id} className="p-3 border border-border rounded-lg bg-surface-2">
              <b>{p.name}</b>
              {p.description && <div className="text-xs text-text-2 mt-1">{p.description}</div>}
              <div className="text-xs text-text-2 mt-1.5 flex gap-2 flex-wrap items-center">
                <span className={`px-2 rounded-full ${p.risk_tier === "high" ? "bg-danger/20 text-danger" : p.risk_tier === "low" ? "bg-success/20 text-success" : "bg-warning/20 text-warning"}`}>
                  {p.risk_tier || "?"} risk
                </span>
                <span className="px-2 rounded-full bg-border">{p.priority}</span>
                <span className="px-2 rounded-full bg-border">{p.mode}</span>
                <span className="px-2 rounded-full bg-border">{p.bypass ? "bypass review" : "needs your review"}</span>
                <span className="px-2 rounded-full bg-border">{p.status}</span>
                <span className="px-2 rounded-full bg-border">{p.project_key}</span>
                <span className="px-2 rounded-full bg-info/15 text-info">flow: {flowOf(p)}</span>
                {p.status === "pushed" && p.krill_status && (
                  <span
                    className={`px-2 rounded-full ${
                      p.krill_status === "DONE"
                        ? "bg-success/20 text-success"
                        : p.krill_status === "CANCELED"
                          ? "bg-muted/20 text-muted"
                          : "bg-info/20 text-info"
                    }`}
                  >
                    krill: {p.krill_status}
                  </span>
                )}
              </div>
              <div className="text-xs text-text-2 mt-1">
                {p.rationale}
                {p.push_error && ` · ⚠ ${p.push_error}`}
                {JSON.parse(p.refine_log || "[]").length > 0 && (
                  <span className="inline-flex items-center gap-0.5">
                    {" · "}
                    <Pencil className="h-3 w-3" /> refined {JSON.parse(p.refine_log).length}×
                  </span>
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

  const sel = "px-3 py-2.5 bg-surface text-text border border-border-strong rounded-lg font-mono";
  const M = ["haiku", "sonnet", "opus"];

  return (
    <section>
      <p className={hint}>
        Runtime dials — saved to whale&apos;s DB, applied <b>live</b> (no restart). The <b>self-edit guard</b> is
        env-only and read-only here: a no-auth LAN UI must not weaken it.
      </p>
      <h3 className="mt-4 mb-2 text-text-2 text-xs uppercase tracking-wide">runner</h3>
      <select className={sel} value={c.runner} onChange={(e) => save({ runner: e.target.value })}>
        {["stub", "real"].map((o) => <option key={o}>{o}</option>)}
      </select>
      <h3 className="mt-4 mb-2 text-text-2 text-xs uppercase tracking-wide">models</h3>
      <div className="flex gap-2 flex-wrap items-center">
        {(["plan", "route"] as const).map((m) => (
          <label key={m} className="flex items-center gap-1.5">
            {m}
            <select className={sel} value={c.models[m]} onChange={(e) => save({ [`model_${m}`]: e.target.value })}>
              {M.map((o) => <option key={o}>{o}</option>)}
            </select>
          </label>
        ))}
      </div>
      <h3 className="mt-4 mb-2 text-text-2 text-xs uppercase tracking-wide">autonomy</h3>
      <label className="flex items-center gap-1.5">
        bypass
        <select className={sel} value={c.autonomy.bypass} onChange={(e) => save({ bypass: e.target.value })}>
          {["conservative", "balanced", "aggressive"].map((o) => <option key={o}>{o}</option>)}
        </select>
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
