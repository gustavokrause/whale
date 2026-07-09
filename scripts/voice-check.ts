/**
 * D2 — voice A/B regression harness.
 *
 * Personas hot-reload: an edit to a persona's context.md/rules.md ships into
 * the next plan run with zero gate, and "reads fine" is not evidence — voice
 * and framing are load-bearing, and a compression that inspects clean can
 * still change behavior. This harness is the missing gate: frozen inputs,
 * stored baseline outputs, and a judge that compares candidate vs baseline
 * for BEHAVIORAL change (substance, priorities, judgment, register) while
 * ignoring run-to-run wording variance.
 *
 * Usage (from whale/):
 *   npm run voice-check -- --baseline            # snapshot ALL personas (~40 calls)
 *   npm run voice-check -- --baseline Maria      # snapshot one persona
 *   npm run voice-check -- Maria                 # check Maria vs her baseline
 *   npm run voice-check                          # check every persona that has a baseline
 *   npm run voice-check -- --cross Maria Rafael  # sanity: judge Maria vs Rafael's
 *                                                #   baseline (expect: shifted)
 *
 * Fixtures + baselines live in the ai-team repo (they version WITH the
 * personas): tests/voice/fixtures.json, tests/voice/baselines/<folder>.json.
 * Fixtures are FROZEN — editing one invalidates every baseline.
 *
 * Costs real tokens (spawns the Claude CLI): ~3 calls per persona snapshot,
 * ~6 per check (3 candidate + 3 judge). Metered into data/usage.jsonl under
 * voice:baseline / voice:candidate / voice:judge.
 *
 * Exit codes: 0 all same · 1 any shifted (usable as a gate) · 2 setup error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../src/lib/config";
import { loadTeam, type Persona } from "../src/lib/persona-loader";
import { completeJSON, completeText } from "../src/lib/runner";

// Frozen task given to every persona on every fixture. Part of the harness
// contract: change it and every baseline is invalid (bump VERSION if you must).
// v2: baselines hold TWO samples per fixture — the judge learns the persona's
// natural run-to-run variance from the pair instead of guessing it (v1 flagged
// an unchanged persona whose judgment legitimately swings on ambiguous cases).
const VERSION = 2;
const BASELINE_SAMPLES = 2;
const VOICE_TASK =
  "A founder you advise dropped the note below. Respond as yourself, in your " +
  "own voice: give your read of the situation from your specialty, name what " +
  "matters most, and propose 1-3 concrete tasks you would own. Under 250 words.";

// Sonnet for both sampling and judging: stable, cheap, and the comparison is
// about the PERSONA text's effect, not frontier judgment.
const SAMPLE_MODEL = "sonnet";
const JUDGE_MODEL = "sonnet";

type Fixture = { id: string; text: string };
type Baseline = {
  version: number;
  persona: string;
  folder: string;
  model: string;
  generated_at: string;
  outputs: Record<string, string[]>; // fixture id → BASELINE_SAMPLES responses
};
type Verdict = { verdict: "same" | "shifted"; differences?: string[] };

const voiceDir = path.join(config.personasDir, "tests", "voice");
const baselinePath = (p: Persona) =>
  path.join(voiceDir, "baselines", `${path.basename(p.folder)}.json`);

function loadFixtures(): Fixture[] {
  const f = path.join(voiceDir, "fixtures.json");
  if (!existsSync(f)) {
    console.error(`fixtures not found: ${f}`);
    process.exit(2);
  }
  return (JSON.parse(readFileSync(f, "utf8")) as { fixtures: Fixture[] }).fixtures;
}

async function sample(p: Persona, fx: Fixture, purpose: string): Promise<string> {
  return completeText({
    system: p.systemPrompt,
    user: `${VOICE_TASK}\n\nNOTE FROM THE FOUNDER:\n${fx.text}`,
    model: SAMPLE_MODEL,
    purpose,
  });
}

async function judge(fx: Fixture, baselines: string[], b: string): Promise<Verdict> {
  const range = baselines
    .map((t, i) => `--- BASELINE SAMPLE A${i + 1} ---\n${t}`)
    .join("\n\n");
  return completeJSON<Verdict>({
    system:
      "You judge whether an AI persona's DEFINITION changed. The baseline " +
      "samples (A1, A2, …) are the SAME persona answering the SAME input on " +
      "different runs — everything that varies BETWEEN them (tactical calls, " +
      "recommendations swinging on an ambiguous case, wording, ordering, " +
      "length) is that persona's NATURAL variance and must be tolerated in B. " +
      "Report 'shifted' only if candidate B departs BEYOND that spread: a " +
      "different voice/register (e.g. first-person advisor became detached " +
      "list-generator), different specialty boundaries, systematically " +
      "different priorities or risk posture that neither baseline sample " +
      "exhibits, or clearly different depth of expertise. When in doubt, " +
      "'same'. " +
      'Return JSON: {"verdict":"same"} or {"verdict":"shifted","differences":["<specific behavioral difference beyond the baseline spread>", ...]}.',
    user: `INPUT:\n${fx.text}\n\n${range}\n\n--- CANDIDATE B ---\n${b}`,
    model: JUDGE_MODEL,
    purpose: "voice:judge",
  });
}

async function writeBaseline(p: Persona, fixtures: Fixture[]): Promise<void> {
  const outputs: Record<string, string[]> = {};
  for (const fx of fixtures) {
    process.stdout.write(`  ${p.name} ← ${fx.id} … `);
    const samples: string[] = [];
    for (let i = 0; i < BASELINE_SAMPLES; i++) {
      samples.push(await sample(p, fx, "voice:baseline"));
      process.stdout.write(`s${i + 1} `);
    }
    outputs[fx.id] = samples;
    console.log("ok");
  }
  const b: Baseline = {
    version: VERSION,
    persona: p.name,
    folder: path.basename(p.folder),
    model: SAMPLE_MODEL,
    generated_at: new Date().toISOString(),
    outputs,
  };
  mkdirSync(path.dirname(baselinePath(p)), { recursive: true });
  writeFileSync(baselinePath(p), JSON.stringify(b, null, 2) + "\n");
  console.log(`  ✓ baseline written: ${baselinePath(p)}`);
}

/** Check `p` (candidate runs) against `against`'s stored baseline. */
async function check(p: Persona, against: Persona, fixtures: Fixture[]): Promise<boolean> {
  const bp = baselinePath(against);
  if (!existsSync(bp)) {
    console.error(`  ✗ no baseline for ${against.name} — run --baseline first`);
    return false;
  }
  const base = JSON.parse(readFileSync(bp, "utf8")) as Baseline;
  if (base.version !== VERSION) {
    console.error(`  ✗ baseline version ${base.version} ≠ harness ${VERSION} — re-baseline`);
    return false;
  }
  let clean = true;
  for (const fx of fixtures) {
    const a = base.outputs[fx.id];
    if (!a?.length) {
      console.error(`  ✗ baseline missing fixture ${fx.id} — re-baseline`);
      clean = false;
      continue;
    }
    process.stdout.write(`  ${p.name} ← ${fx.id} … `);
    const b = await sample(p, fx, "voice:candidate");
    const v = await judge(fx, a, b);
    if (v.verdict === "same") {
      console.log("same");
    } else {
      clean = false;
      console.log("SHIFTED");
      for (const d of v.differences ?? []) console.log(`      · ${d}`);
    }
  }
  return clean;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const baselineMode = args.includes("--baseline");
  const crossMode = args.includes("--cross");
  const names = args.filter((a) => !a.startsWith("--"));

  const team = await loadTeam(config.personasDir);
  const byName = (n: string) => {
    const p = team.personas.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (!p) {
      console.error(`unknown persona "${n}" — roster: ${team.personas.map((x) => x.name).join(", ")}`);
      process.exit(2);
    }
    return p;
  };
  const fixtures = loadFixtures();

  if (crossMode) {
    // Harness sanity check: two DIFFERENT personas must read as shifted.
    if (names.length !== 2) {
      console.error("--cross needs exactly two persona names");
      process.exit(2);
    }
    const [cand, base] = [byName(names[0]), byName(names[1])];
    console.log(`cross-check (expect SHIFTED): ${cand.name} vs ${base.name}'s baseline`);
    const same = await check(cand, base, fixtures);
    process.exit(same ? 1 : 0); // shifted = harness works
  }

  const targets = names.length
    ? names.map(byName)
    : baselineMode
      ? team.personas
      : team.personas.filter((p) => existsSync(baselinePath(p)));

  if (!targets.length) {
    console.error("nothing to do — no baselines exist yet; run with --baseline");
    process.exit(2);
  }

  if (baselineMode) {
    console.log(`writing baselines for ${targets.length} persona(s), ${fixtures.length} fixtures each`);
    for (const p of targets) await writeBaseline(p, fixtures);
    return;
  }

  console.log(`voice-check: ${targets.length} persona(s) vs stored baselines`);
  let allClean = true;
  for (const p of targets) {
    if (!(await check(p, p, fixtures))) allClean = false;
  }
  if (!allClean) {
    console.log("\n✗ voice shift detected — review the differences before trusting the edited persona(s). If the change is intentional, re-run with --baseline to accept.");
    process.exit(1);
  }
  console.log("\n✓ no behavioral shift");
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
