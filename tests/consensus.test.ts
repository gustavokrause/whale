// whale — consensus orchestration tests. The dynamic peer-consensus planner is
// driven by a SCRIPTED completer (no `claude` spawn), so we test the loop itself:
// Caio nomination → propose+nominate → fixpoint convergence → synthesis merge.

import { test } from "node:test";
import assert from "node:assert/strict";

import { planConsensus, planSingle, pickRefiner, type Completer, type ConsensusContext } from "../src/lib/consensus";
import type { Team, Persona } from "../src/lib/persona-loader";
import type { TaskDraft } from "../src/lib/stages";

const P = (name: string, area: string): Persona => ({
  name,
  area,
  folder: `ai/professionals/${name.toLowerCase()}`,
  tone: "test",
  systemPrompt: `Context for ${name}. `.repeat(20),
});

const team: Team = {
  routingDoctrine: "doctrine",
  risk: { tiers: [], safeWords: [] },
  personas: [
    P("Caio", "AI/Orchestration"),
    P("Fernanda", "Finance"),
    P("Patrícia", "Legal"),
    P("Ana", "Frontend"),
    P("Rafael", "Backend"),
    P("Augusto", "Strategy"),
    P("Maria", "Product"),
    P("Roberto", "Sales"),
  ],
};

const ctx: ConsensusContext = {
  key: "demo",
  context: "",
  reqs: [{ id: "e1", text: "add paid plans", source: "manual" } as never],
  existing: [],
  fileNote: "",
};

const task = (name: string, label = name): TaskDraft => ({ name, label, description: `do ${name}`, source: 0 });

