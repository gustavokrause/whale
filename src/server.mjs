// whale — server. Capture inbox + distiller + planner + triage + router + krill push.
// Built-in http, zero deps. Loads the persona team from ai-team (read-only).
//
// Run:  npm start    Env: WHALE_PORT(4100) WHALE_RUNNER(stub|real) KRILL_URL PERSONAS_DIR

import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { config, setConfigOverrides, configSnapshot } from "./config.mjs";
import { openDb, addEntry, listEntries, rawEntries, readConfig, writeConfig, deleteEntry, deleteProposed } from "./db.mjs";
import { listProposed } from "./db.mjs";
import { ping as krillPing } from "./krill-client.mjs";
import { loadTeam } from "./persona-loader.mjs";
import { readContext, listContextKeys } from "./context-store.mjs";
import { distillAll, planProject, approve, reject, push, routeEntry, reassign, onboard, pushBatch, refine } from "./pipeline.mjs";
import { PAGE } from "./ui.mjs";

const PORT = Number(process.env.WHALE_PORT || 4100);
const DB_PATH = process.env.WHALE_DB || path.resolve(process.cwd(), "data/whale.db");
const db = openDb(DB_PATH);
setConfigOverrides(readConfig(db)); // layer DB overrides over env defaults

// PATCH /api/config validation — only the UI-tunable subset, with allowed values.
// `protected` (self-edit guard) is rejected: it stays env-only by design.
const RUNNERS = ["stub", "real"];
const BYPASS = ["conservative", "balanced", "aggressive"];
const MODELS = ["haiku", "sonnet", "opus"];
function validateConfigPatch(b) {
  if ("protected" in b)
    throw new Error("protected is env-only (self-edit guard); not editable here");
  const out = {};
  if ("runner" in b) {
    if (!RUNNERS.includes(b.runner)) throw new Error("runner must be stub|real");
    out.runner = b.runner;
  }
  for (const k of ["model_distill", "model_plan", "model_route"]) {
    if (k in b) {
      if (!MODELS.includes(b[k])) throw new Error(`${k} must be ${MODELS.join("|")}`);
      out[k] = b[k];
    }
  }
  if ("bypass" in b) {
    if (!BYPASS.includes(b.bypass)) throw new Error("bypass must be conservative|balanced|aggressive");
    out.bypass = b.bypass;
  }
  if ("auto_push" in b) out.auto_push = b.auto_push ? 1 : 0;
  if ("allow_new_projects" in b) out.allow_new_projects = b.allow_new_projects ? 1 : 0;
  return out;
}

let team = null;
async function getTeam() {
  // live-read: reload so persona edits in ai-team take effect without restart
  team = await loadTeam(config.personasDir);
  return team;
}

