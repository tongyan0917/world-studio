import { hash, stableStringify } from "../kernel/stable.ts";
import { graphActionWritePath, worldStateTargetPath, writerForWorldReadPath } from "./causal-path.ts";
import { assertCompiledWorldIsolation, assertWorldScope, WorldIsolationError } from "./isolation.ts";
import {
  executableMechanismLibrary,
  type EvolutionModelProposer,
  type ExecutableWorldMechanism,
} from "./mechanisms.ts";
import { WorldRuntimeSession, type RunWorldOptions } from "./runtime.ts";
import { validateWorldEvolutionPlan } from "./simulation.ts";
import type {
  AutonomousWorldRun,
  AutonomousBranchResult,
  CausalClosureAudit,
  CausalBoundaryRecord,
  CausalDimension,
  CausalInteractionRecord,
  CausalLoopEvidence,
  CompiledWorldPackage,
  GraphTransitionInput,
  GraphWorldAction,
  GuidanceSpecification,
  MechanismEmissionRecord,
  SimulationSchedule,
  TransitionProposalSet,
  WorldEvolutionPlan,
  WorldBranch,
  WorldRunRecord,
} from "./types.ts";

export interface EvolveWorldOptions {
  readonly plan: WorldEvolutionPlan;
  readonly schedule: SimulationSchedule;
  readonly seed?: string;
  readonly guidance?: readonly GuidanceSpecification[];
  readonly mechanisms?: readonly ExecutableWorldMechanism[];
  readonly modelProposer?: EvolutionModelProposer;
  readonly run?: Omit<RunWorldOptions, "schedule" | "seed">;
  readonly onModelProposalSet?: (proposalSet: TransitionProposalSet) => void | Promise<void>;
  /** Internal/public replay hooks used by Anchored autonomous evolution. */
  readonly prefixInputs?: readonly GraphTransitionInput[];
  readonly externalInputs?: readonly GraphTransitionInput[];
  readonly inheritedExternalInputs?: readonly GraphTransitionInput[];
  readonly inheritedGeneratedInputs?: readonly GraphTransitionInput[];
  readonly inheritedEmissions?: readonly MechanismEmissionRecord[];
  readonly inheritedBoundaries?: readonly CausalBoundaryRecord[];
  readonly startBoundaryIndex?: number;
  /** Execute only through this exclusive boundary index; used for committed-boundary checkpoints. */
  readonly endBoundaryIndexExclusive?: number;
  /** Fail closed unless the completed run proves all required dimensions, scales, and feedback loops. */
  readonly requireCausalClosure?: boolean;
}

export interface ExecutableCoverageFinding {
  readonly code: "missing-executable-mechanism" | "version-mismatch" | "duplicate-process-id" | "invalid-causal-ports";
  readonly mechanismId: string;
  readonly message: string;
}

export function validateExecutableMechanismCoverage(
  compiled: CompiledWorldPackage,
  mechanisms: readonly ExecutableWorldMechanism[],
): ExecutableCoverageFinding[] {
  const findings: ExecutableCoverageFinding[] = [];
  const processIds = new Set<string>();
  for (const mechanism of mechanisms) {
    if (processIds.has(mechanism.id)) findings.push({ code: "duplicate-process-id", mechanismId: mechanism.mechanismId, message: `Duplicate executable process ${mechanism.id}` });
    processIds.add(mechanism.id);
    const declared = new Set(mechanism.dimensions);
    const ports = [...mechanism.reads, ...mechanism.writes];
    if (mechanism.reads.length === 0 || mechanism.writes.length === 0 || new Set(mechanism.reads).size !== mechanism.reads.length || new Set(mechanism.writes).size !== mechanism.writes.length || ports.some((dimension) => !declared.has(dimension))) {
      findings.push({ code: "invalid-causal-ports", mechanismId: mechanism.mechanismId, message: `Executable process ${mechanism.id} must declare unique, non-empty read/write dimensions contained in its dimension set.` });
    }
  }
  for (const selection of compiled.contract.mechanisms) {
    const implementations = mechanisms.filter((mechanism) => mechanism.mechanismId === selection.id);
    if (implementations.length === 0) {
      findings.push({ code: "missing-executable-mechanism", mechanismId: selection.id, message: `Selected Contract Mechanism ${selection.id}@${selection.version} has no executable process.` });
      continue;
    }
    if (!implementations.some((mechanism) => mechanism.version === selection.version)) findings.push({ code: "version-mismatch", mechanismId: selection.id, message: `Selected Contract Mechanism ${selection.id}@${selection.version} has no version-matched executable process.` });
  }
  return findings.sort((left, right) => left.mechanismId.localeCompare(right.mechanismId) || left.code.localeCompare(right.code));
}

