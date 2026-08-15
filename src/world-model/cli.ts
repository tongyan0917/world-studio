import { compareAutonomousHistories, explainWorldState, traceCausalImpact } from "./causal-query.ts";
import { WorldEngine } from "./engine.ts";
import {
  mechanismLibrary,
  saltMarshBlueprint,
  saltMarshSources,
  xuanxiaoBlueprint,
  xuanxiaoSources,
} from "./examples.ts";
import { createDefaultMultiScaleSchedule, createDefaultWorldEvolutionPlan } from "./simulation.ts";
import { SqliteWorldStore } from "./store.ts";
import type {
  CompiledWorldPackage,
  WorldBlueprint,
  WorldSourceRecord,
} from "./types.ts";

interface Fixture {
  readonly blueprint: WorldBlueprint;
  readonly sources: readonly WorldSourceRecord[];
}

function fixture(name: string): Fixture {
  if (["salt", "salt-marsh", "world.salt-marsh"].includes(name)) return { blueprint: saltMarshBlueprint, sources: saltMarshSources };
  if (["xuanxiao", "xianxia", "nine-realms", "world.xuanxiao-nine-realms", "玄霄", "玄霄九域"].includes(name)) return { blueprint: xuanxiaoBlueprint, sources: xuanxiaoSources };
  throw new Error(`Unknown World ${name}; expected salt or xuanxiao`);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function compactExplanation(explanation: ReturnType<typeof explainWorldState>) {
  return {
    worldId: explanation.worldId,
    runId: explanation.runId,
    target: explanation.target,
    targetPath: explanation.targetPath,
    status: explanation.status,
    ...(explanation.currentValue === undefined ? {} : { currentValue: explanation.currentValue }),
    ...(explanation.rootEmissionId ? { rootEmissionId: explanation.rootEmissionId } : {}),
    ...(explanation.rootInputId ? { rootInputId: explanation.rootInputId } : {}),
    externalCauseInputIds: explanation.externalCauseInputIds,
    initialConditionPathCount: explanation.initialConditionPaths.length,
    stepCount: explanation.steps.length,
    steps: explanation.steps.map((step) => ({
      emissionId: step.emissionId,
      mechanismId: step.mechanismId,
      boundaryId: step.boundaryId,
      scale: step.scale,
      pass: step.pass,
      triggerSummary: step.triggerSummary,
      substantiveActionCount: step.substantiveActions.length,
      actionKinds: [...new Set(step.substantiveActions.map((action) => action.kind))],
      readPathCount: step.readPaths.length,
      writePaths: step.writePaths,
      dependencyLinkCount: step.dependencyLinks.length,
      predecessorEmissionCount: step.predecessorEmissionIds.length,
      predecessorInputIds: step.predecessorInputIds,
    })),
    truncated: explanation.truncated,
    explanationHash: explanation.explanationHash,
  };
}

function compactImpact(impact: ReturnType<typeof traceCausalImpact>) {
  return {
    worldId: impact.worldId,
    runId: impact.runId,
    rootInputIds: impact.rootInputIds,
    emissionCount: impact.emissionIds.length,
    boundaryIds: impact.boundaryIds,
    writtenPathCount: impact.writtenPaths.length,
    writtenPaths: impact.writtenPaths,
    impactHash: impact.impactHash,
  };
}

function compactComparison(comparison: ReturnType<typeof compareAutonomousHistories>) {
  return {
    worldId: comparison.worldId,
    parentRunId: comparison.parentRunId,
    candidateRunId: comparison.candidateRunId,
    commonPrefixInputCount: comparison.commonPrefixInputCount,
    protectedPrefixVerified: comparison.protectedPrefixVerified,
    ...(comparison.firstDivergence ? { firstDivergence: comparison.firstDivergence } : {}),
    newExternalInputIds: comparison.newExternalInputIds,
    changedPaths: comparison.changedPaths,
    auditChangedPathCount: comparison.auditChangedPaths.length,
    impactedEmissionCount: comparison.impactedEmissionIds.length,
    impactedBoundaryIds: comparison.impactedBoundaryIds,
    ...(comparison.firstAffectedBoundaryId ? { firstAffectedBoundaryId: comparison.firstAffectedBoundaryId } : {}),
    unattributedChangedPaths: comparison.unattributedChangedPaths,
    comparisonHash: comparison.comparisonHash,
  };
}

function acceptedBase(result: Awaited<ReturnType<WorldEngine["build"]>>, engine: WorldEngine): CompiledWorldPackage {
  if (!result.compilation.base.package) throw new Error(result.compilation.base.findings.map((finding) => `${finding.code}: ${finding.message}`).join("\n"));
  return engine.accept(result.compilation.base);
}

async function runAcceptance(databaseLocation: string): Promise<void> {
  const store = new SqliteWorldStore(databaseLocation);
  const engine = new WorldEngine({
    store,
    mechanismLibrary,
  });
  try {
    const summaries = [];
    for (const selected of [fixture("salt"), fixture("xuanxiao")]) {
      const built = await engine.build(selected.blueprint, selected.sources);
      const compiled = acceptedBase(built, engine);
      const focus = compiled.worldId === "world.salt-marsh" ? ["person:mara"] : ["cultivator:shen-qingluo"];
      const schedule = createDefaultMultiScaleSchedule(compiled.worldId, compiled.contract.hash, focus);
      const calendarStartYear = compiled.worldId === "world.salt-marsh" ? 230 : 612;
      const plan = createDefaultWorldEvolutionPlan(compiled.worldId, compiled.contract.hash, schedule, calendarStartYear);
      const autonomous = await engine.evolve(compiled, { plan, schedule, seed: `${compiled.worldId}:autonomous-acceptance-v1`, requireCausalClosure: true });
      const run = autonomous.run;
      const projections = engine.projectAll(compiled, run, schedule);
      summaries.push({
        worldId: compiled.worldId,
        blueprintLocalId: compiled.blueprint.id,
        contractHash: compiled.contract.hash,
        instanceId: compiled.instance.id,
        runId: run.manifest.runId,
        transitions: run.transitions.length,
        autonomousInputs: autonomous.generatedInputs.length,
        mechanismEmissions: autonomous.emissions.length,
        causallyLinkedEmissions: autonomous.closureAudit.causallyLinkedEmissionCount,
        causalDependencyEdges: autonomous.closureAudit.causalDependencyCount,
        statePathsRead: new Set(autonomous.emissions.flatMap((emission) => emission.readPaths)).size,
        statePathsWritten: new Set(autonomous.emissions.flatMap((emission) => emission.writePaths)).size,
        causalBoundaries: autonomous.boundaries.length,
        quiescent: autonomous.quiescent,
        dimensionsClosed: autonomous.dimensionsClosed,
        causalClosure: {
          status: autonomous.closureAudit.status,
          loops: autonomous.closureAudit.loops.map((loop) => ({ id: loop.id, closed: loop.closed, scales: loop.scales })),
          interactions: autonomous.closureAudit.interactions.length,
          crossBoundaryFeedbacks: autonomous.closureAudit.crossBoundaryFeedbackCount,
          auditHash: autonomous.closureAudit.auditHash,
        },
        finalStateHash: run.finalStateHash,
        graphNodes: projections.graph.kind === "knowledge-graph" ? projections.graph.nodes.length : 0,
        timelineEntries: projections.timeline.kind === "timeline" ? projections.timeline.entries.length : 0,
        emergentEvents: Object.values(run.finalSnapshot.nodes).filter((node) => node.type === "event").length,
        formedSettlements: Object.values(run.finalSnapshot.nodes).filter((node) => node.id.startsWith("settlement:formed:")).length,
        formedOrganizations: Object.values(run.finalSnapshot.nodes).filter((node) => node.id.startsWith("organization:formed:")).length,
      });
    }
    console.log(JSON.stringify({ status: "accepted", database: databaseLocation, worlds: summaries }, null, 2));
  } finally {
    store.close();
  }
}

const command = process.argv[2] ?? "acceptance";
const databaseLocation = flag("--db") ?? ":memory:";

switch (command) {
  case "acceptance":
  case "demo":
    await runAcceptance(databaseLocation);
    break;
  case "inspect": {
    if (databaseLocation === ":memory:") throw new Error("inspect requires --db <path>");
    const store = new SqliteWorldStore(databaseLocation);
    try {
      const worldId = flag("--world");
      const runId = flag("--run");
      if (runId && !worldId) throw new Error("inspect --run requires --world <worldId>");
      if (worldId && runId) {
        const autonomous = store.loadAutonomousRun(worldId, runId);
        if (!autonomous) throw new Error(`No autonomous Run ${runId} exists in ${worldId}`);
        console.log(JSON.stringify(autonomous, null, 2));
      } else if (worldId) {
        console.log(JSON.stringify({ worldId, autonomousRuns: store.listAutonomousRuns(worldId) }, null, 2));
      } else {
        console.log(JSON.stringify({ worlds: store.listWorlds().map((world) => ({ ...world, autonomousRuns: store.listAutonomousRuns(world.worldId) })) }, null, 2));
      }
    } finally {
      store.close();
    }
    break;
  }
  case "explain": {
    if (databaseLocation === ":memory:") throw new Error("explain requires --db <path>");
    const worldId = flag("--world");
    const runId = flag("--run");
    const kind = flag("--kind");
    const id = flag("--id");
    if (!worldId || !runId || !id || !["node", "edge", "fact"].includes(kind ?? "")) throw new Error("explain requires --world, --run, --kind node|edge|fact, and --id");
    const store = new SqliteWorldStore(databaseLocation);
    try {
      const autonomous = store.loadAutonomousRun(worldId, runId);
      if (!autonomous) throw new Error(`No autonomous Run ${runId} exists in ${worldId}`);
      const maximumSteps = Number(flag("--max-steps") ?? 128);
      const explanation = explainWorldState(autonomous, { kind: kind as "node" | "edge" | "fact", id, ...(flag("--field") ? { fieldId: flag("--field")! } : {}) }, maximumSteps);
      console.log(JSON.stringify(hasFlag("--full") ? explanation : compactExplanation(explanation), null, 2));
    } finally {
      store.close();
    }
    break;
  }
  case "impact": {
    if (databaseLocation === ":memory:") throw new Error("impact requires --db <path>");
    const worldId = flag("--world");
    const runId = flag("--run");
    const inputIds = process.argv.flatMap((value, index, values) => value === "--input" && values[index + 1] ? [values[index + 1]!] : []);
    if (!worldId || !runId || inputIds.length === 0) throw new Error("impact requires --world, --run, and one or more --input <inputId>");
    const store = new SqliteWorldStore(databaseLocation);
    try {
      const autonomous = store.loadAutonomousRun(worldId, runId);
      if (!autonomous) throw new Error(`No autonomous Run ${runId} exists in ${worldId}`);
      const impact = traceCausalImpact(autonomous, inputIds);
      console.log(JSON.stringify(hasFlag("--full") ? impact : compactImpact(impact), null, 2));
    } finally {
      store.close();
    }
    break;
  }
  case "compare": {
    if (databaseLocation === ":memory:") throw new Error("compare requires --db <path>");
    const worldId = flag("--world");
    const parentRunId = flag("--parent");
    const candidateRunId = flag("--candidate");
    if (!worldId || !parentRunId || !candidateRunId) throw new Error("compare requires --world, --parent, and --candidate");
    const store = new SqliteWorldStore(databaseLocation);
    try {
      const parent = store.loadAutonomousRun(worldId, parentRunId);
      const candidate = store.loadAutonomousRun(worldId, candidateRunId);
      if (!parent || !candidate) throw new Error("Both autonomous Runs must exist in the selected World");
      const comparison = compareAutonomousHistories(parent, candidate);
      console.log(JSON.stringify(hasFlag("--full") ? comparison : compactComparison(comparison), null, 2));
    } finally {
      store.close();
    }
    break;
  }
  default:
    throw new Error(`Unknown command ${command}. Use acceptance, inspect, explain, impact, or compare.`);
}
