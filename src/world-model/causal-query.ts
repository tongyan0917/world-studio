import { hash } from "../kernel/stable.ts";
import { graphActionWritePath, worldStateTargetPath, writePathCanProduceReadPath, type WorldStateTarget } from "./causal-path.ts";
import { WorldIsolationError } from "./isolation.ts";
import type {
  AutonomousWorldRun,
  GraphTransitionInput,
  GraphWorldAction,
  JsonValue,
  MechanismEmissionRecord,
  SimulationScale,
  WorldSnapshot,
} from "./types.ts";

export { worldStateTargetPath, type WorldStateTarget } from "./causal-path.ts";

export interface CausalExplanationStep {
  readonly emissionId: string;
  readonly mechanismId: string;
  readonly mechanismVersion: string;
  readonly boundaryId: string;
  readonly scale: SimulationScale;
  readonly pass: number;
  readonly triggerSummary: string;
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly substantiveActions: readonly GraphWorldAction[];
  readonly predecessorEmissionIds: readonly string[];
  readonly predecessorInputIds: readonly string[];
  readonly dependencyLinks: readonly {
    readonly sourceKind: "emission" | "external-input";
    readonly sourceId: string;
    readonly writePath: string;
    readonly readPaths: readonly string[];
  }[];
  readonly initialConditionPaths: readonly string[];
  readonly modelInvocationId?: string;
  readonly modelProposalSetId?: string;
}

export interface CausalStateExplanation {
  readonly worldId: string;
  readonly runId: string;
  readonly target: WorldStateTarget;
  readonly targetPath: string;
  readonly status: "generated" | "external-input" | "initial-condition" | "unknown";
  readonly currentValue?: JsonValue;
  readonly rootEmissionId?: string;
  readonly rootInputId?: string;
  readonly externalCauseInputIds: readonly string[];
  readonly initialConditionPaths: readonly string[];
  readonly steps: readonly CausalExplanationStep[];
  readonly truncated: boolean;
  readonly explanationHash: string;
}

export interface CausalImpactTrace {
  readonly worldId: string;
  readonly runId: string;
  readonly rootInputIds: readonly string[];
  readonly emissionIds: readonly string[];
  readonly boundaryIds: readonly string[];
  readonly writtenPaths: readonly string[];
  readonly impactHash: string;
}

