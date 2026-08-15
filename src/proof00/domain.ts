import {
  type CoordinationResolver,
  type MechanismRegistration,
  type ProposalValidator,
  type StateAdapter,
  type ValidationIssue,
  Kernel,
} from "../kernel/kernel.ts";
import { hash, stableRandom } from "../kernel/stable.ts";
import type {
  GrainAllocationState,
  LogicalInstant,
  Proof00Action,
  Proof00ActorState,
  Proof00ClaimState,
  Proof00MovementState,
  Proof00OrganizationState,
  Proof00RouteState,
  Proof00WorldState,
  RecordedRandomDraw,
  StateChange,
  StatePath,
  TransitionProposal,
  ValidatorRef,
} from "../kernel/types.ts";

export const ACTION_VALIDATOR: ValidatorRef = {
  id: "proof00-action-validity",
  version: "1",
};

export const PRECONDITION_VALIDATOR: ValidatorRef = {
  id: "proof00-preconditions",
  version: "1",
};

export const GRAIN_RESOLVER: ValidatorRef = {
  id: "proof00-grain-allocation",
  version: "1",
};

export const mechanismVersions = {
  weather: "1",
  information: "1",
  movement: "1",
  "decision-trigger": "1",
  "actor-decision": "1",
  organization: "1",
  grain: "1",
} as const;

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

function mutable<T>(value: T): Mutable<T> {
  return value as Mutable<T>;
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}

function decodePathPart(value: string | undefined): string {
  return decodeURIComponent(value ?? "");
}

function actorPath(actorId: string): string {
  return `actor:${encodePathPart(actorId)}`;
}

function routePath(routeId: string): string {
  return `route:${encodePathPart(routeId)}`;
}

function movementPath(movementId: string): string {
  return `movement:${encodePathPart(movementId)}`;
}

function claimPath(claimId: string): string {
  return `claim:${encodePathPart(claimId)}`;
}

function organizationPath(organizationId: string): string {
  return `organization:${encodePathPart(organizationId)}`;
}

function grainPath(stockId: string): string {
  return `grain:${encodePathPart(stockId)}`;
}

export const paths = {
  actor: actorPath,
  actorEpistemic: (actorId: string) => `${actorPath(actorId)}:epistemic`,
  actorLocation: (actorId: string) => `${actorPath(actorId)}:location`,
  actorPosition: (positionId: string) => `actor-position:${encodePathPart(positionId)}`,
  route: routePath,
  movement: movementPath,
  claim: claimPath,
  trigger: (triggerId: string) => `trigger:${encodePathPart(triggerId)}`,
  organization: organizationPath,
  organizationRecords: (organizationId: string, role: string) =>
    `${organizationPath(organizationId)}:records:${encodePathPart(role)}`,
  organizationDecision: (organizationId: string, decisionId: string) =>
    `${organizationPath(organizationId)}:decision:${encodePathPart(decisionId)}`,
  grain: grainPath,
  reservation: (reservationId: string) => `grain-reservation:${encodePathPart(reservationId)}`,
  allocation: (allocationId: string) => `grain-allocation:${encodePathPart(allocationId)}`,
};

function readPath(state: Proof00WorldState, path: string): unknown {
  const parts = path.split(":");
  switch (parts[0]) {
    case "actor": {
      const actor = state.actors[decodePathPart(parts[1])];
      if (parts[2] === "epistemic") return actor?.epistemicState ?? null;
      if (parts[2] === "location") return actor?.location ?? null;
      return actor ?? null;
    }
    case "actor-position":
      return state.actorPositions[decodePathPart(parts[1])] ?? null;
    case "route":
      return state.routes[decodePathPart(parts[1])] ?? null;
    case "movement":
      return state.movements[decodePathPart(parts[1])] ?? null;
    case "claim":
      return state.claims[decodePathPart(parts[1])] ?? null;
    case "trigger":
      return state.decisionTriggers[decodePathPart(parts[1])] ?? null;
    case "organization": {
      const organization = state.organizations[decodePathPart(parts[1])];
      if (parts[2] === "records") return organization?.recordsByRole[decodePathPart(parts[3])] ?? [];
      if (parts[2] === "decision") return organization?.decisions[decodePathPart(parts[3])] ?? null;
      return organization ?? null;
    }
    case "grain":
      return state.grainStocks[decodePathPart(parts[1])] ?? null;
    case "grain-reservation":
      return state.grainReservations[decodePathPart(parts[1])] ?? null;
    case "grain-allocation":
      return state.grainAllocations[decodePathPart(parts[1])] ?? null;
    default:
      if (path === "world") return state;
      return null;
  }
}

