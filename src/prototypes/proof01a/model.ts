/**
 * THROWAWAY PROTOTYPE — Proof 01A
 *
 * Question: can a low-resolution resident be focused as the same person while
 * the already-committed world history, population count, and grain
 * contribution remain conserved?
 *
 * This file deliberately models only that transition. It has no I/O, no
 * psychology model, and no reusable promotion framework.
 */

import { hash } from "../../kernel/stable.ts";

export const DEFAULT_RESIDENT_COUNT = 200;
export const DEFAULT_FOCUS_RESIDENT_ID = "resident-0042";

export interface WorldHistoryEvent {
  readonly id: string;
  readonly day: number;
  readonly fact: string;
}

export interface ResidentContinuityRecord {
  readonly id: string;
  readonly populationGroupId: string;
  readonly grainContribution: number;
  readonly committedHistoryEventIds: readonly string[];
}

export interface DetailedResident {
  readonly id: string;
  readonly continuityRecordId: string;
  readonly resolution: "focused";
  readonly populationGroupId: string;
  readonly grainContribution: number;
  readonly inheritedHistoryEventIds: readonly string[];
  readonly currentConcern: "market-grain-access" | "household-grain-duration";
}

export interface PopulationResidual {
  readonly residentIds: readonly string[];
  readonly grainContribution: number;
}

export interface FocusPromotionLogEntry {
  readonly id: string;
  readonly kind: "focus-promotion";
  readonly residentId: string;
  readonly transferredGrainContribution: number;
  readonly worldHistoryHash: string;
}

export interface Proof01AState {
  readonly residents: Readonly<Record<string, ResidentContinuityRecord>>;
  readonly populationResidual: PopulationResidual;
  readonly detailedResidents: Readonly<Record<string, DetailedResident>>;
  readonly totalGrainContribution: number;
  readonly worldHistory: readonly WorldHistoryEvent[];
  readonly committedHistoryHash: string;
  readonly focusPromotionLog: readonly FocusPromotionLogEntry[];
}

export interface Proof01AProjection {
  readonly residentCount: number;
  readonly residentIdsHash: string;
  readonly residualResidentIds: readonly string[];
  readonly detailedResidentIds: readonly string[];
  readonly detailedResidents: readonly DetailedResident[];
  readonly residualGrain: number;
  readonly detailedGrain: number;
  readonly totalGrain: number;
  readonly grainConserved: boolean;
  readonly identityPreserved: boolean;
  readonly historyHash: string;
  readonly committedHistoryHash: string;
  readonly historyPreserved: boolean;
  readonly promotions: readonly FocusPromotionLogEntry[];
}

export interface Proof01ASummary {
  readonly residentCount: number;
  readonly residualCount: number;
  readonly detailedCount: number;
  readonly residualGrain: number;
  readonly detailedGrain: number;
  readonly totalGrain: number;
  readonly grainConserved: boolean;
  readonly identityPreserved: boolean;
  readonly historyEventCount: number;
  readonly historyHash: string;
  readonly committedHistoryHash: string;
  readonly historyPreserved: boolean;
  readonly promotionCount: number;
  readonly lastPromotion: FocusPromotionLogEntry | null;
  readonly focusedResidents: readonly DetailedResident[];
  readonly projectionHash: string;
}

function residentId(ordinal: number): string {
  return `resident-${String(ordinal).padStart(4, "0")}`;
}

function initialHistory(): readonly WorldHistoryEvent[] {
  return [
    {
      id: "history-town-register",
      day: 0,
      fact: "The town register contains every resident in this prototype.",
    },
    {
      id: "history-road-closed",
      day: 1,
      fact: "Flooding closed the only grain road into town.",
    },
  ];
}

/** Create about one town's worth of stable, still-low-resolution residents. */
export function createInitialState(
  residentCount: number = DEFAULT_RESIDENT_COUNT,
): Proof01AState {
  const worldHistory = initialHistory();
  const historyEventIds = worldHistory.map((event) => event.id);
  const records = Array.from({ length: residentCount }, (_, index) => {
    const ordinal = index + 1;
    const id = residentId(ordinal);
    const record: ResidentContinuityRecord = {
      id,
      populationGroupId: ordinal % 2 === 0 ? "east-quarter" : "west-quarter",
      grainContribution: 2,
      committedHistoryEventIds: historyEventIds,
    };
    return record;
  });
  const residents = Object.fromEntries(
    records.map((record) => [record.id, record]),
  ) as Readonly<Record<string, ResidentContinuityRecord>>;
  const totalGrainContribution = records.reduce(
    (total, resident) => total + resident.grainContribution,
    0,
  );

  return {
    residents,
    populationResidual: {
      residentIds: records.map((resident) => resident.id),
      grainContribution: totalGrainContribution,
    },
    detailedResidents: {},
    totalGrainContribution,
    worldHistory,
    committedHistoryHash: hash(worldHistory),
    focusPromotionLog: [],
  };
}