// Pull the persona name out of a propose system prompt ("You are X (Area)").
const callerOf = (system: string) => (system.match(/You are ([^(]+)\(/)?.[1] || "").trim();

type Script = {
  nominate: () => unknown;
  sweep?: () => unknown;
  synthesize?: () => unknown;
  propose?: Record<string, () => unknown>;
};

function makeComplete(script: Script): Completer {
  return (async ({ system }: { system: string; user: string }) => {
    if (/You COORDINATE the team/.test(system)) return script.nominate();
    if (/is MISSING from the proposals/.test(system)) return script.sweep ? script.sweep() : { missing: [] };
    if (/MERGING the bench/.test(system)) return script.synthesize ? script.synthesize() : { tasks: [] };
    const fn = script.propose?.[callerOf(system)];
    return fn ? fn() : { proposals: [], nominations: [] };
  }) as unknown as Completer;
}

test("consensus: Caio nominates → persona proposes → nominates another → converges", async () => {
  const complete = makeComplete({
    nominate: () => ({ nominees: [{ name: "Fernanda", area: "Finance", why: "billing" }] }),
    propose: {
      Fernanda: () => ({
        proposals: [task("billing-audit")],
        nominations: [{ name: "Patrícia", area: "Legal", why: "refund terms are a legal question" }],
      }),
      Patrícia: () => ({ proposals: [task("refund-terms")], nominations: [] }),
    },
  });

  const { drafts, transcript } = await planConsensus(team, ctx, complete);

  assert.equal(drafts.length, 2, "both personas' tasks survive");
  const byName = new Map(drafts.map((d) => [d.name, d]));
  assert.equal(byName.get("billing-audit")!.owner_persona, "Fernanda", "owner stamped");
  assert.equal(byName.get("billing-audit")!.owner_area, "Finance");
  assert.equal(byName.get("refund-terms")!.owner_persona, "Patrícia");

  const noms = transcript.filter((e) => e.kind === "nominate");
  assert.ok(noms.some((e) => e.by === "Caio"), "Caio's nomination logged");
  assert.ok(noms.some((e) => e.by === "Fernanda"), "Fernanda's handoff logged");
  const proposed = transcript.filter((e) => e.kind === "propose").map((e) => e.by);
  assert.deepEqual(new Set(proposed), new Set(["Fernanda", "Patrícia"]), "both proposed once");
});

test("consensus: completeness sweep pulls a missing discipline not initially routed", async () => {
  let swept = false;
  const complete = makeComplete({
    nominate: () => ({ nominees: [{ name: "Fernanda", area: "Finance", why: "pricing" }] }),
    sweep: () => {
      if (swept) return { missing: [] };
      swept = true; // first sweep finds Sales missing; second finds nothing
      return { missing: [{ name: "Roberto", area: "Sales", why: "B2B deal shapes uncovered" }] };
    },
    propose: {
      Fernanda: () => ({ proposals: [task("price-points")], nominations: [] }),
      Roberto: () => ({ proposals: [task("deal-shapes")], nominations: [] }),
    },
  });

  const { drafts, transcript } = await planConsensus(team, ctx, complete);
  assert.ok(drafts.some((d) => d.owner_persona === "Roberto"), "swept-in Sales persona contributed");
  assert.ok(
    transcript.some((e) => e.kind === "nominate" && e.by === "Caio (completeness)"),
    "sweep logged as a completeness nomination",
  );
});

test("consensus: synthesis merges same-deliverable proposals, keeps distinct slices", async () => {
  // Two personas each propose a "rewrite precos.md" task (same deliverable) plus a
  // distinct slice. The merge folds the duplicates into one, keeps the slices.
  const complete = makeComplete({
    nominate: () => ({
      scope: "multi",
      nominees: [
        { name: "Fernanda", area: "Finance", why: "price" },
        { name: "Maria", area: "Product", why: "packaging" },
      ],
    }),
    propose: {
      Fernanda: () => ({ proposals: [task("rewrite-precos-a"), task("price-points")], nominations: [] }),
      Maria: () => ({ proposals: [task("rewrite-precos-b"), task("packaging")], nominations: [] }),
    },
    synthesize: () => ({
      tasks: [
        { name: "rewrite precos.md", owner_persona: "Fernanda", owner_area: "Finance", source: 0 },
        { name: "price-points", owner_persona: "Fernanda", owner_area: "Finance", source: 0 },
        { name: "packaging", owner_persona: "Maria", owner_area: "Product", source: 0 },
      ],
    }),
  });

  const { drafts, transcript } = await planConsensus(team, ctx, complete);
  assert.equal(drafts.length, 3, "4 proposals → 3 (the two precos rewrites merged)");
  assert.ok(
    drafts.some((d) => d.owner_persona === "Fernanda") && drafts.some((d) => d.owner_persona === "Maria"),
    "both disciplines survive the merge — no collapse to one owner",
  );
  const merge = transcript.find((e) => e.kind === "merge");
  assert.ok(merge && merge.before === 4 && merge.after === 3, "merge logged before→after");
});

test("consensus: synthesis never returns empty — falls back to the raw pile", async () => {
  const complete = makeComplete({
    nominate: () => ({
      scope: "multi",
      nominees: [
        { name: "Ana", area: "Frontend", why: "ui" },
        { name: "Rafael", area: "Backend", why: "api" },
      ],
    }),
    propose: {
      Ana: () => ({ proposals: [task("ui")], nominations: [] }),
      Rafael: () => ({ proposals: [task("api")], nominations: [] }),
    },
    synthesize: () => ({ tasks: [] }), // model returned nothing usable
  });

  const { drafts } = await planConsensus(team, ctx, complete);
  assert.equal(drafts.length, 2, "empty merge → keep the proposals rather than collapse");
});

test("consensus: a persona speaks once even if nominated twice", async () => {
  const complete = makeComplete({
    nominate: () => ({ nominees: [{ name: "Fernanda", area: "Finance", why: "billing" }] }),
    propose: {
      Fernanda: () => ({
        proposals: [task("billing")],
        // re-nominate Fernanda (already spoken) + Patrícia (new)
        nominations: [
          { name: "Fernanda", area: "Finance", why: "again" },
          { name: "Patrícia", area: "Legal", why: "legal" },
        ],
      }),
      Patrícia: () => ({ proposals: [task("legal")], nominations: [] }),
    },
  });

  const { drafts, transcript } = await planConsensus(team, ctx, complete);
  const fernandaProposals = transcript.filter((e) => e.kind === "propose" && e.by === "Fernanda");
  assert.equal(fernandaProposals.length, 1, "Fernanda proposed exactly once");
  assert.equal(drafts.length, 2);
});

test("planSingle: one call, tags owners, returns the planner's tasks", async () => {
  const complete = (async ({ system }: { system: string }) => {
    if (/PLANNING LEAD with the whole team/.test(system))
      return {
        tasks: [
          { name: "price tiers", owner_persona: "Fernanda", owner_area: "Finance", source: 0 },
          { name: "packaging", owner_persona: "Maria", owner_area: "Product", source: 0 },
        ],
      };
    return { tasks: [] };
  }) as unknown as Completer;

  const { drafts, transcript } = await planSingle(team, ctx, complete);
  assert.equal(drafts.length, 2, "planner's tasks returned");
  assert.ok(drafts.some((d) => d.owner_persona === "Fernanda") && drafts.some((d) => d.owner_persona === "Maria"));
  assert.ok(transcript.some((e) => e.kind === "propose" && e.by === "Single planner"), "single-planner step logged");
});

test("pickRefiner: Caio routes the refine; can switch domain on the input", async () => {
  // Caio moves a pricing task to Legal because the input raises a refund question.
  const toLegal = (async ({ system }: { system: string }) => {
    if (/Pick the ONE persona best suited to revise/.test(system)) return { name: "Patrícia" };
    return {};
  }) as unknown as Completer;
  const p = await pickRefiner(
    team,
    { name: "pricing tiers", description: "3-tier plan", owner_persona: "Fernanda", input: "what about refund terms?" },
    toLegal,
  );
  assert.equal(p.name, "Patrícia", "routed to Legal on a refund question");
});

test("pickRefiner: falls back to the task owner when routing yields nothing", async () => {
  const dud = (async () => ({ name: "Nobody" })) as unknown as Completer; // not in roster
  const p = await pickRefiner(team, { name: "x", owner_persona: "Rafael", input: "tweak" }, dud);
  assert.equal(p.name, "Rafael", "owner is the fallback");
});

test("pickRefiner: routing error falls back, never throws", async () => {
  const boom = (async () => { throw new Error("model down"); }) as unknown as Completer;
  const p = await pickRefiner(team, { name: "x", owner_persona: "Ana", input: "tweak" }, boom);
  assert.equal(p.name, "Ana", "best-effort: error → owner fallback");
});

test("consensus: empty nomination falls back to the strategy+product duo", async () => {
  const complete = makeComplete({
    nominate: () => ({ nominees: [] }), // Caio names no one
    propose: {
      Augusto: () => ({ proposals: [task("scope-check")], nominations: [] }),
      Maria: () => ({ proposals: [task("decompose")], nominations: [] }),
    },
  });

  const { drafts } = await planConsensus(team, ctx, complete);
  assert.deepEqual(
    new Set(drafts.map((d) => d.owner_persona)),
    new Set(["Augusto", "Maria"]),
    "duo planned when no domain owner nominated",
  );
});