function validateWorld(state: Proof00WorldState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const stock of Object.values(state.grainStocks)) {
    const granted = Object.values(state.grainAllocations)
      .filter((allocation) => allocation.stockId === stock.id)
      .reduce((total, allocation) => total + allocation.grantedQuantity, 0);
    if (stock.physicalQuantity < 0 || stock.reservedQuantity < 0) {
      issues.push({ code: "negative-grain", message: `Negative grain in ${stock.id}` });
    }
    if (stock.reservedQuantity > stock.physicalQuantity) {
      issues.push({ code: "over-reserved-grain", message: `Reservation exceeds stock in ${stock.id}` });
    }
    if (stock.openingQuantity !== stock.physicalQuantity + granted) {
      issues.push({ code: "grain-conservation", message: `Grain does not reconcile in ${stock.id}` });
    }
    const activeReservations = Object.values(state.grainReservations)
      .filter((reservation) => reservation.stockId === stock.id && reservation.status === "active")
      .reduce((total, reservation) => total + reservation.quantity, 0);
    if (activeReservations !== stock.reservedQuantity) {
      issues.push({ code: "grain-reservation-ledger", message: `Reservation ledger does not reconcile in ${stock.id}` });
    }
    if (
      !Number.isSafeInteger(stock.openingQuantity) ||
      !Number.isSafeInteger(stock.physicalQuantity) ||
      !Number.isSafeInteger(stock.reservedQuantity)
    ) {
      issues.push({ code: "grain-precision", message: `Grain quantities must be safe integers in ${stock.id}` });
    }
  }

  for (const actor of Object.values(state.actors)) {
    if (actor.grainHolding < 0) {
      issues.push({ code: "negative-actor-grain", message: `Negative holding for ${actor.id}` });
    }
    if (actor.location.kind === "at-place" && !state.places[actor.location.placeId]) {
      issues.push({ code: "unknown-place", message: `Unknown location for ${actor.id}` });
    }
    if (actor.location.kind === "in-transit") {
      const movement = state.movements[actor.location.movementId];
      if (!movement || movement.moverId !== actor.id || movement.status !== "in-progress") {
        issues.push({ code: "invalid-transit", message: `Invalid movement for ${actor.id}` });
      }
    }
    for (const claimId of actor.epistemicState.accessibleClaimIds) {
      const claim = state.claims[claimId];
      if (!claim || !claim.receivedBy[actor.id]) {
        issues.push({ code: "epistemic-provenance", message: `Unreceived claim ${claimId} for ${actor.id}` });
      }
    }
  }

  const latestArrivalByMover = new Map<string, Proof00MovementState>();
  for (const movement of Object.values(state.movements)) {
    if (movement.status !== "arrived" || !movement.arrivedAt) continue;
    const current = latestArrivalByMover.get(movement.moverId);
    if (
      !current?.arrivedAt ||
      movement.arrivedAt.worldTime > current.arrivedAt.worldTime ||
      (movement.arrivedAt.worldTime === current.arrivedAt.worldTime &&
        movement.arrivedAt.causalPhase > current.arrivedAt.causalPhase)
    ) {
      latestArrivalByMover.set(movement.moverId, movement);
    }
  }
  for (const [moverId, movement] of latestArrivalByMover) {
    const actor = state.actors[moverId];
    if (
      actor?.location.kind === "at-place" &&
      actor.location.placeId !== movement.destination
    ) {
      issues.push({ code: "arrival-location", message: `Latest arrival not reflected for ${movement.id}` });
    }
  }

  const allocated = Object.values(state.grainAllocations)
    .reduce((total, allocation) => total + allocation.grantedQuantity, 0);
  const held = Object.values(state.actors)
    .reduce((total, actor) => total + actor.grainHolding, 0);
  if (allocated !== held) {
    issues.push({ code: "grain-holder-ledger", message: "Actor grain holdings do not reconcile with allocations" });
  }

  return issues;
}

function allKeys(...records: readonly Readonly<Record<string, unknown>>[]): string[] {
  return [...new Set(records.flatMap((record) => Object.keys(record)))].sort();
}

function different(left: unknown, right: unknown): boolean {
  return hash(left) !== hash(right);
}

