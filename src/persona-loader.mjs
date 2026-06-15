// whale — Phase 0: persona-loader
//
// Reads the ai-team repo (source of truth) and produces the three artifacts
// whale consumes at runtime:
//   1. routingDoctrine  — AGENTS.md (full text: routing + economy + base rules)
//   2. risk             — { tiers, safeWords } parsed from AGENTS.md
//   3. personas         — registry [{ name, area, folder, tone, systemPrompt }]
//
// One-way, read-only. whale never writes back to ai-team.
// Spike in plain ESM so it runs with `node` (no build). Port into TS structure
// once proven.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/** Load the whole team from the ai-team repo at `personasDir`. */
export async function loadTeam(personasDir) {
  const agentsPath = path.join(personasDir, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    throw new Error(`AGENTS.md not found in ${personasDir} — is PERSONAS_DIR correct?`);
  }
  const agents = await readFile(agentsPath, "utf8");

  const risk = parseRisk(agents);
  const roster = parseRoster(agents);

  const personas = [];
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
      // The persona's system prompt = deep context (+ short card when present).
      systemPrompt: rules ? `${context}\n\n---\n\n${rules}` : context,
    });
  }

  return { routingDoctrine: agents, risk, personas };
}

/** Parse the roster markdown table from AGENTS.md. */
function parseRoster(agents) {
  const rows = [];
  // | Name | Area | `ai/professionals/x/` | Tone |
  const re = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*$/gm;
  let m;
  while ((m = re.exec(agents)) !== null) {
    const [, name, area, folder, tone] = m;
    if (name === "Persona" || /^-+$/.test(name)) continue; // header / separator
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
function parseRisk(agents) {
  const tiers = [];
  const tierRe = /-\s*(🟢|🟡|🔴)\s*\*\*([^*]+)\*\*\s*\(([^)]*)\):\s*(.+)/g;
  let m;
  while ((m = tierRe.exec(agents)) !== null) {
    tiers.push({ marker: m[1], level: m[2].trim(), scope: m[3].trim(), action: m[4].trim() });
  }
  let safeWords = [];
  const sw = agents.match(/Safe words[^\n]*\n+`([^`]+)`/);
  if (sw) safeWords = sw[1].split(",").map((s) => s.trim()).filter(Boolean);
  return { tiers, safeWords };
}

// --- CLI smoke test: `node src/persona-loader.mjs <ai-team-path>` ---
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dir = process.argv[2] || path.resolve(process.cwd(), "../ai-team");
  loadTeam(dir)
    .then(({ personas, risk, routingDoctrine }) => {
      console.log(`✓ loaded team from ${dir}`);
      console.log(`\nROUTING DOCTRINE: ${routingDoctrine.length} chars of AGENTS.md`);
      console.log(`\nRISK TIERS (${risk.tiers.length}):`);
      for (const t of risk.tiers) console.log(`  ${t.marker} ${t.level} → ${t.action}`);
      console.log(`\nSAFE WORDS (${risk.safeWords.length}): ${risk.safeWords.join(", ")}`);
      console.log(`\nPERSONAS (${personas.length}):`);
      for (const p of personas) {
        console.log(`  ${p.name.padEnd(10)} ${("[" + p.area + "]").padEnd(22)} ${p.systemPrompt.length} chars`);
      }
      const missing = personas.filter((p) => p.systemPrompt.length < 200);
      if (missing.length) {
        console.error(`\n✗ thin prompts: ${missing.map((p) => p.name).join(", ")}`);
        process.exit(1);
      }
      console.log(`\n✓ all ${personas.length} personas resolved with full prompts`);
    })
    .catch((err) => {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    });
}
