import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileCreatorWorldDefinition, type CreatorWorldDefinition } from "../src/studio/authoring.ts";
import {
  advanceRunControl,
  createRunControl,
  requestRunPause,
  resumeRunControl,
  startRunControl,
} from "../src/studio/run-control.ts";
import { WorldEngine } from "../src/world-model/engine.ts";
import { mechanismLibrary } from "../src/world-model/examples.ts";
import { createDefaultMultiScaleSchedule, createDefaultWorldEvolutionPlan } from "../src/world-model/simulation.ts";
import { SqliteWorldStore } from "../src/world-model/store.ts";

function definition(): CreatorWorldDefinition {
  return JSON.parse(readFileSync(new URL("./fixtures/lantern-delta.world.json", import.meta.url), "utf8")) as CreatorWorldDefinition;
}

test("run control pauses only between committed boundaries and resumes to the exact uninterrupted history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "world-studio-run-control-"));
  const database = join(directory, "world-studio.sqlite");
  try {
    const store = new SqliteWorldStore(database);
    const engine = new WorldEngine({ store, mechanismLibrary });
    const input = compileCreatorWorldDefinition(definition());
    const built = await engine.build(input.blueprint, input.sources);
    const compiled = engine.accept(built.compilation.base);
    const schedule = createDefaultMultiScaleSchedule(compiled.worldId, compiled.contract.hash, ["person:ilyra-veen"]);
    const plan = createDefaultWorldEvolutionPlan(compiled.worldId, compiled.contract.hash, schedule, 320);
    const uninterrupted = await engine.evolve(compiled, { plan, schedule, seed: "pause-resume-identity", requireCausalClosure: true });

    let control = createRunControl(compiled, plan, schedule, { seed: "pause-resume-identity", controlId: "control:acceptance" });
    store.saveRunControl(control, 0);
    control = startRunControl(control);
    store.saveRunControl(control, 1);
    control = await advanceRunControl(compiled, control);
    assert.equal(control.status, "running");
    assert.equal(control.nextBoundaryIndex, 1);
    assert.equal(control.checkpoint?.boundaries.length, 1);
    assert.ok(control.checkpoint?.boundaries[0]?.quiescent);
    store.saveRunControl(control, 2);

    control = requestRunPause(control);
    store.saveRunControl(control, 3);
    const paused = await advanceRunControl(compiled, control);
    assert.equal(paused.status, "paused");
    assert.equal(paused.nextBoundaryIndex, 1);
    assert.equal(paused.checkpoint?.run.finalStateHash, control.checkpoint?.run.finalStateHash);
    store.saveRunControl(paused, 4);
    store.close();

    const reopened = new SqliteWorldStore(database);
    control = reopened.loadRunControl(compiled.worldId, paused.id)!;
    assert.equal(control.status, "paused");
    control = resumeRunControl(control);
    reopened.saveRunControl(control, 5);
    while (control.status === "running") {
      const previousRevision = control.revision;
      control = await advanceRunControl(compiled, control);
      reopened.saveRunControl(control, previousRevision);
    }
    assert.equal(control.status, "complete");
    assert.equal(control.nextBoundaryIndex, plan.boundaries.length);
    assert.deepEqual(control.checkpoint, uninterrupted);
    assert.equal(control.finalRunId, uninterrupted.run.manifest.runId);
    assert.throws(() => resumeRunControl(control), /completed run control/i);
    assert.throws(() => requestRunPause(control), /cannot pause/i);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("run controls reject foreign Worlds, stale revisions, and illegal transitions without mutating stored state", async () => {
  const store = new SqliteWorldStore();
  try {
    const engine = new WorldEngine({ store, mechanismLibrary });
    const input = compileCreatorWorldDefinition(definition());
    const built = await engine.build(input.blueprint, input.sources);
    const compiled = engine.accept(built.compilation.base);
    const schedule = createDefaultMultiScaleSchedule(compiled.worldId, compiled.contract.hash);
    const plan = createDefaultWorldEvolutionPlan(compiled.worldId, compiled.contract.hash, schedule, 320);
    const control = createRunControl(compiled, plan, schedule, { seed: "fail-closed", controlId: "control:fail-closed" });
    store.saveRunControl(control, 0);
    assert.throws(() => store.saveRunControl(startRunControl(control), 0), /revision conflict/i);
    assert.equal(store.loadRunControl(compiled.worldId, control.id)?.revision, 1);
    assert.equal(store.loadRunControl("world.salt-marsh", control.id), undefined);
    await assert.rejects(() => advanceRunControl(compiled, control), /must be running/i);
    assert.throws(() => requestRunPause(control), /cannot pause/i);
  } finally {
    store.close();
  }
});