function withoutKeys(
  value: Readonly<Record<string, unknown>> | undefined,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (!value) return null;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function diffWorldPaths(before: Proof00WorldState, after: Proof00WorldState): StatePath[] {
  const changed = new Set<StatePath>();

  if (different(
    withoutKeys(before as unknown as Readonly<Record<string, unknown>>, [
      "revision", "instant", "actors", "organizations", "places", "routes", "movements",
      "claims", "decisionTriggers", "actorPositions", "grainStocks", "grainReservations",
      "grainAllocations",
    ]),
    withoutKeys(after as unknown as Readonly<Record<string, unknown>>, [
      "revision", "instant", "actors", "organizations", "places", "routes", "movements",
      "claims", "decisionTriggers", "actorPositions", "grainStocks", "grainReservations",
      "grainAllocations",
    ]),
  )) changed.add("world");

  for (const id of allKeys(before.actors, after.actors)) {
    const left = before.actors[id];
    const right = after.actors[id];
    if (different(left?.location ?? null, right?.location ?? null)) changed.add(paths.actorLocation(id));
    if (different(left?.epistemicState ?? null, right?.epistemicState ?? null)) changed.add(paths.actorEpistemic(id));
    if (different(
      withoutKeys(left as unknown as Readonly<Record<string, unknown>>, ["revision", "location", "epistemicState"]),
      withoutKeys(right as unknown as Readonly<Record<string, unknown>>, ["revision", "location", "epistemicState"]),
    )) changed.add(paths.actor(id));
  }
  for (const id of allKeys(before.routes, after.routes)) {
    if (different(
      withoutKeys(before.routes[id] as unknown as Readonly<Record<string, unknown>>, ["revision"]),
      withoutKeys(after.routes[id] as unknown as Readonly<Record<string, unknown>>, ["revision"]),
    )) changed.add(paths.route(id));
  }
  for (const id of allKeys(before.movements, after.movements)) {
    if (different(before.movements[id] ?? null, after.movements[id] ?? null)) changed.add(paths.movement(id));
  }
  for (const id of allKeys(before.claims, after.claims)) {
    if (different(before.claims[id] ?? null, after.claims[id] ?? null)) changed.add(paths.claim(id));
  }
  for (const id of allKeys(before.decisionTriggers, after.decisionTriggers)) {
    if (different(before.decisionTriggers[id] ?? null, after.decisionTriggers[id] ?? null)) changed.add(paths.trigger(id));
  }
  for (const id of allKeys(before.actorPositions, after.actorPositions)) {
    if (different(before.actorPositions[id] ?? null, after.actorPositions[id] ?? null)) changed.add(paths.actorPosition(id));
  }
  for (const organizationId of allKeys(before.organizations, after.organizations)) {
    const left = before.organizations[organizationId];
    const right = after.organizations[organizationId];
    for (const role of allKeys(left?.recordsByRole ?? {}, right?.recordsByRole ?? {})) {
      if (different(left?.recordsByRole[role] ?? [], right?.recordsByRole[role] ?? [])) {
        changed.add(paths.organizationRecords(organizationId, role));
      }
    }
    for (const decisionId of allKeys(left?.decisions ?? {}, right?.decisions ?? {})) {
      if (different(left?.decisions[decisionId] ?? null, right?.decisions[decisionId] ?? null)) {
        changed.add(paths.organizationDecision(organizationId, decisionId));
      }
    }
    if (different(
      withoutKeys(left as unknown as Readonly<Record<string, unknown>>, ["revision", "recordsByRole", "decisions"]),
      withoutKeys(right as unknown as Readonly<Record<string, unknown>>, ["revision", "recordsByRole", "decisions"]),
    )) changed.add(paths.organization(organizationId));
  }
  for (const id of allKeys(before.grainStocks, after.grainStocks)) {
    if (different(
      withoutKeys(before.grainStocks[id] as unknown as Readonly<Record<string, unknown>>, ["revision"]),
      withoutKeys(after.grainStocks[id] as unknown as Readonly<Record<string, unknown>>, ["revision"]),
    )) changed.add(paths.grain(id));
  }
  for (const id of allKeys(before.grainReservations, after.grainReservations)) {
    if (different(before.grainReservations[id] ?? null, after.grainReservations[id] ?? null)) changed.add(paths.reservation(id));
  }
  for (const id of allKeys(before.grainAllocations, after.grainAllocations)) {
    if (different(before.grainAllocations[id] ?? null, after.grainAllocations[id] ?? null)) changed.add(paths.allocation(id));
  }

  return [...changed].sort();
}

export const proof00StateAdapter: StateAdapter<Proof00WorldState> = {
  clone: (state) => structuredClone(state),
  hash,
  read: readPath,
  setKernelMeta: (state, revision, instant) => {
    mutable(state).revision = revision;
    mutable(state).instant = { ...instant };
  },
  validateInvariants: validateWorld,
  diffPaths: diffWorldPaths,
};

function actionOf(proposal: TransitionProposal): Proof00Action {
  return proposal.action as Proof00Action;
}

function issue(code: string, message: string): ValidationIssue[] {
  return [{ code, message }];
}

function routeDuration(
  route: Proof00RouteState,
  origin: string,
  destination: string,
): { duration: number; blocked: boolean } | undefined {
  const originIndex = route.placePath.indexOf(origin);
  const destinationIndex = route.placePath.indexOf(destination);
  if (originIndex < 0 || destinationIndex <= originIndex) return undefined;
  const segments = route.segments.slice(originIndex, destinationIndex);
  return {
    duration: segments.reduce(
      (total, segment) => total + segment.baseDurationMinutes + segment.delayMinutes,
      0,
    ),
    blocked: segments.some((segment) => segment.status === "blocked"),
  };
}

const actionValidator: ProposalValidator<Proof00WorldState> = {
  ...ACTION_VALIDATOR,
  validate(proposal, state) {
    const action = actionOf(proposal);
    const expectedAuthority = (() => {
      if (action.kind === "set-route-state") {
        return { kind: "world-rule", principalId: state.contractId } as const;
      }
      if (action.kind === "record-actor-position") {
        return { kind: "actor", principalId: action.position.actorId } as const;
      }
      if (action.kind === "record-organization-decision") {
        return { kind: "organization", principalId: action.organizationId } as const;
      }
      if (action.kind === "reserve-grain") {
        return { kind: "organization", principalId: action.reservation.organizationId } as const;
      }
      if (action.kind === "request-grain") {
        return { kind: "actor", principalId: action.allocation.requesterId } as const;
      }
      return { kind: "mechanism", principalId: proposal.source } as const;
    })();
    if (
      proposal.authority.kind !== expectedAuthority.kind ||
      proposal.authority.principalId !== expectedAuthority.principalId
    ) {
      return issue("domain-authority", `${proposal.authority.principalId} cannot perform ${action.kind}`);
    }
    if (proposal.permissionClaims.length !== 1) {
      return issue("permission-cardinality", action.kind);
    }
    const resourceClaims = proposal.resourceClaims;
    if (action.kind === "reserve-grain" || action.kind === "request-grain") {
      const expected = action.kind === "reserve-grain"
        ? {
            stockId: action.reservation.stockId,
            quantity: action.reservation.quantity,
            mode: "reserve",
          }
        : {
            stockId: action.allocation.stockId,
            quantity: action.allocation.requestedQuantity,
            mode: "consume",
          };
      const claim = resourceClaims[0];
      if (
        resourceClaims.length !== 1 ||
        claim?.resourceType !== "grain" ||
        claim.resourceId !== expected.stockId ||
        claim.mode !== expected.mode ||
        claim.quantity !== expected.quantity ||
        claim.unit !== "sack"
      ) {
        return issue("grain-resource-claim", action.kind);
      }
    } else if (resourceClaims.length !== 0) {
      return issue("unexpected-resource-claim", action.kind);
    }
    switch (action.kind) {
      case "set-route-state": {
        const route = state.routes[action.routeId];
        if (!route) return issue("unknown-route", action.routeId);
        if (!route.segments.some((segment) => segment.id === action.segmentId)) {
          return issue("unknown-route-segment", action.segmentId);
        }
        if (!Number.isSafeInteger(action.delayMinutes) || action.delayMinutes < 0) {
          return issue("invalid-delay", action.segmentId);
        }
        return [];
      }
      case "create-claim": {
        if (state.claims[action.claim.id]) return issue("duplicate-claim", action.claim.id);
        if (!state.actors[action.claim.sourceActorId]) return issue("unknown-claim-source", action.claim.id);
        if (action.claim.revision !== 0 || Object.keys(action.claim.receivedBy).length !== 0) {
          return issue("invalid-new-claim-state", action.claim.id);
        }
        if (action.claim.derivedFrom) {
          if (!state.claims[action.claim.derivedFrom]) {
            return issue("unknown-derived-claim", action.claim.id);
          }
          if (!state.actors[action.claim.sourceActorId]!.epistemicState.accessibleClaimIds.includes(action.claim.derivedFrom)) {
            return issue("claim-source-lacks-derived-information", action.claim.id);
          }
        }
        if (
          action.claim.formedAt.worldTime !== proposal.instant.worldTime ||
          action.claim.formedAt.causalPhase !== proposal.instant.causalPhase
        ) return issue("claim-formed-at", action.claim.id);
        if (action.claim.provenance.some((parent) => !proposal.causalParents.includes(parent))) {
          return issue("claim-provenance", action.claim.id);
        }
        return [];
      }
      case "start-movement": {
        const movement = action.movement;
        if (state.movements[movement.id]) return issue("duplicate-movement", movement.id);
        const actor = state.actors[movement.moverId];
        const route = state.routes[movement.routeId];
        if (!actor || actor.location.kind !== "at-place" || actor.location.placeId !== movement.origin) {
          return issue("movement-origin", movement.id);
        }
        if (!route) return issue("unknown-route", movement.routeId);
        if (
          movement.startedAt.worldTime !== proposal.instant.worldTime ||
          movement.startedAt.causalPhase !== proposal.instant.causalPhase ||
          movement.status !== "in-progress"
        ) return issue("movement-start-instant", movement.id);
        const travel = routeDuration(route, movement.origin, movement.destination);
        if (!travel) return issue("unreachable-route", movement.id);
        if (travel.blocked) return issue("blocked-route", movement.id);
        if (
          movement.earliestArrival.worldTime <
          movement.startedAt.worldTime + travel.duration
        ) {
          return issue("movement-too-fast", movement.id);
        }
        return [];
      }
      case "complete-movement": {
        const movement = state.movements[action.movementId];
        if (!movement || movement.status !== "in-progress") {
          return issue("movement-not-active", action.movementId);
        }
        if (proposal.instant.worldTime < movement.earliestArrival.worldTime) {
          return issue("premature-arrival", action.movementId);
        }
        const route = state.routes[movement.routeId];
        const travel = route
          ? routeDuration(route, movement.origin, movement.destination)
          : undefined;
        if (!travel) return issue("arrival-route-missing", action.movementId);
        if (travel.blocked) return issue("arrival-route-blocked", action.movementId);
        if (proposal.instant.worldTime < movement.startedAt.worldTime + travel.duration) {
          return issue("arrival-route-delay", action.movementId);
        }
        if (!proposal.readSet.some((read) => read.path === paths.route(movement.routeId))) {
          return issue("arrival-route-unbound", action.movementId);
        }
        if (!proposal.subjects.includes(movement.moverId)) {
          return issue("movement-subject", action.movementId);
        }
        return [];
      }
      case "deliver-claim": {
        const claim = state.claims[action.claimId];
        if (!claim) return issue("unknown-claim", action.claimId);
        if (action.recipientType === "actor") {
          const recipient = state.actors[action.recipientId];
          if (!recipient) return issue("unknown-recipient", action.recipientId);
          if (claim.receivedBy[action.recipientId]) return issue("duplicate-claim-delivery", action.claimId);
          if (action.channel === "in-person") {
            const carrier = action.carrierId ? state.actors[action.carrierId] : undefined;
            if (
              !carrier ||
              carrier.location.kind !== "at-place" ||
              recipient.location.kind !== "at-place" ||
              carrier.location.placeId !== recipient.location.placeId
            ) {
              return issue("in-person-not-colocated", action.claimId);
            }
          }
        } else {
          const organization = state.organizations[action.recipientId];
          if (!organization || !action.role) return issue("invalid-organization-recipient", action.recipientId);
          if ((organization.recordsByRole[action.role] ?? []).includes(action.claimId)) {
            return issue("duplicate-organization-delivery", action.claimId);
          }
          const carrier = action.carrierId ? state.actors[action.carrierId] : undefined;
          if (
            action.channel === "in-person" &&
            (!carrier ||
              carrier.location.kind !== "at-place" ||
              carrier.location.placeId !== organization.placeId)
          ) {
            return issue("organization-delivery-location", action.claimId);
          }
        }
        return [];
      }
      case "emit-decision-trigger":
        if (state.decisionTriggers[action.trigger.id]) return issue("duplicate-trigger", action.trigger.id);
        if (
          action.trigger.instant.worldTime !== proposal.instant.worldTime ||
          action.trigger.instant.causalPhase !== proposal.instant.causalPhase ||
          action.trigger.causalParents.some((parent) => !proposal.causalParents.includes(parent))
        ) return issue("trigger-causality", action.trigger.id);
        return [];
      case "record-actor-position": {
        const trigger = state.decisionTriggers[action.position.triggerId];
        if (!trigger || trigger.actorId !== action.position.actorId) {
          return issue("invalid-decision-trigger", action.position.id);
        }
        const actor = state.actors[action.position.actorId];
        if (!actor) return issue("unknown-actor", action.position.actorId);
        if (state.actorPositions[action.position.id]) return issue("duplicate-actor-position", action.position.id);
        if (!action.position.contributionHash) return issue("missing-contribution-hash", action.position.id);
        if (
          action.position.decidedAt.worldTime !== proposal.instant.worldTime ||
          action.position.decidedAt.causalPhase !== proposal.instant.causalPhase
        ) return issue("position-instant", action.position.id);
        if (
          action.position.evidenceRefs.some(
            (evidence) => !actor.epistemicState.accessibleClaimIds.includes(evidence),
          )
        ) {
          return issue("hidden-decision-evidence", action.position.id);
        }
        return [];
      }
      case "record-organization-decision": {
        const organization = state.organizations[action.organizationId];
        const decision = action.decision;
        if (!organization) return issue("unknown-organization", action.organizationId);
        if (organization.decisions[decision.id]) return issue("duplicate-organization-decision", decision.id);
        if (
          decision.decidedAt?.worldTime !== proposal.instant.worldTime ||
          decision.decidedAt.causalPhase !== proposal.instant.causalPhase ||
          decision.causalParents.some((parent) => !proposal.causalParents.includes(parent))
        ) return issue("organization-decision-causality", decision.id);
        if (!decision.authorityActorId || !organization.memberRoles[decision.authorityActorId]?.includes("chair")) {
          return issue("organization-authority", decision.id);
        }
        const position = decision.supportingPositionId
          ? state.actorPositions[decision.supportingPositionId]
          : undefined;
        if (!position) {
          return issue("missing-member-position", decision.id);
        }
        if (
          position.actorId !== decision.authorityActorId ||
          position.action.kind !== "recommend-grain-reserve" ||
          position.action.organizationId !== action.organizationId ||
          position.action.stockId !== decision.stockId ||
          position.action.quantity !== decision.quantity
        ) return issue("organization-position-mismatch", decision.id);
        if ((organization.recordsByRole.clerk ?? []).length === 0) {
          return issue("missing-organization-record", decision.id);
        }
        return [];
      }
      case "reserve-grain": {
        const reservation = action.reservation;
        const stock = state.grainStocks[reservation.stockId];
        if (
          !stock ||
          !Number.isSafeInteger(reservation.quantity) ||
          reservation.quantity <= 0 ||
          reservation.status !== "active" ||
          state.grainReservations[reservation.id]
        ) return issue("invalid-reservation", reservation.id);
        if (reservation.causalParents.some((parent) => !proposal.causalParents.includes(parent))) {
          return issue("reservation-causality", reservation.id);
        }
        if (stock.physicalQuantity - stock.reservedQuantity < reservation.quantity) {
          return issue("insufficient-unreserved-grain", reservation.id);
        }
        const keeper = state.actors[reservation.holderId];
        const order = state.claims[reservation.orderClaimId];
        const organization = state.organizations[reservation.organizationId];
        const decision = organization?.decisions[reservation.decisionId];
        if (!keeper?.epistemicState.accessibleClaimIds.includes(reservation.orderClaimId)) {
          return issue("order-not-delivered", reservation.id);
        }
        if (
          order?.kind !== "organization-order" ||
          decision?.status !== "adopted" ||
          decision.orderId !== reservation.orderClaimId ||
          decision.stockId !== reservation.stockId ||
          decision.quantity !== reservation.quantity
        ) return issue("reservation-order-mismatch", reservation.id);
        return [];
      }
      case "request-grain": {
        const allocation = action.allocation;
        if (
          !state.grainStocks[allocation.stockId] ||
          !Number.isSafeInteger(allocation.requestedQuantity) ||
          allocation.requestedQuantity <= 0 ||
          allocation.status !== "pending" ||
          allocation.grantedQuantity !== 0 ||
          state.grainAllocations[allocation.id]
        ) {
          return issue("invalid-grain-request", allocation.id);
        }
        if (allocation.causalParents.some((parent) => !proposal.causalParents.includes(parent))) {
          return issue("allocation-causality", allocation.id);
        }
        if (!state.actors[allocation.requesterId]) return issue("unknown-requester", allocation.requesterId);
        return [];
      }
    }
    return issue("unknown-action", String((action as { kind?: unknown }).kind));
  },
};

function preconditionMatches(
  proposal: TransitionProposal,
  state: Proof00WorldState,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const precondition of proposal.preconditions) {
    const args = precondition.arguments;
    switch (precondition.kind) {
      case "path-exists":
        if (readPath(state, String(args.path)) === null) {
          issues.push({ code: "precondition-path", message: String(args.path) });
        }
        break;
      case "actor-has-claim": {
        const actor = state.actors[String(args.actorId)];
        if (!actor?.epistemicState.accessibleClaimIds.includes(String(args.claimId))) {
          issues.push({ code: "precondition-claim", message: String(args.claimId) });
        }
        break;
      }
      case "organization-role-has-claim": {
        const organization = state.organizations[String(args.organizationId)];
        const claims = organization?.recordsByRole[String(args.role)] ?? [];
        if (!claims.includes(String(args.claimId))) {
          issues.push({ code: "precondition-organization-claim", message: String(args.claimId) });
        }
        break;
      }
      case "grain-at-least": {
        const stock = state.grainStocks[String(args.stockId)];
        const available = stock ? stock.physicalQuantity - stock.reservedQuantity : 0;
        if (available < Number(args.quantity)) {
          issues.push({ code: "precondition-grain", message: String(args.stockId) });
        }
        break;
      }
      default:
        issues.push({ code: "unknown-precondition", message: precondition.kind });
    }
  }
  return issues;
}

