import { hash } from "../kernel/stable.ts";
import { compareAutonomousHistories, explainWorldState, traceCausalImpact, type WorldStateTarget } from "./causal-query.ts";
import { acceptCompilationCandidate, compileWorld as compileBlueprint } from "./compiler.ts";
import { createAnchoredBranch, type AnchoredBranchOptions } from "./history.ts";
import { assertWorldScope } from "./isolation.ts";
import { evolveAnchoredWorld, evolveWorld, type EvolveAnchoredWorldOptions, type EvolveWorldOptions } from "./evolution.ts";
import { executableMechanismLibrary, type ExecutableWorldMechanism } from "./mechanisms.ts";
import { projectAudit, projectKnowledgeGraph, projectSettingBook, projectTimeline } from "./projections.ts";
import { runWorld, verifyWorldReplay, type ResourceAdjustmentInput, type RunWorldOptions } from "./runtime.ts";
import { SqliteWorldStore } from "./store.ts";
import { theoryPackLibrary } from "./theory.ts";
import type {
  CompilationCandidate,
  CompiledWorldPackage,
  AutonomousWorldRun,
  AutonomousBranchResult,
  GraphTransitionInput,
  MechanismDefinition,
  TheoryPackDefinition,
  WorldBlueprint,
  WorldBranch,
  WorldCompilationResult,
  WorldProjection,
  WorldRunRecord,
  WorldSourceRecord,
} from "./types.ts";

export interface WorldEngineOptions {
  readonly store?: SqliteWorldStore;
  readonly mechanismLibrary: readonly MechanismDefinition[];
  readonly theoryLibrary?: readonly TheoryPackDefinition[];
  readonly executableMechanisms?: readonly ExecutableWorldMechanism[];
}

export interface BuildWorldResult {
  readonly compilation: WorldCompilationResult;
}

export class WorldEngine {
  readonly #store: SqliteWorldStore;
  readonly #mechanisms: readonly MechanismDefinition[];
  readonly #theories: readonly TheoryPackDefinition[];
  readonly #executableMechanisms: readonly ExecutableWorldMechanism[];

  constructor(options: WorldEngineOptions) {
    this.#store = options.store ?? new SqliteWorldStore();
    this.#mechanisms = options.mechanismLibrary;
    this.#theories = options.theoryLibrary ?? theoryPackLibrary;
    this.#executableMechanisms = options.executableMechanisms ?? executableMechanismLibrary;
  }

  get store(): SqliteWorldStore {
    return this.#store;
  }

  async build(
    blueprint: WorldBlueprint,
    sources: readonly WorldSourceRecord[],
  ): Promise<BuildWorldResult> {
    assertWorldScope(blueprint.worldId, sources.map((value) => ({ label: `Source ${value.id}`, value })));
    for (const source of sources) {
      if (source.contentHash !== hash(source.content)) throw new Error(`Source ${source.id} content hash is invalid`);
      this.#store.saveSource(blueprint.worldId, source);
    }
    const compilation = compileBlueprint(blueprint, this.#mechanisms, [], this.#theories);
    return { compilation };
  }

  accept(candidate: CompilationCandidate): CompiledWorldPackage {
    const compiled = acceptCompilationCandidate(candidate);
    this.#store.saveCompiledWorld(compiled.worldId, compiled);
    return compiled;
  }

  run(
    compiled: CompiledWorldPackage,
    inputs: readonly (GraphTransitionInput | ResourceAdjustmentInput)[],
    options: RunWorldOptions = {},
  ): WorldRunRecord {
    const run = runWorld(compiled, inputs, options);
    this.#store.saveRun(compiled.worldId, run);
    return run;
  }

  async evolve(
    compiled: CompiledWorldPackage,
    options: Pick<EvolveWorldOptions, "plan" | "schedule" | "seed" | "guidance" | "requireCausalClosure">,
  ): Promise<AutonomousWorldRun> {
    const autonomous = await evolveWorld(compiled, {
      ...options,
      mechanisms: this.#executableMechanisms,
    });
    this.#store.saveRun(compiled.worldId, autonomous.run);
    this.#store.saveAutonomousRun(compiled.worldId, autonomous);
    return autonomous;
  }

  async evolveBranch(
    compiled: CompiledWorldPackage,
    parent: AutonomousWorldRun,
    options: Omit<EvolveAnchoredWorldOptions, "mechanisms" | "modelProposer" | "onModelProposalSet">,
  ): Promise<AutonomousBranchResult> {
    const result = await evolveAnchoredWorld(compiled, parent, {
      ...options,
      mechanisms: this.#executableMechanisms,
    });
    this.#store.saveRun(compiled.worldId, result.autonomous.run);
    this.#store.saveAutonomousRun(compiled.worldId, result.autonomous);
    this.#store.saveBranch(compiled.worldId, result.branch);
    return result;
  }

  explain(autonomous: AutonomousWorldRun, target: WorldStateTarget) {
    return explainWorldState(autonomous, target);
  }

  traceImpact(autonomous: AutonomousWorldRun, rootInputIds: readonly string[]) {
    return traceCausalImpact(autonomous, rootInputIds);
  }

  compare(parent: AutonomousWorldRun, candidate: AutonomousWorldRun) {
    return compareAutonomousHistories(parent, candidate);
  }

  branch(
    compiled: CompiledWorldPackage,
    parent: WorldRunRecord,
    replacementSuffix: readonly GraphTransitionInput[],
    options: AnchoredBranchOptions,
  ): { readonly branch: WorldBranch; readonly run: WorldRunRecord } {
    const result = createAnchoredBranch(compiled, parent, replacementSuffix, options);
    this.#store.saveRun(compiled.worldId, result.run);
    this.#store.saveBranch(compiled.worldId, result.branch);
    return result;
  }

  projectAll(
    compiled: CompiledWorldPackage,
    run: WorldRunRecord,
    schedule?: import("./types.ts").SimulationSchedule,
    guidance: readonly import("./types.ts").GuidanceSpecification[] = [],
  ): Readonly<Record<string, WorldProjection>> {
    const replay = verifyWorldReplay(compiled, run, schedule, guidance);
    const projections: Readonly<Record<string, WorldProjection>> = {
      graph: projectKnowledgeGraph(run),
      timeline: projectTimeline(run),
      settingBook: projectSettingBook(compiled, run),
      audit: projectAudit(compiled, run, replay.verified ? "verified" : "mismatch"),
    };
    for (const [name, projection] of Object.entries(projections)) {
      this.#store.saveProjection(compiled.worldId, `projection:${compiled.worldId}:${run.manifest.runId}:${name}`, projection);
    }
    return projections;
  }
}
