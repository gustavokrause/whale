// whale — persona-loader. Reads the ai-team repo (source of truth) and produces
// the artifacts whale consumes at runtime. One-way, read-only.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export type Persona = {
  name: string;
  area: string;
  folder: string;
  tone: string;
  systemPrompt: string;
};

export type RiskTier = {
  marker: string;
  level: string;
  scope: string;
  action: string;
};

export type Risk = { tiers: RiskTier[]; safeWords: string[] };

export type Team = {
  routingDoctrine: string;
  risk: Risk;
  personas: Persona[];
};

type RosterRow = { name: string; area: string; folder: string; tone: string };

/** Load the whole team from the ai-team repo at `personasDir`. */
export async function loadTeam(personasDir: string): Promise<Team> {
  const agentsPath = path.join(personasDir, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    throw new Error(`AGENTS.md not found in ${personasDir} — is PERSONAS_DIR correct?`);
  }
  const agents = await readFile(agentsPath, "utf8");

  const risk = parseRisk(agents);
  const roster = parseRoster(agents);

  const personas: Persona[] = [];
  for (const row of roster) {
    const folderAbs = path.join(personasDir, row.folder);
    const contextPath = path.join(folderAbs, "context.md");
    if (!existsSync(contextPath)) {
      throw new Error(`Roster lists ${row.name} but ${contextPath} is missing`);
    }
    const context = await readFile(contextPath, "utf8");
    const rulesPath = path.join(folderAbs, "rules.md");
    const rules = existsSync(rulesPath) ? await readFile(rulesPath, "utf8") : null;
    personas.push({
      name: row.name,
      area: row.area,
      folder: row.folder,
      tone: row.tone,
      systemPrompt: rules ? `${context}\n\n---\n\n${rules}` : context,
    });
  }

  return { routingDoctrine: agents, risk, personas };
}

/** Parse the roster markdown table from AGENTS.md. */
function parseRoster(agents: string): RosterRow[] {
  const rows: RosterRow[] = [];
  const re = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(agents)) !== null) {
    const [, name, area, folder, tone] = m;
    if (name === "Persona" || /^-+$/.test(name)) continue;
    rows.push({
      name: name.trim(),
      area: area.trim(),
      folder: folder.replace(/\/+$/, "").trim(),
      tone: tone.trim(),
    });
  }
  return rows;
}

/** Parse the risk rubric + safe-words from AGENTS.md. */
function parseRisk(agents: string): Risk {
  const tiers: RiskTier[] = [];
  const tierRe = /-\s*(🟢|🟡|🔴)\s*\*\*([^*]+)\*\*\s*\(([^)]*)\):\s*(.+)/g;
  let m: RegExpExecArray | null;
  while ((m = tierRe.exec(agents)) !== null) {
    tiers.push({ marker: m[1], level: m[2].trim(), scope: m[3].trim(), action: m[4].trim() });
  }
  let safeWords: string[] = [];
  const sw = agents.match(/Safe words[^\n]*\n+`([^`]+)`/);
  if (sw) safeWords = sw[1].split(",").map((s) => s.trim()).filter(Boolean);
  return { tiers, safeWords };
}