const requiredDimensions: readonly CausalDimension[] = [
  "environment", "space", "resource", "economy", "population", "organization", "institution",
  "information", "psychology", "relationship", "conflict", "hazard", "world-specific", "cross-scale",
];
const requiredScales = ["macro", "meso", "micro"] as const;
const loopRequirements: readonly { readonly id: string; readonly path: readonly CausalDimension[]; readonly minimumScales: number }[] = [
  { id: "loop.material-ecology", path: ["environment", "resource", "population", "environment"], minimumScales: 3 },
  { id: "loop.political-economy", path: ["economy", "organization", "institution", "economy"], minimumScales: 3 },
  { id: "loop.agency-conflict", path: ["information", "psychology", "relationship", "conflict", "organization", "information"], minimumScales: 2 },
  { id: "loop.cross-scale", path: ["cross-scale", "environment", "resource", "population", "cross-scale"], minimumScales: 3 },
];

function trackedStatePath(parts: readonly string[]): string | undefined {
  if (parts[0] === "nodes" && parts.length === 2) return worldStateTargetPath({ kind: "node", id: parts[1]! });
  if (parts[0] === "nodes" && parts[2] === "attributes" && parts.length === 4) return worldStateTargetPath({ kind: "node", id: parts[1]!, fieldId: parts[3]! });
  if (parts[0] === "edges" && parts.length === 2) return worldStateTargetPath({ kind: "edge", id: parts[1]! });
  if (parts[0] === "edges" && parts[2] === "attributes" && parts.length === 4) return worldStateTargetPath({ kind: "edge", id: parts[1]!, fieldId: parts[3]! });
  if (parts[0] === "facts" && parts.length === 2) return worldStateTargetPath({ kind: "fact", id: parts[1]! });
  return undefined;
}

function trackSnapshotReads(snapshot: CompiledWorldPackage["instance"]["initialSnapshot"]): { readonly snapshot: CompiledWorldPackage["instance"]["initialSnapshot"]; readonly paths: Set<string> } {
  const paths = new Set<string>();
  const wrap = (value: unknown, parts: readonly string[]): unknown => {
    if (value === null || typeof value !== "object") return value;
    return new Proxy(value as Record<PropertyKey, unknown>, {
      get(target, property, receiver) {
        const result = Reflect.get(target, property, receiver);
        if (typeof property === "symbol") return result;
        const nextParts = [...parts, String(property)];
        const path = trackedStatePath(nextParts);
        if (path) paths.add(path);
        return wrap(result, nextParts);
      },
      has(target, property) {
        if (typeof property !== "symbol") {
          const path = trackedStatePath([...parts, String(property)]);
          if (path) paths.add(path);
        }
        return Reflect.has(target, property);
      },
      ownKeys(target) {
        const keys = Reflect.ownKeys(target);
        for (const property of keys) if (typeof property !== "symbol") {
          const path = trackedStatePath([...parts, String(property)]);
          if (path) paths.add(path);
        }
        return keys;
      },
    });
  };
  return { snapshot: wrap(snapshot, []) as CompiledWorldPackage["instance"]["initialSnapshot"], paths };
}

function substantiveEffect(action: GraphWorldAction): boolean {
  return action.kind !== "assert-fact" || !["mechanism-boundary-evaluation", "bounded-model-proposal-selected"].includes(action.fact.predicate);
}

type CausalWriter = { readonly kind: "emission" | "input"; readonly id: string };

function deepFreezeArtifact<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeArtifact(child);
    Object.freeze(value);
  }
  return value;
}

