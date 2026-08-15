import { hash } from "../kernel/stable.ts";
import { graphActionWritePath, worldStateTargetPath, type WorldStateTarget } from "../world-model/causal-path.ts";
import { compareAutonomousHistories, explainWorldState, traceCausalImpact } from "../world-model/causal-query.ts";
import { WorldEngine } from "../world-model/engine.ts";
import { WorldRuntimeSession } from "../world-model/runtime.ts";
import type { AutonomousWorldRun, CompiledWorldPackage, GraphTransitionInput, GuidanceSpecification, SimulationSchedule, WorldSnapshot } from "../world-model/types.ts";
import type { StudioBranchRequest, StudioHistoryEvidence } from "./types.ts";

export type { StudioBranchRequest, StudioHistoryEvidence } from "./types.ts";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function targetExists(snapshot: WorldSnapshot, target: WorldStateTarget): boolean {
  if (target.kind === "fact") return Boolean(snapshot.facts[target.id]);
  const object = target.kind === "node" ? snapshot.nodes[target.id] : snapshot.edges[target.id];
  return Boolean(object) && (!target.fieldId || Object.hasOwn(object!.attributes, target.fieldId));
}

function objectPath(target: WorldStateTarget): string {
  return worldStateTargetPath({ kind: target.kind, id: target.id });
}

function actionMatchesTarget(request: Extract<StudioBranchRequest, { mode: "intervention" }>): boolean {
  const writePath = graphActionWritePath(request.action);
  const targetPath = worldStateTargetPath(request.target);
  return request.target.fieldId ? writePath === targetPath : writePath === targetPath || writePath.startsWith(`${targetPath}/attributes/`);
}

function guidanceFor(request: Extract<StudioBranchRequest, { mode: "soft-guidance" }>, startWorldTime: number, endWorldTime: number): GuidanceSpecification {
  if (!request.prompt.trim()) throw new Error("Soft directional guidance requires a non-empty prompt");
  if (endWorldTime < startWorldTime) throw new Error("Guidance interval is invalid");
  return {
    worldId: request.worldId,
    id: `guidance:${request.worldId}:${hash({ request, startWorldTime, endWorldTime }).slice(0, 20)}`,
    mode: "guided-search",
    targetSubjectIds: [request.target.id],
    startWorldTime,
    endWorldTime,
    desiredPattern: request.prompt.trim(),
    permittedLevers: [...new Set(request.permittedLevers)].sort(),
    protectedFacts: [...new Set(request.protectedFacts)].sort(),
    forbiddenEffects: [...new Set(request.forbiddenEffects)].sort(),
    provenance: [`studio-branch-request:${request.id}`, `target:${worldStateTargetPath(request.target)}`],
  };
}

function unresolvedUncertainty(run: AutonomousWorldRun, request: StudioBranchRequest): string[] {
  const uncertainties = Object.values(run.run.finalSnapshot.facts)
    .filter((fact) => fact.subjectId === request.target.id && fact.uncertainty)
    .map((fact) => `${fact.id}: ${fact.uncertainty}`);
  if (request.mode === "soft-guidance") uncertainties.push("Soft guidance constrains search and focus; it does not guarantee a state change or authored outcome.");
  return [...new Set(uncertainties)].sort();
}

/**
 * Product-facing, read/branch service. It validates an arbitrary object/time
 * selection against the replayed anchor state, delegates all commits to the
 * Engine, then persists immutable query evidence. Query construction itself is
 * deliberately side-effect free.
 */
export class StudioHistoryService {
  readonly #engine: WorldEngine;

  constructor(engine: WorldEngine) {
    this.#engine = engine;
  }