const preconditionValidator: ProposalValidator<Proof00WorldState> = {
  ...PRECONDITION_VALIDATOR,
  validate: preconditionMatches,
};

function footprint(
  proposal: TransitionProposal,
  state: Proof00WorldState,
): StatePath[] {
  const action = actionOf(proposal);
  switch (action.kind) {
    case "set-route-state":
      return [paths.route(action.routeId)];
    case "create-claim":
      return [paths.claim(action.claim.id)];
    case "start-movement":
      return [paths.movement(action.movement.id), paths.actorLocation(action.movement.moverId)];
    case "complete-movement": {
      const moverId = state.movements[action.movementId]?.moverId ?? proposal.subjects[0]!;
      return [paths.movement(action.movementId), paths.actorLocation(moverId)];
    }
    case "deliver-claim":
      return action.recipientType === "actor"
        ? [paths.claim(action.claimId), paths.actorEpistemic(action.recipientId)]
        : [paths.organizationRecords(action.recipientId, action.role!)];
    case "emit-decision-trigger":
      return [paths.trigger(action.trigger.id)];
    case "record-actor-position":
      return [paths.actorPosition(action.position.id), paths.actor(action.position.actorId)];
    case "record-organization-decision":
      return [paths.organizationDecision(action.organizationId, action.decision.id)];
    case "reserve-grain":
      return [paths.grain(action.reservation.stockId), paths.reservation(action.reservation.id)];
    case "request-grain":
      return [
        paths.grain(action.allocation.stockId),
        paths.allocation(action.allocation.id),
        paths.actor(action.allocation.requesterId),
      ];
  }
  return [];
}

