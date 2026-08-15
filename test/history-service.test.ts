import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hash } from "../src/kernel/stable.ts";
import { compileCreatorWorldDefinition, type CreatorWorldDefinition } from "../src/studio/authoring.ts";
import { StudioHistoryService } from "../src/studio/history-service.ts";
import { WorldEngine } from "../src/world-model/engine.ts";
import { mechanismLibrary } from "../src/world-model/examples.ts";
import { createDefaultMultiScaleSchedule, createDefaultWorldEvolutionPlan } from "../src/world-model/simulation.ts";
import { SqliteWorldStore } from "../src/world-model/store.ts";
import { verifyWorldReplay } from "../src/world-model/runtime.ts";

function definition(): CreatorWorldDefinition {
  return JSON.parse(readFileSync(new URL("./fixtures/lantern-delta.world.json", import.meta.url), "utf8")) as CreatorWorldDefinition;
}

test("a creator branches any existing object at an arbitrary World time and receives immutable causal evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "world-studio-history-"));
  const database = join(directory, "world-studio.sqlite");
  try {
    const store = new SqliteWorldStore(database);
    const engine = new WorldEngine({ store, mechanismLibrary });
    const authored = compileCreatorWorldDefinition(definition());
    const built = await engine.build(authored.blueprint, authored.sources);
    const compiled = engine.accept(built.compilation.base);
    const schedule = createDefaultMultiScaleSchedule(compiled.worldId, compiled.contract.hash, ["person:ilyra-veen"]);
    const plan = createDefaultWorldEvolutionPlan(compiled.worldId, compiled.contract.hash, schedule, 320);
    const parent = await engine.evolve(compiled, { plan, schedule, seed: "history-service", requireCausalClosure: true });
    const service = new StudioHistoryService(engine);
    const parentHash = hash(parent);

    const positive = await service.branchAtSelection(compiled, parent, schedule, {
      worldId: compiled.worldId,
      id: "request:route-repair",
      parentRunId: parent.run.manifest.runId,
      mode: "intervention",
      target: { kind: "node", id: "route:lantern-causeway", fieldId: "maintenance", worldTime: 1100 },
      reason: "Commit additional causeway maintenance before meso adaptation.",
      action: { kind: "set-node-attribute", nodeId: "route:lantern-causeway", fieldId: "maintenance", value: 92 },
    });
    assert.equal(hash(parent), parentHash, "explanation and branch queries must not mutate the parent");
    assert.equal(positive.anchorBoundaryId, "boundary:meso-adaptation");
    assert.equal(positive.anchorWorldTime, 1200);
    assert.equal(positive.comparison.protectedPrefixVerified, true);
    assert.deepEqual(positive.comparison.newExternalInputIds, positive.interventionInputIds);
    assert.ok(positive.comparison.changedPaths.length > 0);
    assert.ok(positive.comparison.auditChangedPaths.length > 0);
    assert.ok(positive.impact.emissionIds.length > 0);
    assert.ok(positive.targetAfter.externalCauseInputIds.includes(positive.interventionInputIds[0]!));
    assert.ok(positive.initialConditionRoots.length > 0);
    assert.notEqual(positive.candidateRunId, parent.run.manifest.runId);
    assert.equal(store.loadHistoryEvidence(compiled.worldId, positive.id)?.evidenceHash, positive.evidenceHash);

    const irrelevant = await service.branchAtSelection(compiled, parent, schedule, {
      worldId: compiled.worldId,
      id: "request:display-alias",
      parentRunId: parent.run.manifest.runId,
      mode: "intervention",
      target: { kind: "node", id: "person:ilyra-veen", fieldId: "name", worldTime: 1100 },
      reason: "Record a non-causal display alias as a negative control.",
      action: { kind: "set-node-attribute", nodeId: "person:ilyra-veen", fieldId: "name", value: "Ilyra Veen — archive alias" },
    });
    assert.deepEqual(irrelevant.comparison.changedPaths, ["/nodes/person%3Ailyra-veen/attributes/name"]);
    assert.deepEqual(irrelevant.comparison.impactedEmissionIds, []);
    assert.deepEqual(irrelevant.comparison.auditChangedPaths, []);

    const guided = await service.branchAtSelection(compiled, parent, schedule, {
      worldId: compiled.worldId,
      id: "request:resilience-focus",
      parentRunId: parent.run.manifest.runId,
      mode: "soft-guidance",
      target: { kind: "node", id: "organization:tide-registry", worldTime: 1100 },
      reason: "Explore institutional resilience without prescribing an outcome.",
      prompt: "Prefer plausible paths that reveal whether distributed maintenance authority becomes resilient.",
      permittedLevers: ["organization strategy", "information sharing"],
      protectedFacts: ["fact:western-gate-wear"],
      forbiddenEffects: ["guaranteed success", "unearned consensus"],
    });
    assert.equal(guided.comparison.protectedPrefixVerified, true);
    assert.deepEqual(guided.interventionInputIds, []);
    assert.deepEqual(guided.comparison.newExternalInputIds, []);
    assert.equal(guided.guidance.at(-1)?.mode, "guided-search");
    assert.ok(guided.unresolvedUncertainty.some((value) => value.includes("does not guarantee")));
    assert.ok(guided.candidateRunId !== parent.run.manifest.runId);
    assert.deepEqual(guided.guidance.map((value) => value.id), store.loadAutonomousRun(compiled.worldId, guided.candidateRunId)?.run.manifest.guidanceIds);
    const guidedRun = store.loadAutonomousRun(compiled.worldId, guided.candidateRunId)!;
    assert.equal(verifyWorldReplay(compiled, guidedRun.run, schedule, guided.guidance).verified, true);
    assert.deepEqual(verifyWorldReplay(compiled, guidedRun.run, schedule).issues, ["guidance-id-mismatch"]);

    await assert.rejects(() => service.branchAtSelection(compiled, parent, schedule, {
      worldId: compiled.worldId,
      id: "request:wrong-target",
      parentRunId: parent.run.manifest.runId,
      mode: "intervention",
      target: { kind: "node", id: "route:lantern-causeway", fieldId: "maintenance", worldTime: 1100 },
      reason: "Must fail before a mismatched object can be changed.",
      action: { kind: "set-node-attribute", nodeId: "person:ilyra-veen", fieldId: "name", value: "wrong" },
    }), /does not write the selected target/i);
    await assert.rejects(() => service.branchAtSelection(compiled, parent, schedule, {
      worldId: compiled.worldId,
      id: "request:unknown-object",
      parentRunId: parent.run.manifest.runId,
      mode: "soft-guidance",
      target: { kind: "node", id: "organization:foreign", worldTime: 1100 },
      reason: "Must fail on an absent anchor object.",
      prompt: "Explore nothing.",
      permittedLevers: [], protectedFacts: [], forbiddenEffects: [],
    }), /does not exist at anchor/i);
    await assert.rejects(() => service.branchAtSelection(compiled, parent, schedule, {
      worldId: compiled.worldId,
      id: "request:late",
      parentRunId: parent.run.manifest.runId,
      mode: "soft-guidance",
      target: { kind: "node", id: "organization:tide-registry", worldTime: 999999 },
      reason: "Must fail beyond the plan.",
      prompt: "Explore later.",
      permittedLevers: [], protectedFacts: [], forbiddenEffects: [],
    }), /no causal boundary/i);
    store.close();

    const reopened = new SqliteWorldStore(database);
    assert.deepEqual(reopened.loadHistoryEvidence(compiled.worldId, positive.id), positive);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
