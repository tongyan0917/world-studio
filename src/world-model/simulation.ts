import { hash, stableRandom } from "../kernel/stable.ts";
import { assertWorldScope, validateWorldId } from "./isolation.ts";
import type {
  CausalDimension,
  EvolutionBoundary,
  GraphTransitionInput,
  SimulationFrame,
  SimulationScale,
  SimulationSchedule,
  WorldFact,
  WorldEvolutionPlan,
  WorldId,
} from "./types.ts";

const scaleRank: Readonly<Record<SimulationScale, number>> = { macro: 0, meso: 1, micro: 2 };

export function createSimulationSchedule(
  worldId: WorldId,
  contractHash: string,
  id: string,
  frameValues: readonly Omit<SimulationFrame, "worldId">[],
): SimulationSchedule {
  validateWorldId(worldId);
  const frames = frameValues.map((frame) => ({ ...structuredClone(frame), worldId }));
  const core = { worldId, id, contractHash, frames };
  const schedule: SimulationSchedule = { ...core, scheduleHash: hash(core) };
  const findings = validateSimulationSchedule(schedule);
  if (findings.length > 0) throw new Error(`Invalid Simulation Schedule: ${findings.join("; ")}`);
  return schedule;
}

export function createDefaultMultiScaleSchedule(
  worldId: WorldId,
  contractHash: string,
  focusSubjectIds: readonly string[] = [],
): SimulationSchedule {
  return createSimulationSchedule(worldId, contractHash, `schedule:${worldId}:default-v1`, [
    {
      id: "frame:macro-history",
      scale: "macro",
      resolution: "century",
      startWorldTime: 1,
      endWorldTime: 10000,
      subjectIds: [],
      purpose: "Long-run geography, settlement, population, institution, polity, organization, technology, ecology, disaster, and exchange evolution.",
    },
    {
      id: "frame:meso-development",
      scale: "meso",
      resolution: "year",
      startWorldTime: 1000,
      endWorldTime: 3000,
      subjectIds: [],
      parentFrameId: "frame:macro-history",
      purpose: "Decades-to-years evolution of organizations, coalitions, households, trade, law-in-use, and environmental response.",
    },
    {
      id: "frame:micro-focus",
      scale: "micro",
      resolution: "day",
      startWorldTime: 1500,
      endWorldTime: 1600,
      subjectIds: [...new Set(focusSubjectIds)].sort(),
      parentFrameId: "frame:meso-development",
      purpose: "Days and scenes around selected subjects, their accessible context, relationships, decisions, and local consequences.",
    },
  ]);
}