function applyAction(
  proposal: TransitionProposal,
  state: Proof00WorldState,
): StateChange[] {
  const action = actionOf(proposal);
  const draft = mutable(state);
  switch (action.kind) {
    case "set-route-state": {
      const route = structuredClone(state.routes[action.routeId]!);
      const segmentIndex = route.segments.findIndex((segment) => segment.id === action.segmentId);
      const segments = [...route.segments];
      segments[segmentIndex] = {
        ...segments[segmentIndex]!,
        status: action.status,
        delayMinutes: action.delayMinutes,
      };
      mutable(route).segments = segments;
      mutable(route).revision += 1;
      mutable(draft.routes)[route.id] = route;
      return [{ operation: "set", path: paths.route(route.id), value: route }];
    }
    case "create-claim":
      mutable(draft.claims)[action.claim.id] = structuredClone(action.claim);
      return [{ operation: "set", path: paths.claim(action.claim.id), value: action.claim }];
    case "start-movement": {
      mutable(draft.movements)[action.movement.id] = structuredClone(action.movement);
      const actor = structuredClone(state.actors[action.movement.moverId]!);
      mutable(actor).location = { kind: "in-transit", movementId: action.movement.id };
      mutable(actor).revision += 1;
      mutable(draft.actors)[actor.id] = actor;
      return [
        { operation: "set", path: paths.movement(action.movement.id), value: action.movement },
        { operation: "set", path: paths.actorLocation(actor.id), value: actor.location },
      ];
    }
    case "complete-movement": {
      const movement = structuredClone(state.movements[action.movementId]!);
      mutable(movement).status = "arrived";
      mutable(movement).arrivedAt = proposal.instant;
      mutable(movement).revision += 1;
      mutable(draft.movements)[movement.id] = movement;
      const actor = structuredClone(state.actors[movement.moverId]!);
      mutable(actor).location = { kind: "at-place", placeId: movement.destination };
      mutable(actor).revision += 1;
      mutable(draft.actors)[actor.id] = actor;
      return [
        { operation: "set", path: paths.movement(movement.id), value: movement },
        { operation: "set", path: paths.actorLocation(actor.id), value: actor.location },
      ];
    }
    case "deliver-claim": {
      if (action.recipientType === "actor") {
        const actor = structuredClone(state.actors[action.recipientId]!);
        const claims = new Set(actor.epistemicState.accessibleClaimIds);
        claims.add(action.claimId);
        mutable(actor).epistemicState = {
          ...actor.epistemicState,
          accessibleClaimIds: [...claims].sort(),
        };
        mutable(actor).revision += 1;
        mutable(draft.actors)[actor.id] = actor;
        const claim = structuredClone(state.claims[action.claimId]!);
        mutable(claim).receivedBy = { ...claim.receivedBy, [actor.id]: proposal.instant };
        mutable(claim).revision += 1;
        mutable(draft.claims)[claim.id] = claim;
        return [
          { operation: "set", path: paths.actorEpistemic(actor.id), value: actor.epistemicState },
          { operation: "set", path: paths.claim(claim.id), value: claim },
        ];
      }
      const organization = structuredClone(state.organizations[action.recipientId]!);
      const records = new Set(organization.recordsByRole[action.role!] ?? []);
      records.add(action.claimId);
      mutable(organization).recordsByRole = {
        ...organization.recordsByRole,
        [action.role!]: [...records].sort(),
      };
      mutable(organization).revision += 1;
      mutable(draft.organizations)[organization.id] = organization;
      return [{
        operation: "set",
        path: paths.organizationRecords(organization.id, action.role!),
        value: [...records].sort(),
      }];
    }
    case "emit-decision-trigger":
      mutable(draft.decisionTriggers)[action.trigger.id] = structuredClone(action.trigger);
      return [{ operation: "set", path: paths.trigger(action.trigger.id), value: action.trigger }];
    case "record-actor-position": {
      mutable(draft.actorPositions)[action.position.id] = structuredClone(action.position);
      const actor = structuredClone(state.actors[action.position.actorId]!);
      mutable(actor).currentPosition = action.position.action.kind;
      mutable(actor).decisionHistory = [...actor.decisionHistory, action.position.id];
      mutable(actor).revision += 1;
      mutable(draft.actors)[actor.id] = actor;
      return [
        { operation: "set", path: paths.actorPosition(action.position.id), value: action.position },
        { operation: "set", path: paths.actor(actor.id), value: actor },
      ];
    }
    case "record-organization-decision": {
      const organization = structuredClone(state.organizations[action.organizationId]!);
      mutable(organization).decisions = {
        ...organization.decisions,
        [action.decision.id]: structuredClone(action.decision),
      };
      mutable(organization).revision += 1;
      mutable(draft.organizations)[organization.id] = organization;
      return [{
        operation: "set",
        path: paths.organizationDecision(organization.id, action.decision.id),
        value: action.decision,
      }];
    }
    case "reserve-grain": {
      const reservation = structuredClone(action.reservation);
      const stock = structuredClone(state.grainStocks[reservation.stockId]!);
      mutable(stock).reservedQuantity += reservation.quantity;
      mutable(stock).revision += 1;
      mutable(draft.grainStocks)[stock.id] = stock;
      mutable(draft.grainReservations)[reservation.id] = reservation;
      return [
        { operation: "set", path: paths.grain(stock.id), value: stock },
        { operation: "set", path: paths.reservation(reservation.id), value: reservation },
      ];
    }
    case "request-grain": {
      const allocation = structuredClone(action.allocation);
      mutable(allocation).grantedQuantity = allocation.requestedQuantity;
      mutable(allocation).status = "fulfilled";
      mutable(allocation).revision += 1;
      const stock = structuredClone(state.grainStocks[allocation.stockId]!);
      mutable(stock).physicalQuantity -= allocation.grantedQuantity;
      mutable(stock).revision += 1;
      const actor = structuredClone(state.actors[allocation.requesterId]!);
      mutable(actor).grainHolding += allocation.grantedQuantity;
      mutable(actor).revision += 1;
      mutable(draft.grainStocks)[stock.id] = stock;
      mutable(draft.grainAllocations)[allocation.id] = allocation;
      mutable(draft.actors)[actor.id] = actor;
      return [
        { operation: "set", path: paths.grain(stock.id), value: stock },
        { operation: "set", path: paths.allocation(allocation.id), value: allocation },
        { operation: "set", path: paths.actor(actor.id), value: actor },
      ];
    }
  }
  throw new Error(`Unsupported Proof 00 action: ${String((action as { kind?: unknown }).kind)}`);
}