function materializeJson<T>(value: T): T {
  return JSON.parse(stableStringify(value)) as T;
}

export function auditCausalClosure(
  worldId: string,
  emissions: readonly MechanismEmissionRecord[],
  boundaries: readonly CausalBoundaryRecord[],
): CausalClosureAudit {
  const aggregate = new Map<string, { from: CausalDimension; to: CausalDimension; mechanismIds: Set<string>; boundaryIds: Set<string>; occurrences: number }>();
  const substantiveEmissions = emissions.filter((emission) => emission.substantiveProposalIds.length > 0 && emission.readPaths.length > 0 && emission.writePaths.length > 0);
  for (const emission of substantiveEmissions) {
    const concreteReadDimensions = emission.readPathDimensions.flatMap((binding) => binding.dimensions);
    const concreteWriteDimensions = emission.writePathDimensions.flatMap((binding) => binding.dimensions);
    for (const from of concreteReadDimensions) for (const to of concreteWriteDimensions) {
      const key = `${from}->${to}`;
      const current = aggregate.get(key) ?? { from, to, mechanismIds: new Set<string>(), boundaryIds: new Set<string>(), occurrences: 0 };
      current.mechanismIds.add(`${emission.mechanismId}@${emission.mechanismVersion}`);
      current.boundaryIds.add(emission.boundaryId);
      current.occurrences += 1;
      aggregate.set(key, current);
    }
  }
  const interactions: CausalInteractionRecord[] = [...aggregate.values()].map((value) => ({
    from: value.from,
    to: value.to,
    mechanismIds: [...value.mechanismIds].sort(),
    boundaryIds: [...value.boundaryIds].sort(),
    occurrences: value.occurrences,
  })).sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  const byLink = new Map(interactions.map((interaction) => [`${interaction.from}->${interaction.to}`, interaction]));
  const boundaryById = new Map(boundaries.map((record) => [record.boundary.id, record.boundary]));
  const loops: CausalLoopEvidence[] = loopRequirements.map((requirement) => {
    const links = requirement.path.slice(0, -1).map((from, index) => `${from}->${requirement.path[index + 1]!}`);
    const present = links.map((link) => byLink.get(link));
    const boundaryIds = [...new Set(present.flatMap((interaction) => interaction?.boundaryIds ?? []))].sort();
    const scales = [...new Set(boundaryIds.map((id) => boundaryById.get(id)?.scale).filter((scale): scale is "macro" | "meso" | "micro" => Boolean(scale)))].sort();
    const missingLinks = links.filter((_, index) => !present[index]);
    return {
      id: requirement.id,
      dimensionPath: requirement.path,
      minimumScales: requirement.minimumScales,
      scales,
      mechanismIds: [...new Set(present.flatMap((interaction) => interaction?.mechanismIds ?? []))].sort(),
      boundaryIds,
      missingLinks,
      closed: missingLinks.length === 0 && scales.length >= requirement.minimumScales,
    };
  });
  const activatedDimensions = [...new Set(substantiveEmissions.flatMap((emission) => [
    ...emission.readPathDimensions.flatMap((binding) => binding.dimensions),
    ...emission.writePathDimensions.flatMap((binding) => binding.dimensions),
  ]))].sort() as CausalDimension[];
  const missingDimensions = requiredDimensions.filter((dimension) => !activatedDimensions.includes(dimension));
  const scalesActivated = [...new Set(boundaries.filter((boundary) => boundary.emissionIds.length > 0).map((boundary) => boundary.boundary.scale))].sort();
  const missingScales = requiredScales.filter((scale) => !scalesActivated.includes(scale));
  const emissionById = new Map(substantiveEmissions.map((emission) => [emission.id, emission]));
  const causalDependencyCount = substantiveEmissions.reduce((total, emission) => total + emission.causalPredecessorEmissionIds.length + emission.causalPredecessorInputIds.length, 0);
  const causallyLinkedEmissionCount = substantiveEmissions.filter((emission) => emission.causalPredecessorEmissionIds.length > 0 || emission.causalPredecessorInputIds.length > 0).length;
  const crossBoundaryFeedbacks = new Set<string>();
  for (const emission of substantiveEmissions) for (const predecessorId of emission.causalPredecessorEmissionIds) {
    const predecessor = emissionById.get(predecessorId);
    if (predecessor && predecessor.boundaryId !== emission.boundaryId) crossBoundaryFeedbacks.add(`${predecessor.id}->${emission.id}`);
  }
  const core = {
    worldId,
    status: (missingDimensions.length === 0 && missingScales.length === 0 && loops.every((loop) => loop.closed) && causalDependencyCount > 0 && crossBoundaryFeedbacks.size > 0 ? "closed" : "incomplete") as "closed" | "incomplete",
    requiredDimensions,
    activatedDimensions,
    missingDimensions,
    scalesActivated,
    missingScales,
    interactions,
    loops,
    causalDependencyCount,
    causallyLinkedEmissionCount,
    crossBoundaryFeedbackCount: crossBoundaryFeedbacks.size,
  } as const;
  return { ...core, auditHash: hash(core) };
}