export interface AutonomousHistoryComparison {
  readonly worldId: string;
  readonly parentRunId: string;
  readonly candidateRunId: string;
  readonly commonPrefixInputCount: number;
  readonly protectedPrefixVerified: boolean;
  readonly firstDivergence?: {
    readonly parentInputId?: string;
    readonly candidateInputId?: string;
    readonly worldTime?: number;
  };
  readonly newExternalInputIds: readonly string[];
  readonly changedPaths: readonly string[];
  readonly auditChangedPaths: readonly string[];
  readonly impactedEmissionIds: readonly string[];
  readonly impactedBoundaryIds: readonly string[];
  readonly firstAffectedBoundaryId?: string;
  readonly unattributedChangedPaths: readonly string[];
  readonly comparisonHash: string;
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function readTarget(snapshot: WorldSnapshot, target: WorldStateTarget): JsonValue | undefined {
  if (target.kind === "fact") return snapshot.facts[target.id] as unknown as JsonValue | undefined;
  const value = target.kind === "node" ? snapshot.nodes[target.id] : snapshot.edges[target.id];
  if (!value) return undefined;
  return target.fieldId ? value.attributes[target.fieldId] : value as unknown as JsonValue;
}

function proposalEmissionMap(run: AutonomousWorldRun): Map<string, MechanismEmissionRecord> {
  return new Map(run.emissions.flatMap((emission) => emission.proposalIds.map((proposalId) => [proposalId, emission] as const)));
}

function latestWriter(run: AutonomousWorldRun, path: string): { readonly input: GraphTransitionInput; readonly emission?: MechanismEmissionRecord } | undefined {
  const byProposal = proposalEmissionMap(run);
  for (let index = run.run.inputs.length - 1; index >= 0; index -= 1) {
    const input = run.run.inputs[index]!;
    if (!writePathCanProduceReadPath(graphActionWritePath(input.action), path)) continue;
    return { input, ...(byProposal.has(input.id) ? { emission: byProposal.get(input.id)! } : {}) };
  }
  return undefined;
}

function explanationStep(run: AutonomousWorldRun, emission: MechanismEmissionRecord): CausalExplanationStep {
  const inputById = new Map(run.generatedInputs.map((input) => [input.id, input]));
  const emissionById = new Map(run.emissions.map((candidate) => [candidate.id, candidate]));
  const externalById = new Map(run.externalInputs.map((input) => [input.id, input]));
  const scale = run.boundaries.find((boundary) => boundary.boundary.id === emission.boundaryId)?.boundary.scale;
  if (!scale) throw new Error(`Emission ${emission.id} has no boundary record`);
  const dependencyLinks = [
    ...emission.causalPredecessorEmissionIds.flatMap((sourceId) => {
      const source = emissionById.get(sourceId);
      if (!source) throw new Error(`Missing causal emission ${sourceId}`);
      return source.writePaths.flatMap((writePath) => {
        const readPaths = emission.readPaths.filter((readPath) => writePathCanProduceReadPath(writePath, readPath));
        return readPaths.length > 0 ? [{ sourceKind: "emission" as const, sourceId, writePath, readPaths }] : [];
      });
    }),
    ...emission.causalPredecessorInputIds.flatMap((sourceId) => {
      const source = externalById.get(sourceId);
      if (!source) throw new Error(`Missing causal external input ${sourceId}`);
      const writePath = graphActionWritePath(source.action);
      const readPaths = emission.readPaths.filter((readPath) => writePathCanProduceReadPath(writePath, readPath));
      return readPaths.length > 0 ? [{ sourceKind: "external-input" as const, sourceId, writePath, readPaths }] : [];
    }),
  ];
  const linkedPaths = new Set(dependencyLinks.flatMap((link) => link.readPaths));
  return {
    emissionId: emission.id,
    mechanismId: emission.mechanismId,
    mechanismVersion: emission.mechanismVersion,
    boundaryId: emission.boundaryId,
    scale,
    pass: emission.pass,
    triggerSummary: emission.triggerSummary,
    readPaths: emission.readPaths,
    writePaths: emission.writePaths,
    substantiveActions: emission.substantiveProposalIds.map((id) => inputById.get(id)?.action).filter((action): action is GraphWorldAction => Boolean(action)),
    predecessorEmissionIds: emission.causalPredecessorEmissionIds,
    predecessorInputIds: emission.causalPredecessorInputIds,
    dependencyLinks,
    initialConditionPaths: emission.readPaths.filter((path) => !linkedPaths.has(path)),
    ...(emission.modelInvocationId ? { modelInvocationId: emission.modelInvocationId } : {}),
    ...(emission.modelProposalSetId ? { modelProposalSetId: emission.modelProposalSetId } : {}),
  };
}

export function explainWorldState(run: AutonomousWorldRun, target: WorldStateTarget, maximumSteps = 128): CausalStateExplanation {
  if (!Number.isSafeInteger(maximumSteps) || maximumSteps < 1) throw new RangeError("maximumSteps must be a positive integer");
  const targetPath = worldStateTargetPath(target);
  const writer = latestWriter(run, targetPath);
  const emissionById = new Map(run.emissions.map((emission) => [emission.id, emission]));
  const visited = new Set<string>();
  const ordered: MechanismEmissionRecord[] = [];
  const externalCauses = new Set<string>();
  let truncated = false;
  const visit = (emissionId: string): void => {
    if (visited.has(emissionId)) return;
    if (visited.size >= maximumSteps) {
      truncated = true;
      return;
    }
    const emission = emissionById.get(emissionId);
    if (!emission) throw new Error(`Missing causal emission ${emissionId}`);
    visited.add(emissionId);
    for (const inputId of emission.causalPredecessorInputIds) externalCauses.add(inputId);
    for (const predecessorId of emission.causalPredecessorEmissionIds) visit(predecessorId);
    ordered.push(emission);
  };
  if (writer?.emission) visit(writer.emission.id);
  else if (writer) externalCauses.add(writer.input.id);
  const currentValue = readTarget(run.run.finalSnapshot, target);
  const status = writer?.emission ? "generated" : writer ? "external-input" : currentValue === undefined ? "unknown" : "initial-condition";
  const steps = ordered.map((emission) => explanationStep(run, emission));
  const core = {
    worldId: run.worldId,
    runId: run.run.manifest.runId,
    target,
    targetPath,
    status,
    ...(currentValue === undefined ? {} : { currentValue }),
    ...(writer?.emission ? { rootEmissionId: writer.emission.id } : {}),
    ...(writer && !writer.emission ? { rootInputId: writer.input.id } : {}),
    externalCauseInputIds: [...externalCauses].sort(),
    initialConditionPaths: [...new Set(steps.flatMap((step) => step.initialConditionPaths))].sort(),
    steps,
    truncated,
  } as const;
  return immutable({ ...core, explanationHash: hash(core) });
}

export function traceCausalImpact(run: AutonomousWorldRun, rootInputIds: readonly string[]): CausalImpactTrace {
  const roots = new Set(rootInputIds);
  if (roots.size !== rootInputIds.length) throw new Error("Causal impact root input ids must be unique");
  const knownInputs = new Set(run.externalInputs.map((input) => input.id));
  if ([...roots].some((id) => !knownInputs.has(id))) throw new Error("Causal impact roots must be external inputs in this autonomous Run");
  const impacted = new Set<string>();
  for (const emission of run.emissions) {
    if (emission.causalPredecessorInputIds.some((id) => roots.has(id)) || emission.causalPredecessorEmissionIds.some((id) => impacted.has(id))) impacted.add(emission.id);
  }
  const selected = run.emissions.filter((emission) => impacted.has(emission.id));
  const core = {
    worldId: run.worldId,
    runId: run.run.manifest.runId,
    rootInputIds: [...roots].sort(),
    emissionIds: selected.map((emission) => emission.id),
    boundaryIds: [...new Set(selected.map((emission) => emission.boundaryId))],
    writtenPaths: [...new Set(selected.flatMap((emission) => emission.writePaths))].sort(),
  } as const;
  return immutable({ ...core, impactHash: hash(core) });
}

function changedSnapshotPaths(left: WorldSnapshot, right: WorldSnapshot): { readonly domain: readonly string[]; readonly audit: readonly string[] } {
  const fieldChanged = (before: Readonly<Record<string, JsonValue>>, after: Readonly<Record<string, JsonValue>>, fieldId: string): boolean => hash({
    present: Object.hasOwn(before, fieldId),
    value: before[fieldId] ?? null,
  }) !== hash({
    present: Object.hasOwn(after, fieldId),
    value: after[fieldId] ?? null,
  });
  const domain: string[] = [];
  const audit: string[] = [];
  for (const nodeId of new Set([...Object.keys(left.nodes), ...Object.keys(right.nodes)])) {
    const before = left.nodes[nodeId];
    const after = right.nodes[nodeId];
    if (!before || !after) {
      domain.push(worldStateTargetPath({ kind: "node", id: nodeId }));
      continue;
    }
    for (const fieldId of new Set([...Object.keys(before.attributes), ...Object.keys(after.attributes)])) if (fieldChanged(before.attributes, after.attributes, fieldId)) domain.push(worldStateTargetPath({ kind: "node", id: nodeId, fieldId }));
  }
  for (const edgeId of new Set([...Object.keys(left.edges), ...Object.keys(right.edges)])) {
    const before = left.edges[edgeId];
    const after = right.edges[edgeId];
    if (!before || !after) {
      domain.push(worldStateTargetPath({ kind: "edge", id: edgeId }));
      continue;
    }
    for (const fieldId of new Set([...Object.keys(before.attributes), ...Object.keys(after.attributes)])) if (fieldChanged(before.attributes, after.attributes, fieldId)) domain.push(worldStateTargetPath({ kind: "edge", id: edgeId, fieldId }));
  }
  for (const factId of new Set([...Object.keys(left.facts), ...Object.keys(right.facts)])) if (fieldChanged(left.facts as Readonly<Record<string, JsonValue>>, right.facts as Readonly<Record<string, JsonValue>>, factId)) {
    const predicate = right.facts[factId]?.predicate ?? left.facts[factId]?.predicate;
    const target = ["mechanism-boundary-evaluation", "bounded-model-proposal-selected"].includes(predicate ?? "") ? audit : domain;
    target.push(worldStateTargetPath({ kind: "fact", id: factId }));
  }
  return { domain: domain.sort(), audit: audit.sort() };
}

export function compareAutonomousHistories(parent: AutonomousWorldRun, candidate: AutonomousWorldRun): AutonomousHistoryComparison {
  if (parent.worldId !== candidate.worldId) throw new WorldIsolationError("Cannot compare autonomous histories from different Worlds");
  if (parent.run.manifest.contractHash !== candidate.run.manifest.contractHash) throw new Error("Autonomous history comparison requires one exact Contract");
  if (parent.run.manifest.lineageId !== candidate.run.manifest.lineageId) throw new Error("Autonomous history comparison requires one lineage");
  let commonPrefixInputCount = 0;
  const limit = Math.min(parent.run.inputs.length, candidate.run.inputs.length);
  while (commonPrefixInputCount < limit && hash(parent.run.inputs[commonPrefixInputCount]) === hash(candidate.run.inputs[commonPrefixInputCount])) commonPrefixInputCount += 1;
  const parentInput = parent.run.inputs[commonPrefixInputCount];
  const candidateInput = candidate.run.inputs[commonPrefixInputCount];
  const parentExternalIds = new Set(parent.externalInputs.map((input) => input.id));
  const newExternalInputIds = candidate.externalInputs.map((input) => input.id).filter((id) => !parentExternalIds.has(id));
  const impact = traceCausalImpact(candidate, newExternalInputIds);
  const snapshotChanges = changedSnapshotPaths(parent.run.finalSnapshot, candidate.run.finalSnapshot);
  const changedPaths = snapshotChanges.domain;
  const impacted = new Set(impact.emissionIds);
  const newExternalSet = new Set(newExternalInputIds);
  const parentInputIndex = new Map(parent.run.inputs.map((input, index) => [input.id, index]));
  const unattributedChangedPaths = changedPaths.filter((path) => {
    const candidateWriter = latestWriter(candidate, path);
    if (candidateWriter && (newExternalSet.has(candidateWriter.input.id) || (candidateWriter.emission && impacted.has(candidateWriter.emission.id)))) return false;
    const priorWriter = latestWriter(parent, path);
    return !priorWriter || (parentInputIndex.get(priorWriter.input.id) ?? -1) < commonPrefixInputCount;
  });
  const core = {
    worldId: parent.worldId,
    parentRunId: parent.run.manifest.runId,
    candidateRunId: candidate.run.manifest.runId,
    commonPrefixInputCount,
    protectedPrefixVerified: candidate.run.manifest.parentRunId === parent.run.manifest.runId
      && candidate.run.manifest.anchorInputCount !== undefined
      && commonPrefixInputCount >= candidate.run.manifest.anchorInputCount,
    ...(!parentInput && !candidateInput ? {} : { firstDivergence: {
      ...(parentInput ? { parentInputId: parentInput.id } : {}),
      ...(candidateInput ? { candidateInputId: candidateInput.id } : {}),
      ...((candidateInput?.worldTime ?? parentInput?.worldTime) === undefined ? {} : { worldTime: candidateInput?.worldTime ?? parentInput?.worldTime }),
    } }),
    newExternalInputIds,
    changedPaths,
    auditChangedPaths: snapshotChanges.audit,
    impactedEmissionIds: impact.emissionIds,
    impactedBoundaryIds: impact.boundaryIds,
    ...(impact.boundaryIds[0] ? { firstAffectedBoundaryId: impact.boundaryIds[0] } : {}),
    unattributedChangedPaths,
  } as const;
  return immutable({ ...core, comparisonHash: hash(core) });
}