export function validateSimulationSchedule(schedule: SimulationSchedule): string[] {
  const issues: string[] = [];
  try {
    validateWorldId(schedule.worldId);
    assertWorldScope(schedule.worldId, schedule.frames.map((frame) => ({ label: `Frame ${frame.id}`, value: frame })));
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const ids = new Set<string>();
  for (const frame of schedule.frames) {
    if (ids.has(frame.id)) issues.push(`duplicate-frame:${frame.id}`);
    ids.add(frame.id);
    if (!Number.isSafeInteger(frame.startWorldTime) || !Number.isSafeInteger(frame.endWorldTime) || frame.startWorldTime < 0 || frame.endWorldTime < frame.startWorldTime) issues.push(`invalid-frame-range:${frame.id}`);
  }
  const byId = new Map(schedule.frames.map((frame) => [frame.id, frame]));
  for (const frame of schedule.frames) {
    if (!frame.parentFrameId) continue;
    const parent = byId.get(frame.parentFrameId);
    if (!parent) {
      issues.push(`missing-parent-frame:${frame.id}:${frame.parentFrameId}`);
      continue;
    }
    if (scaleRank[parent.scale] >= scaleRank[frame.scale]) issues.push(`invalid-scale-nesting:${parent.id}:${frame.id}`);
    if (frame.startWorldTime < parent.startWorldTime || frame.endWorldTime > parent.endWorldTime) issues.push(`child-frame-outside-parent:${frame.id}`);
  }
  const expectedHash = hash({ worldId: schedule.worldId, id: schedule.id, contractHash: schedule.contractHash, frames: schedule.frames });
  if (schedule.scheduleHash !== expectedHash) issues.push("schedule-hash-mismatch");
  return issues.sort();
}

export function createWorldEvolutionPlan(
  worldId: WorldId,
  contractHash: string,
  schedule: SimulationSchedule,
  id: string,
  boundaryValues: readonly Omit<EvolutionBoundary, "worldId">[],
  maximumCausalPassesPerBoundary = 4,
): WorldEvolutionPlan {
  validateWorldId(worldId);
  if (schedule.worldId !== worldId) throw new Error("Evolution Plan and Simulation Schedule belong to different Worlds");
  if (schedule.contractHash !== contractHash) throw new Error("Evolution Plan and Simulation Schedule bind different Contracts");
  if (!Number.isSafeInteger(maximumCausalPassesPerBoundary) || maximumCausalPassesPerBoundary < 1 || maximumCausalPassesPerBoundary > 32) {
    throw new RangeError("maximumCausalPassesPerBoundary must be an integer in [1, 32]");
  }
  const boundaries = boundaryValues.map((boundary) => ({ ...structuredClone(boundary), worldId }));
  const core = { worldId, id, contractHash, scheduleHash: schedule.scheduleHash, boundaries, maximumCausalPassesPerBoundary };
  const plan: WorldEvolutionPlan = { ...core, planHash: hash(core) };
  const findings = validateWorldEvolutionPlan(plan, schedule);
  if (findings.length > 0) throw new Error(`Invalid World Evolution Plan: ${findings.join("; ")}`);
  return plan;
}

export function validateWorldEvolutionPlan(plan: WorldEvolutionPlan, schedule: SimulationSchedule): string[] {
  const issues: string[] = [];
  if (plan.worldId !== schedule.worldId) issues.push("plan-schedule-world-mismatch");
  if (plan.contractHash !== schedule.contractHash) issues.push("plan-schedule-contract-mismatch");
  if (plan.scheduleHash !== schedule.scheduleHash) issues.push("plan-schedule-hash-mismatch");
  const frameById = new Map(schedule.frames.map((frame) => [frame.id, frame]));
  const ids = new Set<string>();
  let priorTime = -Infinity;
  for (const boundary of plan.boundaries) {
    if (boundary.worldId !== plan.worldId) issues.push(`boundary-world-mismatch:${boundary.id}`);
    if (ids.has(boundary.id)) issues.push(`duplicate-boundary:${boundary.id}`);
    ids.add(boundary.id);
    if (!Number.isSafeInteger(boundary.worldTime) || boundary.worldTime < priorTime) issues.push(`invalid-boundary-order:${boundary.id}`);
    priorTime = boundary.worldTime;
    if (!Number.isFinite(boundary.durationYears) || boundary.durationYears <= 0) issues.push(`invalid-boundary-duration:${boundary.id}`);
    const frame = frameById.get(boundary.frameId);
    if (!frame) issues.push(`unknown-boundary-frame:${boundary.id}:${boundary.frameId}`);
    else {
      if (frame.scale !== boundary.scale) issues.push(`boundary-scale-frame-mismatch:${boundary.id}`);
      if (boundary.worldTime < frame.startWorldTime || boundary.worldTime > frame.endWorldTime) issues.push(`boundary-outside-frame:${boundary.id}`);
    }
  }
  const expectedHash = hash({
    worldId: plan.worldId,
    id: plan.id,
    contractHash: plan.contractHash,
    scheduleHash: plan.scheduleHash,
    boundaries: plan.boundaries,
    maximumCausalPassesPerBoundary: plan.maximumCausalPassesPerBoundary,
  });
  if (expectedHash !== plan.planHash) issues.push("plan-hash-mismatch");
  return issues.sort();
}

const allCausalDimensions: readonly CausalDimension[] = [
  "environment", "space", "resource", "economy", "population", "organization", "institution",
  "information", "psychology", "relationship", "conflict", "hazard", "world-specific", "cross-scale",
];

/** A compact, cross-scale plan. Boundaries select opportunities; Mechanisms generate outcomes. */
export function createDefaultWorldEvolutionPlan(
  worldId: WorldId,
  contractHash: string,
  schedule: SimulationSchedule,
  calendarStartYear: number,
): WorldEvolutionPlan {
  return createWorldEvolutionPlan(worldId, contractHash, schedule, `evolution:${worldId}:closed-loop-v1`, [
    {
      id: "boundary:macro-origin",
      worldTime: 100,
      calendarYear: calendarStartYear,
      scale: "macro",
      frameId: "frame:macro-history",
      durationYears: 20,
      activeDimensions: allCausalDimensions,
      reason: "Long interval accumulation across geography, resources, population, institutions, organizations, and hazards.",
    },
    {
      id: "boundary:macro-transition",
      worldTime: 300,
      calendarYear: calendarStartYear + 20,
      scale: "macro",
      frameId: "frame:macro-history",
      durationYears: 20,
      activeDimensions: allCausalDimensions,
      reason: "Second long interval closes delayed feedback from the first macro state.",
    },
    {
      id: "boundary:meso-adaptation",
      worldTime: 1200,
      calendarYear: calendarStartYear + 21,
      scale: "meso",
      frameId: "frame:meso-development",
      durationYears: 1,
      activeDimensions: allCausalDimensions,
      reason: "Organization, institution, exchange, settlement, and population adaptation around the accumulated transition.",
    },
    {
      id: "boundary:micro-crisis",
      worldTime: 1500,
      calendarYear: calendarStartYear + 24,
      scale: "micro",
      frameId: "frame:micro-focus",
      durationYears: 1 / 365,
      activeDimensions: allCausalDimensions,
      reason: "Perspective-limited action, information, relationship, hazard, and implementation consequences.",
    },
    {
      id: "boundary:micro-response",
      worldTime: 1501,
      calendarYear: calendarStartYear + 24,
      scale: "micro",
      frameId: "frame:micro-focus",
      durationYears: 1 / 365,
      activeDimensions: allCausalDimensions,
      reason: "Same crisis at the next causal day, allowing actor and organization responses to prior committed consequences.",
    },
    {
      id: "boundary:meso-reconciliation",
      worldTime: 1600,
      calendarYear: calendarStartYear + 25,
      scale: "meso",
      frameId: "frame:meso-development",
      durationYears: 1,
      activeDimensions: allCausalDimensions,
      reason: "Reconcile local outcomes into population, organization, institution, economy, and resource state.",
    },
    {
      id: "boundary:macro-aftermath",
      worldTime: 2000,
      calendarYear: calendarStartYear + 35,
      scale: "macro",
      frameId: "frame:macro-history",
      durationYears: 10,
      activeDimensions: allCausalDimensions,
      reason: "Expose delayed cross-scale consequences and close the bounded history.",
    },
  ]);
}

export interface HazardPlan {
  readonly worldId: WorldId;
  readonly id: string;
  readonly mechanismId: string;
  readonly hazardId: string;
  readonly targetNodeId: string;
  readonly targetFieldId: string;
  readonly targetUnit: string;
  readonly worldTime: number;
  readonly causalPhase?: number;
  readonly frameId?: string;
  readonly occurrenceProbability: number;
  readonly minimumLoss: number;
  readonly maximumLoss: number;
  readonly seed: string;
}

/** Reproducible hazard opportunity; no event is emitted when the draw misses. */
export function planControlledHazard(plan: HazardPlan): readonly GraphTransitionInput[] {
  if (plan.occurrenceProbability < 0 || plan.occurrenceProbability > 1) throw new RangeError("Hazard probability must be in [0, 1]");
  if (plan.minimumLoss <= 0 || plan.maximumLoss < plan.minimumLoss) throw new RangeError("Hazard loss bounds are invalid");
  const occurrence = stableRandom({ seed: plan.seed, mechanismId: plan.mechanismId, mechanismVersion: "1", causalInstanceId: plan.id, purpose: "hazard-occurrence", drawIndex: 0 });
  if (occurrence.unitInterval >= plan.occurrenceProbability) return [];
  const magnitudeDraw = stableRandom({ seed: plan.seed, mechanismId: plan.mechanismId, mechanismVersion: "1", causalInstanceId: plan.id, purpose: "hazard-magnitude", drawIndex: 0 });
  const loss = Math.round(plan.minimumLoss + magnitudeDraw.unitInterval * (plan.maximumLoss - plan.minimumLoss));
  const fact: WorldFact = {
    id: `fact:${plan.id}:occurred`,
    subjectId: plan.hazardId,
    predicate: "hazard-occurrence",
    value: { target: plan.targetNodeId, loss, occurrenceDraw: occurrence.keyHash, magnitudeDraw: magnitudeDraw.keyHash },
    authority: "world-transition",
    provenance: [`controlled-random:${occurrence.keyHash}`, `controlled-random:${magnitudeDraw.keyHash}`],
    epistemicScope: "world",
  };
  const common = {
    worldId: plan.worldId,
    mechanismId: plan.mechanismId,
    worldTime: plan.worldTime,
    ...(plan.causalPhase === undefined ? {} : { causalPhase: plan.causalPhase }),
    ...(plan.frameId ? { frameId: plan.frameId } : {}),
  };
  return [
    { ...common, id: `input:${plan.id}:fact`, action: { kind: "assert-fact", fact } },
    { ...common, id: `input:${plan.id}:loss`, action: { kind: "adjust-node-number", nodeId: plan.targetNodeId, fieldId: plan.targetFieldId, delta: -loss, unit: plan.targetUnit } },
  ];
}
