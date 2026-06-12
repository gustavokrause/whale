// baleia — server. Capture inbox + distiller + planner + triage + router + krill push.
// Built-in http, zero deps. Loads the persona team from ai-team (read-only).
//
// Run:  npm start    Env: BALEIA_PORT(4100) BALEIA_RUNNER(stub|real) KRILL_URL PERSONAS_DIR

import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { config } from "./config.mjs";
import { openDb, addEntry, listEntries } from "./db.mjs";
import { listProposed } from "./db.mjs";
import { loadTeam } from "./persona-loader.mjs";
import { readContext, listContextKeys } from "./context-store.mjs";
import { distillAll, planProject, approve, reject, push, routeEntry } from "./pipeline.mjs";
import { PAGE } from "./ui.mjs";

const PORT = Number(process.env.BALEIA_PORT || 4100);
const DB_PATH = process.env.BALEIA_DB || path.resolve(process.cwd(), "data/baleia.db");
const db = openDb(DB_PATH);

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

    // inbox
    if (method === "GET" && url.pathname === "/api/inbox") return send(res, 200, { entries: listEntries(db, 50) });
    if (method === "POST" && url.pathname === "/api/inbox") {
      const b = await readJson(req);
      return send(res, 201, { entry: addEntry(db, { text: b.text, projectHint: b.project_hint || null, source: b.source || "manual" }) });
    }

    // distill
    if (method === "POST" && url.pathname === "/api/distill")
      return send(res, 200, await distillAll(await getTeam(), db));

    // context
    if (method === "GET" && url.pathname === "/api/context") {
      if (url.searchParams.get("key")) return send(res, 200, { key: url.searchParams.get("key"), md: readContext(url.searchParams.get("key")) });
      return send(res, 200, { keys: listContextKeys() });
    }

    // plan
    if (method === "POST" && url.pathname === "/api/plan") {
      const b = await readJson(req);
      if (!b.key) return send(res, 400, { error: "key required" });
      return send(res, 200, { proposed: await planProject(await getTeam(), db, b.key) });
    }

    // proposed
    if (method === "GET" && url.pathname === "/api/proposed")
      return send(res, 200, { proposed: listProposed(db, url.searchParams.get("status") || undefined) });
    if (method === "POST" && seg[0] === "api" && seg[1] === "proposed" && seg[3]) {
      const id = seg[2], action = seg[3];
      if (action === "approve") return send(res, 200, await approve(await getTeam(), db, id));
      if (action === "reject") return send(res, 200, { task: reject(db, id) });
      if (action === "push") return send(res, 200, await push(db, id));
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
  console.log(`🐋 baleia up — runner=${config.runner} bypass=${config.autonomy.bypass} autoPush=${config.autonomy.autoPush}`);
  console.log(`   local : http://localhost:${PORT}`);
  if (lan) console.log(`   LAN   : http://${lan.address}:${PORT}  (phone)`);
  console.log(`   team  : ${team ? team.personas.length + " personas" : "NOT loaded"}  ·  krill: ${config.krill.baseUrl}`);
});
