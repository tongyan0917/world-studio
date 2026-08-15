import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hash } from "../src/kernel/stable.ts";
import {
  compileCreatorWorldDefinition,
  createCreatorWorldDraft,
  inspectCreatorWorldDefinition,
  type CreatorWorldDefinition,
} from "../src/studio/authoring.ts";
import { WorldEngine } from "../src/world-model/engine.ts";
import { mechanismLibrary, saltMarshBlueprint, saltMarshSources, xuanxiaoBlueprint, xuanxiaoSources } from "../src/world-model/examples.ts";
import { createDefaultMultiScaleSchedule, createDefaultWorldEvolutionPlan } from "../src/world-model/simulation.ts";
import { SqliteWorldStore } from "../src/world-model/store.ts";

const fixtureUrl = new URL("./fixtures/lantern-delta.world.json", import.meta.url);

function definition(): CreatorWorldDefinition {
  return JSON.parse(readFileSync(fixtureUrl, "utf8")) as CreatorWorldDefinition;
}

test("consequential missing premises become stable creator questions and block compilation", () => {
  const incomplete = structuredClone(definition()) as CreatorWorldDefinition & { temporal?: CreatorWorldDefinition["temporal"] };
  delete incomplete.temporal;
  delete (incomplete.resources[0] as { capacity?: number }).capacity;
  const inspection = inspectCreatorWorldDefinition(incomplete);
  assert.equal(inspection.ready, false);
  assert.ok(inspection.questions.some((question) => question.code === "temporal-profile-missing"));
  assert.ok(inspection.questions.some((question) => question.code === "resource-capacity-missing"));
  assert.ok(inspection.questions.every((question) => question.prompt && question.whyConsequential && question.blockedCapabilities.length > 0));
  assert.throws(() => compileCreatorWorldDefinition(incomplete), /creator questions/i);
});

test("a JSON-authored generic World maps every authoring domain into the public Blueprint compiler", () => {
  const authored = definition();
  const inspection = inspectCreatorWorldDefinition(authored);
  assert.deepEqual(inspection.questions, []);
  assert.deepEqual(inspection.issues, []);
  const first = compileCreatorWorldDefinition(authored);
  const second = compileCreatorWorldDefinition(structuredClone(authored));
  assert.equal(hash(first.blueprint), hash(second.blueprint));
  assert.equal(hash(first.sources), hash(second.sources));
  assert.equal(first.blueprint.worldId, "world.lantern-delta");
  assert.ok(first.blueprint.initialGraph.nodes.some((node) => node.type === "place"));
  assert.equal(first.blueprint.initialGraph.nodes.find((node) => node.id === "place:tideglass-quay")?.attributes["map-x"], 34);
  assert.ok(first.blueprint.initialGraph.nodes.some((node) => node.type === "route"));
  assert.ok(first.blueprint.initialGraph.nodes.some((node) => node.type === "population-group"));
  assert.ok(first.blueprint.initialGraph.nodes.some((node) => node.type === "person"));
  assert.equal(first.blueprint.initialGraph.nodes.find((node) => node.id === "person:ilyra-veen")?.attributes.focal, true);
  assert.ok(first.blueprint.initialGraph.nodes.some((node) => node.type === "organization"));
  assert.ok(first.blueprint.initialGraph.nodes.some((node) => node.type === "institution"));
  assert.ok(first.blueprint.initialGraph.nodes.some((node) => node.type === "resource-stock"));
  assert.ok(first.blueprint.initialGraph.nodes.some((node) => node.type === "hazard"));
  assert.ok(first.blueprint.initialGraph.nodes.some((node) => node.type === "lantern-grid"));
  assert.ok(first.blueprint.initialGraph.edges.some((edge) => edge.type === "related-to"));
  assert.ok(first.blueprint.initialGraph.facts.some((fact) => fact.epistemicScope !== "world"));
  assert.equal(first.blueprint.theoryPacks.length, 8);
  assert.equal(first.blueprint.rules.length, 3);
  assert.deepEqual(first.blueprint.presentationHints?.creatorParameters, authored.parameters);
});

test("draft, accepted immutable Contract, and Instance survive restart and remain World-isolated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "world-studio-authoring-"));
  const database = join(directory, "world-studio.sqlite");
  try {
    const authored = definition();
    const store = new SqliteWorldStore(database);
    const draft = createCreatorWorldDraft(authored);
    store.saveWorldDraft(draft, 0);
    assert.throws(() => store.saveWorldDraft({ ...draft, revision: 2 }, 0), /draft revision conflict/i);

    const engine = new WorldEngine({ store, mechanismLibrary });
    for (const [blueprint, sources] of [[saltMarshBlueprint, saltMarshSources], [xuanxiaoBlueprint, xuanxiaoSources]] as const) {
      const built = await engine.build(blueprint, sources);
      engine.accept(built.compilation.base);
    }
    const input = compileCreatorWorldDefinition(authored);
    const built = await engine.build(input.blueprint, input.sources);
    assert.ok(!built.compilation.base.findings.some((finding) => finding.severity === "error"));
    const accepted = engine.accept(built.compilation.base);
    assert.equal(accepted.contract.authority, "accepted");
    assert.notEqual(accepted.contract.hash, hash(saltMarshBlueprint));
    assert.deepEqual(store.listWorlds().map((world) => world.worldId), [
      "world.lantern-delta",
      "world.salt-marsh",
      "world.xuanxiao-nine-realms",
    ]);
    store.close();

    const reopened = new SqliteWorldStore(database);
    assert.equal(reopened.schemaVersion(), 5);
    assert.deepEqual(reopened.loadWorldDraft(authored.worldId, authored.draftId), draft);
    assert.deepEqual(reopened.loadContract(accepted.worldId, accepted.contract.id, accepted.contract.version), accepted.contract);
    assert.deepEqual(reopened.loadInstance(accepted.worldId, accepted.instance.id), accepted.instance);
    assert.equal(reopened.loadContract("world.salt-marsh", accepted.contract.id, accepted.contract.version), undefined);
    assert.deepEqual(reopened.loadInitialGraph(accepted.worldId, accepted.instance.id), {
      nodes: [...Object.values(accepted.instance.initialSnapshot.nodes)].sort((left, right) => left.id.localeCompare(right.id)),
      edges: [...Object.values(accepted.instance.initialSnapshot.edges)].sort((left, right) => left.id.localeCompare(right.id)),
      facts: [...Object.values(accepted.instance.initialSnapshot.facts)].sort((left, right) => left.id.localeCompare(right.id)),
    });
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the authored third World executes the installed multi-scale engine without a bespoke runtime", async () => {
  const input = compileCreatorWorldDefinition(definition());
  const engine = new WorldEngine({ mechanismLibrary });
  const built = await engine.build(input.blueprint, input.sources);
  const accepted = engine.accept(built.compilation.base);
  const schedule = createDefaultMultiScaleSchedule(accepted.worldId, accepted.contract.hash, ["person:ilyra-veen", "person:tomas-orr"]);
  const plan = createDefaultWorldEvolutionPlan(accepted.worldId, accepted.contract.hash, schedule, 320);
  const autonomous = await engine.evolve(accepted, { plan, schedule, seed: "lantern-delta-acceptance", requireCausalClosure: true });
  assert.equal(autonomous.quiescent, true);
  assert.equal(autonomous.closureAudit.status, "closed");
  assert.equal(autonomous.dimensionsClosed.length, 14);
  assert.ok(autonomous.generatedInputs.length > 100);
  assert.ok(autonomous.run.finalSnapshot.nodes["grid:west-gates"]);
});