function mechanism(
  id: keyof typeof mechanismVersions,
  capabilities: readonly string[],
  actionKinds: readonly Proof00Action["kind"][],
): MechanismRegistration<Proof00WorldState> {
  return {
    id,
    version: mechanismVersions[id],
    capabilities,
    actionKinds,
    requiredValidators: [ACTION_VALIDATOR, PRECONDITION_VALIDATOR],
    footprint,
    apply: applyAction,
  };
}

class GrainResolver implements CoordinationResolver<Proof00WorldState> {
  readonly id = GRAIN_RESOLVER.id;
  readonly version = GRAIN_RESOLVER.version;
  readonly #seed: string;

  constructor(seed: string) {
    this.#seed = seed;
  }

  resolve(
    proposals: readonly TransitionProposal[],
    state: Proof00WorldState,
  ) {
    const sorted = [...proposals].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    const grainActions = sorted.map((proposal) => ({ proposal, action: actionOf(proposal) }));
    const firstGrainAction = grainActions.find(({ action }) =>
      action.kind === "request-grain" || action.kind === "reserve-grain"
    )?.action;
    if (!firstGrainAction || (firstGrainAction.kind !== "request-grain" && firstGrainAction.kind !== "reserve-grain")) {
      return {
        acceptedProposalIds: [],
        rejected: Object.fromEntries(sorted.map((proposal) => [proposal.id, "unsupported-coordination-set"])),
        randomDraws: [] as RecordedRandomDraw[],
        summary: "grain-resolver-rejected-non-request",
      };
    }
    const stockId = firstGrainAction.kind === "request-grain"
      ? firstGrainAction.allocation.stockId
      : firstGrainAction.reservation.stockId;
    const stock = state.grainStocks[stockId]!;
    let available = stock.physicalQuantity - stock.reservedQuantity;
    const draw = stableRandom({
      seed: this.#seed,
      mechanismId: this.id,
      mechanismVersion: this.version,
      causalInstanceId: `grain-requests:${stockId}:t${sorted[0]!.instant.worldTime}`,
      purpose: "fair-request-order",
      drawIndex: 0,
    });
    const reservations = grainActions
      .filter(({ action }) => action.kind === "reserve-grain")
      .map(({ proposal }) => proposal)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const requests = grainActions
      .filter(({ action }) => action.kind === "request-grain")
      .map(({ proposal }) => proposal)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const start = requests.length === 0 ? 0 : Math.floor(draw.unitInterval * requests.length);
    const ordered = [
      ...reservations,
      ...requests.slice(start),
      ...requests.slice(0, start),
    ];
    const accepted: string[] = [];
    const rejected: Record<string, string> = {};
    for (const proposal of ordered) {
      const action = actionOf(proposal);
      const quantity = action.kind === "reserve-grain"
        ? action.reservation.quantity
        : action.kind === "request-grain"
          ? action.allocation.requestedQuantity
          : undefined;
      const actionStockId = action.kind === "reserve-grain"
        ? action.reservation.stockId
        : action.kind === "request-grain"
          ? action.allocation.stockId
          : undefined;
      if (quantity === undefined || actionStockId !== stockId) {
        rejected[proposal.id] = "mixed-resource-coordination-set";
        continue;
      }
      if (quantity <= available) {
        accepted.push(proposal.id);
        available -= quantity;
      } else {
        rejected[proposal.id] = "insufficient-unreserved-grain";
      }
    }
    return {
      acceptedProposalIds: accepted,
      rejected,
      randomDraws: [draw],
      summary: `organization-priority-then-fair-request-resolution:${accepted.join("|") || "none"}`,
    };
  }
}