function selectedProcesses(
  compiled: CompiledWorldPackage,
  mechanisms: readonly ExecutableWorldMechanism[],
): ExecutableWorldMechanism[] {
  const selected = new Map(compiled.contract.mechanisms.map((mechanism) => [mechanism.id, mechanism.version]));
  return mechanisms
    .filter((mechanism) => selected.get(mechanism.mechanismId) === mechanism.version)
    .sort((left, right) => left.stage - right.stage || left.id.localeCompare(right.id));
}

function intersects(left: readonly CausalDimension[] | undefined, right: readonly CausalDimension[]): boolean {
  if (!left || left.length === 0) return true;
  const allowed = new Set(left);
  return right.some((dimension) => allowed.has(dimension));
}

function frameFocus(schedule: SimulationSchedule, frameId: string): readonly string[] {
  return schedule.frames.find((frame) => frame.id === frameId)?.subjectIds ?? [];
}

/**
 * Execute a bounded autonomous history.
 *
 * Callers provide initial conditions plus causal boundaries. Outcomes are never
 * accepted as plan input: each versioned Mechanism reads the latest committed
 * snapshot, emits typed effects, and the ordinary Kernel authority path commits
 * them. Every boundary repeats until no process can emit another proposal.
 */
export async function evolveWorld(
  compiled: CompiledWorldPackage,
  options: EvolveWorldOptions,
): Promise<AutonomousWorldRun> {
  assertCompiledWorldIsolation(compiled);
  assertWorldScope(compiled.worldId, [
    { label: "Evolution Plan", value: options.plan },
    { label: "Simulation Schedule", value: options.schedule },
    ...(options.guidance ?? []).map((value) => ({ label: `Guidance ${value.id}`, value })),
  ]);
  if (options.plan.contractHash !== compiled.contract.hash) throw new WorldIsolationError("Evolution Plan is bound to another Contract");
  if (options.schedule.contractHash !== compiled.contract.hash) throw new WorldIsolationError("Simulation Schedule is bound to another Contract");
  const planIssues = validateWorldEvolutionPlan(options.plan, options.schedule);
  if (planIssues.length > 0) throw new Error(`Invalid World Evolution Plan: ${planIssues.join("; ")}`);

  const library = options.mechanisms ?? executableMechanismLibrary;
  const coverage = validateExecutableMechanismCoverage(compiled, library);
  if (coverage.length > 0) throw new Error(`Executable Mechanism coverage failed: ${coverage.map((finding) => finding.message).join("; ")}`);
  const processes = selectedProcesses(compiled, library);
  const seed = options.seed ?? `${compiled.worldId}:autonomous-evolution-v1`;
  const generatedInputs: GraphTransitionInput[] = [...structuredClone(options.inheritedGeneratedInputs ?? [])];
  const newExternalInputs: GraphTransitionInput[] = [...structuredClone(options.externalInputs ?? [])];
  const externalInputs: GraphTransitionInput[] = [...structuredClone(options.inheritedExternalInputs ?? []), ...newExternalInputs];
  const emissions: MechanismEmissionRecord[] = [...structuredClone(options.inheritedEmissions ?? [])];
  const boundaryRecords: CausalBoundaryRecord[] = [...structuredClone(options.inheritedBoundaries ?? [])];
  const guidance = [...structuredClone(options.guidance ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(guidance.map((value) => value.id)).size !== guidance.length) throw new Error("Evolution guidance ids must be unique");
  const session = new WorldRuntimeSession(compiled, { ...(options.run ?? {}), schedule: options.schedule, seed, guidance });
  if (options.prefixInputs?.length) session.commit(options.prefixInputs);
  if (newExternalInputs.length) session.commit(newExternalInputs);
  const committedInputIds = new Set([...(options.prefixInputs ?? []).map((input) => input.id), ...newExternalInputs.map((input) => input.id)]);
  const writerByPath = new Map<string, CausalWriter>();
  const inheritedEmissionByProposalId = new Map(emissions.flatMap((emission) => emission.proposalIds.map((proposalId) => [proposalId, emission.id] as const)));
  for (const input of options.prefixInputs ?? []) {
    const emissionId = inheritedEmissionByProposalId.get(input.id);
    writerByPath.set(graphActionWritePath(input.action), emissionId ? { kind: "emission", id: emissionId } : { kind: "input", id: input.id });
  }
  for (const input of newExternalInputs) writerByPath.set(graphActionWritePath(input.action), { kind: "input", id: input.id });
  let currentSnapshot = session.snapshot();
  let currentStateHash = session.stateHash();

  const startBoundaryIndex = options.startBoundaryIndex ?? 0;
  const endBoundaryIndexExclusive = options.endBoundaryIndexExclusive ?? options.plan.boundaries.length;
  if (!Number.isSafeInteger(startBoundaryIndex) || startBoundaryIndex < 0 || startBoundaryIndex > options.plan.boundaries.length) throw new RangeError("startBoundaryIndex is outside the Evolution Plan");
  if (!Number.isSafeInteger(endBoundaryIndexExclusive) || endBoundaryIndexExclusive < startBoundaryIndex || endBoundaryIndexExclusive > options.plan.boundaries.length) throw new RangeError("endBoundaryIndexExclusive is outside the Evolution Plan");

  for (const boundary of options.plan.boundaries.slice(startBoundaryIndex, endBoundaryIndexExclusive)) {
    const startStateHash = currentStateHash;
    const boundaryEmissionIds: string[] = [];
    const boundaryProposalIds: string[] = [];
    const boundaryDimensions = new Set<CausalDimension>();
    let quiescent = false;
    let completedPasses = 0;

    for (let pass = 0; pass < options.plan.maximumCausalPassesPerBoundary; pass += 1) {
      completedPasses = pass + 1;
      let proposalsThisPass = 0;
      for (const process of processes) {
        if (!process.scales.includes(boundary.scale)) continue;
        if (!intersects(boundary.activeDimensions, process.dimensions)) continue;
        const readStateHash = currentStateHash;
        const tracked = trackSnapshotReads(currentSnapshot);
        const evaluation = materializeJson(await process.evaluate({
          compiled,
          snapshot: tracked.snapshot,
          boundary,
          seed,
          pass,
          focusSubjectIds: frameFocus(options.schedule, boundary.frameId),
          ...(options.modelProposer ? { modelProposer: options.modelProposer } : {}),
        }));
        if (evaluation.effects.length === 0) continue;
        const ignoredFactPaths = new Set(Object.values(currentSnapshot.facts)
          .filter((fact) => ["mechanism-boundary-evaluation", "bounded-model-proposal-selected"].includes(fact.predicate))
          .map((fact) => worldStateTargetPath({ kind: "fact", id: fact.id })));
        const readPaths = [...tracked.paths].filter((path) => !ignoredFactPaths.has(path)).sort();
        if (evaluation.proposalSet && options.onModelProposalSet) await options.onModelProposalSet(evaluation.proposalSet);
        const generated = evaluation.effects.map((effect, index): GraphTransitionInput => ({
          worldId: compiled.worldId,
          id: `input:auto:${hash({ worldId: compiled.worldId, plan: options.plan.planHash, boundary: boundary.id, pass, process: process.id, localId: effect.localId, index, readStateHash, action: effect.action }).slice(0, 28)}`,
          mechanismId: process.mechanismId,
          worldTime: boundary.worldTime,
          causalPhase: pass * 100_000 + process.stage * 100 + (effect.phaseOffset ?? (effect.action.kind === "assert-fact" ? 5 : 0)),
          frameId: boundary.frameId,
          action: effect.action,
          causalReadPaths: readPaths,
          readDimensions: [...process.reads].sort(),
          writeDimensions: [...process.writes].sort(),
          origin: "mechanism-generated",
          provenance: [`process:${process.id}@${process.version}`, `boundary:${boundary.id}`, `read-state:${readStateHash}`],
          ...(effect.causalParents ? { causalParents: effect.causalParents } : {}),
        }));
        const markerProposalIds = generated.filter((_, index) => {
          const action = evaluation.effects[index]?.action;
          return action ? !substantiveEffect(action) : false;
        }).map((input) => input.id);
        const markerSet = new Set(markerProposalIds);
        const substantiveProposalIds = generated.filter((input) => !markerSet.has(input.id)).map((input) => input.id);
        const substantiveProposalSet = new Set(substantiveProposalIds);
        const writePaths = [...new Set(generated.filter((input) => substantiveProposalSet.has(input.id)).map((input) => graphActionWritePath(input.action)))].sort();
        const predecessorWriters = [...new Map(readPaths
          .map((path) => writerForWorldReadPath(writerByPath, path))
          .filter((writer): writer is CausalWriter => Boolean(writer))
          .map((writer) => [`${writer.kind}:${writer.id}`, writer])).values()];
        const duplicates = generated.filter((candidate) => committedInputIds.has(candidate.id));
        if (duplicates.length > 0) throw new Error(`Executable process ${process.id} emitted duplicate proposal ids: ${duplicates.map((value) => value.id).join(", ")}`);
        generatedInputs.push(...generated);
        for (const input of generated) committedInputIds.add(input.id);
        proposalsThisPass += generated.length;
        boundaryProposalIds.push(...generated.map((input) => input.id));
        if (substantiveProposalIds.length > 0) for (const dimension of process.dimensions) boundaryDimensions.add(dimension);
        const emissionCore = {
          worldId: compiled.worldId,
          boundaryId: boundary.id,
          pass,
          stage: process.stage,
          mechanismId: process.mechanismId,
          mechanismVersion: process.version,
          dimensions: process.dimensions,
          readDimensions: process.reads,
          writeDimensions: process.writes,
          readPaths,
          writePaths,
          readPathDimensions: readPaths.map((path) => ({ path, dimensions: [...process.reads].sort() })),
          writePathDimensions: writePaths.map((path) => ({ path, dimensions: [...process.writes].sort() })),
          causalPredecessorEmissionIds: predecessorWriters.filter((writer) => writer.kind === "emission").map((writer) => writer.id).sort(),
          causalPredecessorInputIds: predecessorWriters.filter((writer) => writer.kind === "input").map((writer) => writer.id).sort(),
          readStateHash,
          proposalIds: generated.map((input) => input.id),
          substantiveProposalIds,
          markerProposalIds,
          triggerSummary: evaluation.triggerSummary,
          ...(evaluation.modelInvocationId ? { modelInvocationId: evaluation.modelInvocationId } : {}),
          ...(evaluation.proposalSet ? { modelProposalSetId: evaluation.proposalSet.id } : {}),
        } as const;
        try {
          session.commit(generated);
          currentSnapshot = session.snapshot();
          currentStateHash = session.stateHash();
        } catch (error) {
          throw new Error(
            `Executable process ${process.id} failed at ${boundary.id} pass ${pass}; generated ${generated.map((value) => `${value.id}:${value.action.kind}`).join(", ")}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        const emission: MechanismEmissionRecord = {
          ...emissionCore,
          committedStateHash: currentStateHash,
          id: `emission:${compiled.worldId}:${hash({ ...emissionCore, committedStateHash: currentStateHash }).slice(0, 22)}`,
        };
        emissions.push(emission);
        boundaryEmissionIds.push(emission.id);
        for (const path of writePaths) writerByPath.set(path, { kind: "emission", id: emission.id });
      }
      if (proposalsThisPass === 0) {
        quiescent = true;
        break;
      }
    }
    if (!quiescent) throw new Error(`Causal boundary ${boundary.id} did not reach quiescence within ${options.plan.maximumCausalPassesPerBoundary} passes`);
    boundaryRecords.push({
      worldId: compiled.worldId,
      boundary,
      startStateHash,
      endStateHash: currentStateHash,
      passes: completedPasses,
      quiescent,
      emissionIds: boundaryEmissionIds,
      proposalIds: boundaryProposalIds,
      dimensionsActivated: [...boundaryDimensions].sort(),
    });
  }

  const run: WorldRunRecord = session.finish();
  const dimensionsClosed = [...new Set(boundaryRecords.flatMap((record) => record.dimensionsActivated))].sort() as CausalDimension[];
  const closureAudit = auditCausalClosure(compiled.worldId, emissions, boundaryRecords);
  if (options.requireCausalClosure && endBoundaryIndexExclusive === options.plan.boundaries.length && closureAudit.status !== "closed") {
    const openLoops = closureAudit.loops.filter((loop) => !loop.closed).map((loop) => `${loop.id}[${loop.missingLinks.join(",") || `scales:${loop.scales.length}/${loop.minimumScales}`}]`);
    throw new Error(`Causal closure failed: missing dimensions [${closureAudit.missingDimensions.join(", ")}], missing scales [${closureAudit.missingScales.join(", ")}], open loops [${openLoops.join("; ")}]`);
  }
  const autonomous: AutonomousWorldRun = {
    worldId: compiled.worldId,
    plan: options.plan,
    schedule: options.schedule,
    guidance,
    run,
    generatedInputs,
    externalInputs,
    generatedInputHash: hash(generatedInputs),
    emissions,
    boundaries: boundaryRecords,
    dimensionsClosed,
    closureAudit,
    quiescent: boundaryRecords.every((record) => record.quiescent),
  };
  assertWorldScope(compiled.worldId, [{ label: "Autonomous World Run", value: autonomous }]);
  return deepFreezeArtifact(autonomous);
}

export interface EvolveAnchoredWorldOptions {
  readonly anchorBoundaryId: string;
  readonly interventions: readonly GraphTransitionInput[];
  /** Full guidance set for the candidate; defaults to the parent's immutable set. */
  readonly guidance?: readonly GuidanceSpecification[];
  readonly schedule: SimulationSchedule;
  readonly seed?: string;
  readonly mechanisms?: readonly ExecutableWorldMechanism[];
  readonly modelProposer?: EvolutionModelProposer;
  readonly onModelProposalSet?: (proposalSet: TransitionProposalSet) => void | Promise<void>;
  readonly requireCausalClosure?: boolean;
  readonly reason: string;
}

/** Preserve the immutable prefix, apply explicit new input, and regenerate every causal descendant. */
export async function evolveAnchoredWorld(
  compiled: CompiledWorldPackage,
  parent: AutonomousWorldRun,
  options: EvolveAnchoredWorldOptions,
): Promise<AutonomousBranchResult> {
  if (parent.worldId !== compiled.worldId) throw new WorldIsolationError("Parent autonomous Run belongs to another World");
  if (parent.run.manifest.contractHash !== compiled.contract.hash) throw new Error("Anchored autonomous evolution requires the parent's exact Contract");
  const anchorIndex = parent.plan.boundaries.findIndex((boundary) => boundary.id === options.anchorBoundaryId);
  if (anchorIndex < 0) throw new Error(`Unknown anchor boundary ${options.anchorBoundaryId}`);
  const anchor = parent.plan.boundaries[anchorIndex]!;
  const prefixInputs = parent.run.inputs.filter((input) => input.worldTime < anchor.worldTime);
  const prefixGeneratedInputs = parent.generatedInputs.filter((input) => input.worldTime < anchor.worldTime);
  const prefixExternalInputs = parent.externalInputs.filter((input) => input.worldTime < anchor.worldTime);
  const prefixBoundaryIds = new Set(parent.plan.boundaries.slice(0, anchorIndex).map((boundary) => boundary.id));
  const prefixEmissions = parent.emissions.filter((emission) => prefixBoundaryIds.has(emission.boundaryId));
  const prefixBoundaries = parent.boundaries.slice(0, anchorIndex);
  const interventions = options.interventions.map((input, index): GraphTransitionInput => {
    if (input.worldId !== compiled.worldId) throw new WorldIsolationError(`Anchored input ${input.id} belongs to another World`);
    if (input.worldTime !== anchor.worldTime) throw new Error(`Anchored input ${input.id} must occur at ${anchor.worldTime}`);
    if (input.origin === "mechanism-generated") throw new Error(`Anchored input ${input.id} cannot claim mechanism-generated provenance`);
    const causalPhase = input.causalPhase ?? index + 1;
    if (causalPhase < 0 || causalPhase >= 1_000) throw new Error(`Anchored input ${input.id} must precede autonomous Mechanism stages in causal phases [0, 1000)`);
    return { ...structuredClone(input), causalPhase, origin: input.origin ?? "creator-input", provenance: [...(input.provenance ?? []), `anchor:${options.anchorBoundaryId}`, `parent-run:${parent.run.manifest.runId}`] };
  }).sort((left, right) => (left.causalPhase ?? 0) - (right.causalPhase ?? 0) || left.id.localeCompare(right.id));
  if (new Set(interventions.map((input) => input.id)).size !== interventions.length) throw new Error("Anchored intervention ids must be unique");
  const guidance = [...structuredClone(options.guidance ?? parent.guidance ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(guidance.map((value) => value.id)).size !== guidance.length) throw new Error("Anchored guidance ids must be unique");
  assertWorldScope(compiled.worldId, guidance.map((value) => ({ label: `Guidance ${value.id}`, value })));
  const inputDeltaHash = hash({ interventions, guidance });
  const branchCore = {
    worldId: compiled.worldId,
    lineageId: parent.run.manifest.lineageId,
    parentRunId: parent.run.manifest.runId,
    anchorInputCount: prefixInputs.length,
    anchorBoundaryId: options.anchorBoundaryId,
    inputDeltaHash,
    reason: options.reason,
  } as const;
  const branchId = `branch:${compiled.worldId}:${hash(branchCore).slice(0, 18)}`;
  const autonomous = await evolveWorld(compiled, {
    plan: parent.plan,
    schedule: options.schedule,
    guidance,
    seed: options.seed ?? parent.run.manifest.seed,
    ...(options.mechanisms ? { mechanisms: options.mechanisms } : {}),
    ...(options.modelProposer ? { modelProposer: options.modelProposer } : {}),
    ...(options.onModelProposalSet ? { onModelProposalSet: options.onModelProposalSet } : {}),
    prefixInputs,
    externalInputs: interventions,
    inheritedExternalInputs: prefixExternalInputs,
    inheritedGeneratedInputs: prefixGeneratedInputs,
    inheritedEmissions: prefixEmissions,
    inheritedBoundaries: prefixBoundaries,
    startBoundaryIndex: anchorIndex,
    requireCausalClosure: options.requireCausalClosure ?? parent.closureAudit.status === "closed",
    run: { branchId, parentRunId: parent.run.manifest.runId, anchorInputCount: prefixInputs.length },
  });
  const anchorStateHash = new WorldRuntimeSession(compiled, { schedule: options.schedule, seed: parent.run.manifest.seed, guidance: parent.guidance ?? [] });
  anchorStateHash.commit(prefixInputs);
  const branch: WorldBranch = {
    worldId: compiled.worldId,
    id: branchId,
    lineageId: parent.run.manifest.lineageId,
    parentRunId: parent.run.manifest.runId,
    anchorInputCount: prefixInputs.length,
    anchorStateHash: anchorStateHash.stateHash(),
    inputDeltaHash,
    reason: options.reason,
    runId: autonomous.run.manifest.runId,
  };
  return deepFreezeArtifact({
    worldId: compiled.worldId,
    branch,
    parentRunId: parent.run.manifest.runId,
    anchorBoundaryId: options.anchorBoundaryId,
    interventionInputIds: interventions.map((input) => input.id),
    autonomous,
  });
}