const send = (res, status, body, type = "application/json") => {
  const payload = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(status, { "Content-Type": type });
  res.end(payload);
};
const readJson = (req) =>
  new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => ((d += c), d.length > 2e6 && reject(new Error("too large"))));
    req.on("end", () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error("invalid JSON")); }
    });
  });

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const seg = url.pathname.split("/").filter(Boolean); // ['api','proposed','<id>','approve']
    const { method } = req;

    if (method === "GET" && url.pathname === "/") return send(res, 200, PAGE, "text/html; charset=utf-8");
    if (method === "GET" && url.pathname === "/api/health")
      return send(res, 200, { ok: true, runner: config.runner, autonomy: config.autonomy, db: DB_PATH });

    // status: one aggregate for the global header (dials + counts + krill reachable)
    if (method === "GET" && url.pathname === "/api/status") {
      const proposed = listProposed(db);
      const byStatus = {};
      for (const p of proposed) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
      return send(res, 200, {
        runner: config.runner,
        autonomy: { bypass: config.autonomy.bypass, autoPush: config.autonomy.autoPush },
        inbox: { total: listEntries(db, 1000).length, raw: rawEntries(db).length },
        proposed: { total: proposed.length, byStatus },
        krill: { up: await krillPing(), url: config.krill.baseUrl },
      });
    }

    // config (UI-overridable subset; protected stays env-only)
    if (method === "GET" && url.pathname === "/api/config")
      return send(res, 200, configSnapshot());
    if (method === "PATCH" && url.pathname === "/api/config") {
      const fields = validateConfigPatch(await readJson(req));
      writeConfig(db, fields);
      setConfigOverrides(readConfig(db)); // refresh live overrides — no restart
      return send(res, 200, configSnapshot());
    }

    // inbox
    if (method === "GET" && url.pathname === "/api/inbox") return send(res, 200, { entries: listEntries(db, 50) });
    if (method === "POST" && url.pathname === "/api/inbox") {
      const b = await readJson(req);
      return send(res, 201, { entry: addEntry(db, { text: b.text, projectHint: b.project_hint || null, source: b.source || "manual" }) });
    }
    if (method === "DELETE" && seg[0] === "api" && seg[1] === "inbox" && seg[2])
      return (deleteEntry(db, seg[2]), send(res, 200, { ok: true }));

    // distill
    if (method === "POST" && url.pathname === "/api/distill")
      return send(res, 200, await distillAll(await getTeam(), db));

    // context
    if (method === "GET" && url.pathname === "/api/context") {
      if (url.searchParams.get("key")) return send(res, 200, { key: url.searchParams.get("key"), md: readContext(url.searchParams.get("key")) });
      return send(res, 200, { keys: listContextKeys() });
    }

    // onboard (B5): audit a code project into CONTEXT, or flag seed-needed
    if (method === "POST" && url.pathname === "/api/onboard") {
      const b = await readJson(req);
      if (!b.key) return send(res, 400, { error: "key required" });
      return send(res, 200, await onboard(await getTeam(), b.key));
    }

    // plan
    if (method === "POST" && url.pathname === "/api/plan") {
      const b = await readJson(req);
      if (!b.key) return send(res, 400, { error: "key required" });
      return send(res, 200, { proposed: await planProject(await getTeam(), db, b.key) });
    }

    // batch push (B2): push all pushable tasks for a project in dependency order
    if (method === "POST" && url.pathname === "/api/proposed/push-batch") {
      const b = await readJson(req);
      if (!b.key) return send(res, 400, { error: "key required" });
      return send(res, 200, await pushBatch(await getTeam(), db, b.key, { confirm: !!b.confirm }));
    }

    // proposed
    if (method === "GET" && url.pathname === "/api/proposed")
      return send(res, 200, { proposed: listProposed(db, url.searchParams.get("status") || undefined) });
    if (method === "DELETE" && seg[0] === "api" && seg[1] === "proposed" && seg[2] && !seg[3])
      return (deleteProposed(db, seg[2]), send(res, 200, { ok: true }));
    if (method === "POST" && seg[0] === "api" && seg[1] === "proposed" && seg[3]) {
      const id = seg[2], action = seg[3];
      if (action === "approve") return send(res, 200, await approve(await getTeam(), db, id));
      if (action === "reject") return send(res, 200, { task: reject(db, id) });
      if (action === "push") {
        const b = await readJson(req);
        return send(res, 200, await push(db, id, { confirm: !!b.confirm }));
      }
      if (action === "reassign") {
        const b = await readJson(req);
        if (!b.project_key) return send(res, 400, { error: "project_key required" });
        return send(res, 200, { task: reassign(await getTeam(), db, id, b.project_key) });
      }
      if (action === "refine") {
        const b = await readJson(req);
        if (!b.input) return send(res, 400, { error: "input required" });
        return send(res, 200, await refine(await getTeam(), db, id, b.input));
      }
    }

    // route (Phase 3)
    if (method === "POST" && url.pathname === "/api/route") {
      const b = await readJson(req);
      return send(res, 200, await routeEntry(await getTeam(), db, b.id));
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
});

server.listen(PORT, "0.0.0.0", async () => {
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  try { await getTeam(); } catch (e) { console.error(`⚠ persona-loader: ${e.message}`); }
  console.log(`🐋 whale up — runner=${config.runner} bypass=${config.autonomy.bypass} autoPush=${config.autonomy.autoPush}`);
  console.log(`   local : http://localhost:${PORT}`);
  if (lan) console.log(`   LAN   : http://${lan.address}:${PORT}  (phone)`);
  console.log(`   team  : ${team ? team.personas.length + " personas" : "NOT loaded"}  ·  krill: ${config.krill.baseUrl}`);
});