export function registerProof00Domain(
  kernel: Kernel<Proof00WorldState>,
  seed: string,
  reverseRegistration = false,
): Kernel<Proof00WorldState> {
  const registrations = [
    mechanism("weather", ["set-route-state"], ["set-route-state"]),
    mechanism("information", ["create-claim", "deliver-claim"], ["create-claim", "deliver-claim"]),
    mechanism("movement", ["start-movement", "complete-movement"], ["start-movement", "complete-movement"]),
    mechanism("decision-trigger", ["emit-decision-trigger"], ["emit-decision-trigger"]),
    mechanism("actor-decision", ["record-actor-position"], ["record-actor-position"]),
    mechanism("organization", ["record-organization-decision"], ["record-organization-decision"]),
    mechanism("grain", ["reserve-grain", "request-grain"], ["reserve-grain", "request-grain"]),
  ];
  for (const registration of reverseRegistration ? registrations.reverse() : registrations) {
    kernel.registerMechanism(registration);
  }
  kernel.registerValidator(actionValidator);
  kernel.registerValidator(preconditionValidator);
  kernel.registerResolver(new GrainResolver(seed));
  return kernel;
}

export function nextInstant(worldTime: number, causalPhase: number): LogicalInstant {
  return { worldTime, causalPhase };
}

export function claimReceivedByActor(
  state: Proof00WorldState,
  claimId: string,
  actorId: string,
): boolean {
  return Boolean(state.claims[claimId]?.receivedBy[actorId]);
}

export function availableGrain(state: Proof00WorldState, stockId: string): number {
  const stock = state.grainStocks[stockId]!;
  return stock.physicalQuantity - stock.reservedQuantity;
}

export function allocationFor(
  state: Proof00WorldState,
  requesterId: string,
): GrainAllocationState | undefined {
  return Object.values(state.grainAllocations).find(
    (allocation) => allocation.requesterId === requesterId,
  );
}

export type {
  Proof00ActorState,
  Proof00ClaimState,
  Proof00MovementState,
  Proof00OrganizationState,
};