/**
 * Focus one existing resident without inventing a replacement identity.
 * Re-focusing an already detailed resident is intentionally idempotent.
 */
export function focusResident(
  state: Proof01AState,
  residentIdToFocus: string,
): Proof01AState {
  const continuityRecord = state.residents[residentIdToFocus];
  if (!continuityRecord) {
    throw new RangeError(`Unknown resident: ${residentIdToFocus}`);
  }
  if (state.detailedResidents[residentIdToFocus]) return state;
  if (!state.populationResidual.residentIds.includes(residentIdToFocus)) {
    throw new RangeError(`Resident is not available in the population residual: ${residentIdToFocus}`);
  }

  const detailedResident: DetailedResident = {
    id: continuityRecord.id,
    continuityRecordId: continuityRecord.id,
    resolution: "focused",
    populationGroupId: continuityRecord.populationGroupId,
    grainContribution: continuityRecord.grainContribution,
    inheritedHistoryEventIds: continuityRecord.committedHistoryEventIds,
    currentConcern: continuityRecord.populationGroupId === "east-quarter"
      ? "market-grain-access"
      : "household-grain-duration",
  };
  const promotion: FocusPromotionLogEntry = {
    id: `focus-promotion-${String(state.focusPromotionLog.length + 1).padStart(4, "0")}`,
    kind: "focus-promotion",
    residentId: continuityRecord.id,
    transferredGrainContribution: continuityRecord.grainContribution,
    worldHistoryHash: hash(state.worldHistory),
  };

  return {
    ...state,
    populationResidual: {
      residentIds: state.populationResidual.residentIds.filter(
        (id) => id !== residentIdToFocus,
      ),
      grainContribution:
        state.populationResidual.grainContribution - continuityRecord.grainContribution,
    },
    detailedResidents: {
      ...state.detailedResidents,
      [continuityRecord.id]: detailedResident,
    },
    focusPromotionLog: [...state.focusPromotionLog, promotion],
  };
}

export function projectState(state: Proof01AState): Proof01AProjection {
  const residentIds = Object.keys(state.residents).sort();
  const residualResidentIds = [...state.populationResidual.residentIds].sort();
  const detailedResidentIds = Object.keys(state.detailedResidents).sort();
  const detailedResidents = detailedResidentIds.map(
    (id) => state.detailedResidents[id],
  );
  const detailedGrain = detailedResidentIds.reduce(
    (total, id) => total + state.detailedResidents[id].grainContribution,
    0,
  );
  const historyHash = hash(state.worldHistory);
  const identityPreserved = detailedResidentIds.every((id) => {
    const detail = state.detailedResidents[id];
    return detail.id === id && detail.continuityRecordId === state.residents[id]?.id;
  });

  return {
    residentCount: residentIds.length,
    residentIdsHash: hash(residentIds),
    residualResidentIds,
    detailedResidentIds,
    detailedResidents,
    residualGrain: state.populationResidual.grainContribution,
    detailedGrain,
    totalGrain: state.totalGrainContribution,
    grainConserved:
      state.populationResidual.grainContribution + detailedGrain ===
      state.totalGrainContribution,
    identityPreserved,
    historyHash,
    committedHistoryHash: state.committedHistoryHash,
    historyPreserved: historyHash === state.committedHistoryHash,
    promotions: state.focusPromotionLog,
  };
}

export function projectionHash(state: Proof01AState): string {
  return hash(projectState(state));
}

/** One-screen, diff-friendly view for the throwaway terminal shell. */
export function summarizeState(state: Proof01AState): Proof01ASummary {
  const projection = projectState(state);
  return {
    residentCount: projection.residentCount,
    residualCount: projection.residualResidentIds.length,
    detailedCount: projection.detailedResidentIds.length,
    residualGrain: projection.residualGrain,
    detailedGrain: projection.detailedGrain,
    totalGrain: projection.totalGrain,
    grainConserved: projection.grainConserved,
    identityPreserved: projection.identityPreserved,
    historyEventCount: state.worldHistory.length,
    historyHash: projection.historyHash,
    committedHistoryHash: projection.committedHistoryHash,
    historyPreserved: projection.historyPreserved,
    promotionCount: projection.promotions.length,
    lastPromotion: projection.promotions.at(-1) ?? null,
    focusedResidents: projection.detailedResidents,
    projectionHash: hash(projection),
  };
}
