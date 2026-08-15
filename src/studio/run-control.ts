import { hash } from "../kernel/stable.ts";
import { evolveWorld } from "../world-model/evolution.ts";
import { executableMechanismLibrary, type EvolutionModelProposer, type ExecutableWorldMechanism } from "../world-model/mechanisms.ts";
import type { CompiledWorldPackage, SimulationSchedule, TransitionProposalSet, WorldEvolutionPlan } from "../world-model/types.ts";
import type { StudioRunControl } from "./types.ts";

export type { StudioRunControl } from "./types.ts";

export interface CreateRunControlOptions {
  readonly seed: string;
  readonly controlId?: string;
}

export interface AdvanceRunControlOptions {
  readonly mechanisms?: readonly ExecutableWorldMechanism[];
  readonly modelProposer?: EvolutionModelProposer;
  readonly onModelProposalSet?: (proposalSet: TransitionProposalSet) => void | Promise<void>;
}

function core(control: Omit<StudioRunControl, "controlHash">): Omit<StudioRunControl, "controlHash"> {
  return structuredClone(control);
}

export function runControlContentHash(control: Omit<StudioRunControl, "controlHash"> | StudioRunControl): string {
  const { controlHash: _ignored, ...content } = control as StudioRunControl;
  return hash(content);
}

function seal(control: Omit<StudioRunControl, "controlHash">): StudioRunControl {
  return Object.freeze({ ...control, controlHash: runControlContentHash(control) });
}

function revise(control: StudioRunControl, patch: Partial<Omit<StudioRunControl, "worldId" | "id" | "revision" | "controlHash">>): StudioRunControl {
  if (control.controlHash !== runControlContentHash(control)) throw new Error(`Run control ${control.id} hash is invalid`);
  const { controlHash: _oldHash, ...previous } = control;
  return seal({ ...core(previous), ...structuredClone(patch), revision: control.revision + 1 });
}

function assertBound(compiled: CompiledWorldPackage, control: StudioRunControl): void {
  if (control.worldId !== compiled.worldId) throw new Error(`Run control ${control.id} belongs to another World`);
  if (control.contractHash !== compiled.contract.hash || control.instanceId !== compiled.instance.id) throw new Error(`Run control ${control.id} is bound to another Contract or Instance`);
  if (control.plan.contractHash !== compiled.contract.hash || control.schedule.contractHash !== compiled.contract.hash) throw new Error(`Run control ${control.id} plan or schedule is bound to another Contract`);
  if (control.controlHash !== runControlContentHash(control)) throw new Error(`Run control ${control.id} hash is invalid`);
  if (control.checkpoint && control.checkpointHash !== hash(control.checkpoint)) throw new Error(`Run control ${control.id} checkpoint hash is invalid`);
}

export function createRunControl(
  compiled: CompiledWorldPackage,
  plan: WorldEvolutionPlan,
  schedule: SimulationSchedule,
  options: CreateRunControlOptions,
): StudioRunControl {
  if (!options.seed) throw new Error("Run control seed is required");
  if (plan.worldId !== compiled.worldId || schedule.worldId !== compiled.worldId) throw new Error("Run control plan and schedule must belong to the compiled World");
  if (plan.contractHash !== compiled.contract.hash || schedule.contractHash !== compiled.contract.hash || plan.scheduleHash !== schedule.scheduleHash) throw new Error("Run control plan and schedule must bind the exact Contract and each other");
  const id = options.controlId ?? `control:${compiled.worldId}:${hash({ contractHash: compiled.contract.hash, planHash: plan.planHash, seed: options.seed }).slice(0, 18)}`;
  return seal({
    worldId: compiled.worldId,
    id,
    revision: 1,
    status: "ready",
    contractHash: compiled.contract.hash,
    instanceId: compiled.instance.id,
    plan: structuredClone(plan),
    schedule: structuredClone(schedule),
    seed: options.seed,
    nextBoundaryIndex: 0,
  });
}

export function startRunControl(control: StudioRunControl): StudioRunControl {
  if (control.status !== "ready") throw new Error(`Run control ${control.id} cannot start from ${control.status}`);
  return revise(control, { status: "running" });
}

export function requestRunPause(control: StudioRunControl): StudioRunControl {
  if (control.status !== "running") throw new Error(`Run control ${control.id} cannot pause from ${control.status}`);
  return revise(control, { status: "pause-requested" });
}

export function resumeRunControl(control: StudioRunControl): StudioRunControl {
  if (control.status === "complete") throw new Error(`Cannot resume completed run control ${control.id}`);
  if (control.status !== "paused") throw new Error(`Run control ${control.id} cannot resume from ${control.status}`);
  return revise(control, { status: "running" });
}

export async function advanceRunControl(
  compiled: CompiledWorldPackage,
  control: StudioRunControl,
  options: AdvanceRunControlOptions = {},
): Promise<StudioRunControl> {
  assertBound(compiled, control);
  if (control.status === "pause-requested") return revise(control, { status: "paused" });
  if (control.status !== "running") throw new Error(`Run control ${control.id} must be running before advance`);
  if (control.nextBoundaryIndex >= control.plan.boundaries.length) throw new Error(`Run control ${control.id} has no remaining boundary`);
  const checkpoint = control.checkpoint;
  try {
    const nextBoundaryIndex = control.nextBoundaryIndex + 1;
    const autonomous = await evolveWorld(compiled, {
      plan: control.plan,
      schedule: control.schedule,
      seed: control.seed,
      mechanisms: options.mechanisms ?? executableMechanismLibrary,
      ...(options.modelProposer ? { modelProposer: options.modelProposer } : {}),
      ...(options.onModelProposalSet ? { onModelProposalSet: options.onModelProposalSet } : {}),
      ...(checkpoint ? {
        guidance: checkpoint.guidance ?? [],
        prefixInputs: checkpoint.run.inputs,
        inheritedExternalInputs: checkpoint.externalInputs,
        inheritedGeneratedInputs: checkpoint.generatedInputs,
        inheritedEmissions: checkpoint.emissions,
        inheritedBoundaries: checkpoint.boundaries,
      } : {}),
      startBoundaryIndex: control.nextBoundaryIndex,
      endBoundaryIndexExclusive: nextBoundaryIndex,
      requireCausalClosure: nextBoundaryIndex === control.plan.boundaries.length,
    });
    const complete = nextBoundaryIndex === control.plan.boundaries.length;
    return revise(control, {
      status: complete ? "complete" : "running",
      nextBoundaryIndex,
      checkpoint: autonomous,
      checkpointHash: hash(autonomous),
      ...(complete ? { finalRunId: autonomous.run.manifest.runId } : {}),
    });
  } catch (error) {
    return revise(control, {
      status: "failed",
      failure: { code: "run-boundary-failed", message: error instanceof Error ? error.message : String(error) },
    });
  }
}