  async branchAtSelection(
    compiled: CompiledWorldPackage,
    parent: AutonomousWorldRun,
    schedule: SimulationSchedule,
    request: StudioBranchRequest,
  ): Promise<StudioHistoryEvidence> {
    if (request.worldId !== compiled.worldId || parent.worldId !== compiled.worldId) throw new Error("Branch request, parent Run, and compiled World must share one World scope");
    if (request.parentRunId !== parent.run.manifest.runId) throw new Error("Branch request parentRunId does not match the supplied parent Run");
    if (schedule.worldId !== compiled.worldId || schedule.contractHash !== compiled.contract.hash || schedule.scheduleHash !== parent.plan.scheduleHash) throw new Error("Branch schedule does not match the parent Run and Contract");
    if (!Number.isFinite(request.target.worldTime)) throw new Error("Branch target worldTime must be finite");
    const boundaryIndex = parent.plan.boundaries.findIndex((boundary) => boundary.worldTime >= request.target.worldTime);
    if (boundaryIndex < 0) throw new Error(`No causal boundary exists at or after World time ${request.target.worldTime}`);
    const boundary = parent.plan.boundaries[boundaryIndex]!;
    const prefixInputs = parent.run.inputs.filter((input) => input.worldTime < boundary.worldTime);
    const anchorSession = new WorldRuntimeSession(compiled, {
      schedule,
      seed: parent.run.manifest.seed,
      guidance: parent.guidance ?? [],
    });
    anchorSession.commit(prefixInputs);
    const anchorSnapshot = anchorSession.snapshot();
    if (!targetExists(anchorSnapshot, request.target)) throw new Error(`Selected target ${objectPath(request.target)} does not exist at anchor ${boundary.id}`);

    let interventions: readonly GraphTransitionInput[] = [];
    let guidance = parent.guidance ?? [];
    if (request.mode === "intervention") {
      if (!actionMatchesTarget(request)) throw new Error(`Intervention action does not write the selected target ${worldStateTargetPath(request.target)}`);
      interventions = [{
        worldId: compiled.worldId,
        id: `input:creator:${hash({ request, boundary: boundary.id }).slice(0, 24)}`,
        mechanismId: request.mechanismId ?? "mechanism.world-evolution",
        worldTime: boundary.worldTime,
        causalPhase: 1,
        frameId: boundary.frameId,
        origin: "author-intervention",
        provenance: [`studio-branch-request:${request.id}`, `selected-time:${request.target.worldTime}`, `resolved-boundary:${boundary.id}`],
        action: structuredClone(request.action),
      }];
    } else {
      const nextGuidance = guidanceFor(request, boundary.worldTime, parent.plan.boundaries.at(-1)!.worldTime);
      guidance = [...(parent.guidance ?? []), nextGuidance].sort((left, right) => left.id.localeCompare(right.id));
    }

    const beforeHash = hash(parent);
    const targetBefore = explainWorldState(parent, request.target);
    const result = await this.#engine.evolveBranch(compiled, parent, {
      anchorBoundaryId: boundary.id,
      interventions,
      guidance,
      schedule,
      reason: request.reason,
    });
    if (hash(parent) !== beforeHash) throw new Error("History query or branch construction mutated the parent Run");

    const comparison = compareAutonomousHistories(parent, result.autonomous);
    const impact = traceCausalImpact(result.autonomous, comparison.newExternalInputIds);
    const targetAfter = explainWorldState(result.autonomous, request.target);
    const initialConditionRoots = [...new Set([
      ...targetBefore.initialConditionPaths,
      ...targetAfter.initialConditionPaths,
      ...(targetExists(compiled.instance.initialSnapshot, request.target) ? [worldStateTargetPath(request.target)] : []),
    ])].sort();
    const modelProvenance = result.autonomous.emissions
      .filter((emission) => emission.modelInvocationId || emission.modelProposalSetId)
      .map((emission) => ({
        emissionId: emission.id,
        ...(emission.modelInvocationId ? { invocationId: emission.modelInvocationId } : {}),
        ...(emission.modelProposalSetId ? { proposalSetId: emission.modelProposalSetId } : {}),
      }));
    const content = {
      worldId: compiled.worldId,
      id: `history-evidence:${compiled.worldId}:${hash({ request, branchId: result.branch.id }).slice(0, 20)}`,
      request: structuredClone(request),
      anchorBoundaryId: boundary.id,
      anchorWorldTime: boundary.worldTime,
      anchorStateHash: result.branch.anchorStateHash,
      branchId: result.branch.id,
      candidateRunId: result.autonomous.run.manifest.runId,
      interventionInputIds: result.interventionInputIds,
      guidance: result.autonomous.guidance ?? [],
      targetBefore,
      targetAfter,
      comparison,
      impact,
      initialConditionRoots,
      modelProvenance,
      unresolvedUncertainty: unresolvedUncertainty(result.autonomous, request),
    } as const;
    const evidence = deepFreeze({ ...content, evidenceHash: hash(content) });
    this.#engine.store.saveHistoryEvidence(compiled.worldId, evidence);
    return evidence;
  }
}
