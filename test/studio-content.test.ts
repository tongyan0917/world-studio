import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileCreatorWorldDefinition, type CreatorWorldDefinition } from "../src/studio/authoring.ts";
import { exportSettingBook } from "../src/studio/export.ts";
import { createWikiPage } from "../src/studio/wiki.ts";
import { WorldEngine } from "../src/world-model/engine.ts";
import { mechanismLibrary } from "../src/world-model/examples.ts";
import { createDefaultMultiScaleSchedule, createDefaultWorldEvolutionPlan } from "../src/world-model/simulation.ts";
import { SqliteWorldStore } from "../src/world-model/store.ts";

function definition(): CreatorWorldDefinition {
  return JSON.parse(readFileSync(new URL("./fixtures/lantern-delta.world.json", import.meta.url), "utf8")) as CreatorWorldDefinition;
}

test("Wiki search/backlinks and setting-book export share the persisted World/Run authority path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "world-studio-content-"));
  const database = join(directory, "world-studio.sqlite");
  try {
    const store = new SqliteWorldStore(database);
    const engine = new WorldEngine({ store, mechanismLibrary });
    const input = compileCreatorWorldDefinition(definition());
    const built = await engine.build(input.blueprint, input.sources);
    const compiled = engine.accept(built.compilation.base);
    assert.deepEqual(store.loadCompiledWorld(compiled.worldId), { ...compiled, findings: [] });

    const gates = createWikiPage(compiled.worldId, {
      slug: "western-gates",
      title: "Western Gates",
      markdown: "# Western Gates\n\nThe hinge inspection remains uncertain. #infrastructure #risk",
    }, 1);
    store.saveWikiPage(gates, 0);
    const registry = createWikiPage(compiled.worldId, {
      slug: "tide-registry",
      title: "Tide Registry",
      markdown: "# Tide Registry\n\nMaintains public ledgers for [[Western Gates]]. #organization",
    }, 1);
    store.saveWikiPage(registry, 0);
    assert.deepEqual(store.loadWikiPage(compiled.worldId, gates.slug)?.backlinks, [{ id: registry.id, slug: registry.slug, title: registry.title }]);
    assert.deepEqual(store.searchWikiPages(compiled.worldId, "public organization").map((page) => page.id), [registry.id]);
    assert.throws(() => store.saveWikiPage(createWikiPage(compiled.worldId, { ...registry, markdown: "stale" }, 2), 0), /revision conflict/i);

    const revised = createWikiPage(compiled.worldId, { ...registry, markdown: `${registry.markdown}\n\nThe repair compact is disputed.` }, 2);
    store.saveWikiPage(revised, 1);
    const schedule = createDefaultMultiScaleSchedule(compiled.worldId, compiled.contract.hash, ["person:ilyra-veen"]);
    const plan = createDefaultWorldEvolutionPlan(compiled.worldId, compiled.contract.hash, schedule, 320);
    const autonomous = await engine.evolve(compiled, { plan, schedule, seed: "content-export", requireCausalClosure: true });
    const exported = exportSettingBook(compiled, autonomous);
    store.saveSettingBookExport(exported);
    assert.match(exported.markdown, /^# Lantern Delta/m);
    assert.match(exported.markdown, /## 地理、环境与聚落/);
    assert.doesNotMatch(exported.markdown, /mechanism-boundary-evaluation/);
    assert.match(exported.markdown, /## Provenance manifest/);
    assert.equal(exported.manifest.sourceStateHash, autonomous.run.finalStateHash);
    store.close();

    const reopened = new SqliteWorldStore(database);
    assert.equal(reopened.schemaVersion(), 5);
    assert.equal(reopened.loadWikiPage(compiled.worldId, registry.slug)?.revision, 2);
    assert.deepEqual(reopened.loadSettingBookExport(compiled.worldId, exported.id), exported);
    assert.equal(reopened.loadLatestAutonomousRun(compiled.worldId)?.run.manifest.runId, autonomous.run.manifest.runId);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
