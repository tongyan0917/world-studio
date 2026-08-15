import { hash } from "../kernel/stable.ts";
import type {
  Proof00WorldContract,
  Proof00WorldState,
} from "../kernel/types.ts";
import { mechanismVersions, nextInstant } from "./domain.ts";

export const ids = {
  contract: "contract:cut-off-town:v1",
  chair: "actor:chair-mara",
  clerk: "actor:clerk-ivo",
  keeper: "actor:keeper-sena",
  baker: "actor:baker-toma",
  innkeeper: "actor:innkeeper-lio",
  council: "organization:town-council",
  northGate: "place:north-gate",
  councilHall: "place:council-hall",
  grainStore: "place:grain-store",
  supplyRoute: "route:northern-supply",
  supplySegment: "segment:north-gate-to-store",
  reportRoute: "route:gate-to-council",
  reportSegment: "segment:gate-to-council",
  orderRoute: "route:council-to-store",
  orderSegment: "segment:council-to-store",
  grainStock: "stock:town-grain",
  officialClaim: "claim:official-road-report",
  rumorClaim: "claim:distorted-shortage-rumor",
  orderClaim: "claim:council-reservation-order",
  reportMovement: "movement:clerk-report",
  orderMovement: "movement:clerk-order",
  chairTrigger: "trigger:chair-official-report",
  chairPosition: "position:chair-reserve-grain",
  councilDecision: "decision:council-reserve-grain",
  reservation: "reservation:council-emergency",
  bakerAllocation: "allocation:baker-request",
  innkeeperAllocation: "allocation:innkeeper-request",
} as const;

export const time = {
  horizon: 72 * 60,
  anchoredReportArrival: 4 * 60,
  rumor: 8 * 60,
  grainRequests: 12 * 60,
  baseReportArrival: 18 * 60,
  orderTravel: 8 * 60,
} as const;

export const proof00Contract: Proof00WorldContract = {
  id: ids.contract,
  version: "1",
  horizon: nextInstant(time.horizon, 0),
  mechanismVersions,
  actorActionKinds: [
    "recommend-grain-reserve",
    "request-verification",
    "take-no-emergency-action",
  ],
  grainUnit: "sack",
  grainPrecision: 0,
};

export const proof00SchemaVersions = {
  worldState: "proof00.world-state.v1",
  transitionProposal: "kernel.transition-proposal.v1",
  committedTransition: "kernel.committed-transition.v1",
  traceNode: "kernel.trace-node.v1",
  runArtifact: "kernel.run-artifact.v1",
  actorDecisionContext: "proof00.actor-decision-context.v1",
  candidateActionSet: "proof00.candidate-action-set.v1",
} as const;

function actor(
  id: string,
  name: string,
  placeId: string,
  roles: Readonly<Record<string, readonly string[]>> = {},
) {
  return {
    id,
    name,
    revision: 0,
    location: { kind: "at-place" as const, placeId },
    organizationRoles: roles,
    epistemicState: {
      observationIds: [],
      accessibleClaimIds: [],
      beliefSummaries: {},
    },
    grainHolding: 0,
    decisionHistory: [],
  };
}

export function createInitialState(): Proof00WorldState {
  return {
    contractId: proof00Contract.id,
    contractVersion: proof00Contract.version,
    revision: 0,
    instant: nextInstant(0, 0),
    actors: {
      [ids.chair]: actor(ids.chair, "Mara", ids.councilHall, {
        [ids.council]: ["chair", "member"],
      }),
      [ids.clerk]: actor(ids.clerk, "Ivo", ids.northGate, {
        [ids.council]: ["clerk", "messenger", "member"],
      }),
      [ids.keeper]: actor(ids.keeper, "Sena", ids.grainStore, {
        [ids.council]: ["grain-keeper"],
      }),
      [ids.baker]: actor(ids.baker, "Toma", ids.grainStore),
      [ids.innkeeper]: actor(ids.innkeeper, "Lio", ids.grainStore),
    },
    organizations: {
      [ids.council]: {
        id: ids.council,
        name: "Cut-Off Town Council",
        revision: 0,
        placeId: ids.councilHall,
        memberRoles: {
          [ids.chair]: ["chair", "member"],
          [ids.clerk]: ["clerk", "messenger", "member"],
          [ids.keeper]: ["grain-keeper"],
        },
        recordsByRole: { clerk: [] },
        procedureId: "procedure:chair-acts-on-clerked-emergency-report:v1",
        decisions: {},
      },
    },
    places: {
      [ids.northGate]: { id: ids.northGate, name: "North Gate", revision: 0 },
      [ids.councilHall]: { id: ids.councilHall, name: "Council Hall", revision: 0 },
      [ids.grainStore]: { id: ids.grainStore, name: "Town Grain Store", revision: 0 },
    },
    routes: {
      [ids.supplyRoute]: {
        id: ids.supplyRoute,
        name: "Northern Supply Road",
        revision: 0,
        placePath: [ids.northGate, ids.grainStore],
        segments: [{
          id: ids.supplySegment,
          from: ids.northGate,
          to: ids.grainStore,
          baseDurationMinutes: 6 * 60,
          delayMinutes: 0,
          status: "open",
          capacity: 30,
        }],
      },
      [ids.reportRoute]: {
        id: ids.reportRoute,
        name: "Gate–Council Footpath",
        revision: 0,
        placePath: [ids.northGate, ids.councilHall],
        segments: [{
          id: ids.reportSegment,
          from: ids.northGate,
          to: ids.councilHall,
          baseDurationMinutes: time.anchoredReportArrival,
          delayMinutes: 0,
          status: "open",
          capacity: 4,
        }],
      },
      [ids.orderRoute]: {
        id: ids.orderRoute,
        name: "Council–Store Lane",
        revision: 0,
        placePath: [ids.councilHall, ids.grainStore],
        segments: [{
          id: ids.orderSegment,
          from: ids.councilHall,
          to: ids.grainStore,
          baseDurationMinutes: time.orderTravel,
          delayMinutes: 0,
          status: "open",
          capacity: 10,
        }],
      },
    },
    movements: {},
    claims: {},
    decisionTriggers: {},
    actorPositions: {},
    grainStocks: {
      [ids.grainStock]: {
        id: ids.grainStock,
        revision: 0,
        placeId: ids.grainStore,
        unit: "sack",
        openingQuantity: 100,
        physicalQuantity: 100,
        reservedQuantity: 0,
      },
    },
    grainReservations: {},
    grainAllocations: {},
  };
}

export const proof00ContractHash = hash(proof00Contract);
export const proof00InitialStateHash = hash(createInitialState());
