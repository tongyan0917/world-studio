/*
 * Domain-agnostic kernel contracts.
 *
 * Keep this section free of Proof 00 semantics. These values cross artifact
 * boundaries, so the contracts deliberately contain data rather than
 * callbacks or executable predicates.
 */

export type Hash = string;
export type EntityId = string;
export type ProposalId = string;
export type TraceNodeId = string;
export type TransitionId = string;
export type MechanismId = string;
export type StatePath = string;
export type WorldTime = number;

export interface LogicalInstant {
  readonly worldTime: WorldTime;
  readonly causalPhase: number;
}

export interface VersionedRead {
  readonly path: StatePath;
  readonly revision: number;
  readonly valueHash: Hash;
  readonly producerTraceId?: TraceNodeId;
}

/** Concrete causal meaning attached to one canonical state path. */
export interface CausalPathDimensionBinding {
  readonly path: StatePath;
  readonly dimensions: readonly string[];
}

export interface AuthorityClaim {
  readonly kind:
    | "world-rule"
    | "boundary"
    | "mechanism"
    | "actor"
    | "organization"
    | "author-intervention";
  readonly principalId: EntityId;
  readonly capability: string;
}

export interface ProposalPrecondition {
  readonly id: string;
  readonly kind: string;
  readonly paths: readonly StatePath[];
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface EffectScope {
  readonly paths: readonly StatePath[];
  readonly entityIds: readonly EntityId[];
}

export interface ResourceClaim {
  readonly resourceType: string;
  readonly resourceId: EntityId;
  readonly mode: "read" | "reserve" | "consume" | "produce" | "transfer";
  readonly quantity: number;
  readonly unit: string;
}

export interface PermissionClaim {
  readonly capability: string;
  readonly subjectId: EntityId;
  readonly objectId: EntityId;
}

export interface ValidatorRef {
  readonly id: string;
  readonly version: string;
}

export interface TransitionProposal<Action = unknown> {
  readonly id: ProposalId;
  readonly source: MechanismId;
  readonly version: string;
  readonly authority: AuthorityClaim;
  readonly subjects: readonly EntityId[];
  readonly instant: LogicalInstant;
  readonly causalParents: readonly TraceNodeId[];
  readonly readSet: readonly VersionedRead[];
  readonly causalPathDimensions?: {
    readonly reads: readonly CausalPathDimensionBinding[];
    readonly writes: readonly CausalPathDimensionBinding[];
  };
  readonly preconditions: readonly ProposalPrecondition[];
  readonly effectScope: EffectScope;
  readonly resourceClaims: readonly ResourceClaim[];
  readonly permissionClaims: readonly PermissionClaim[];
  readonly validators: readonly ValidatorRef[];
  readonly resolution?: ValidatorRef;
  readonly action: Action;
}

export interface StateChange {
  readonly operation: "set" | "delete" | "increment";
  readonly path: StatePath;
  readonly value?: unknown;
  readonly causalDimensions?: readonly string[];
}

export type ProposalDispositionKind =
  | "accepted"
  | "rejected"
  | "stale"
  | "incomplete";

export interface ProposalDisposition {
  readonly proposalId: ProposalId;
  readonly kind: ProposalDispositionKind;
  readonly reasonCode?: string;
  readonly evidence: readonly TraceNodeId[];
}

export interface CommittedTransition<Action = unknown> {
  readonly id: TransitionId;
  readonly instant: LogicalInstant;
  readonly proposalIds: readonly ProposalId[];
  readonly causalParents: readonly TraceNodeId[];
  readonly resolvedAction: Action;
  readonly changes: readonly StateChange[];
  readonly causalPathDimensions?: {
    readonly reads: readonly CausalPathDimensionBinding[];
    readonly writes: readonly CausalPathDimensionBinding[];
  };
  readonly dispositions: readonly ProposalDisposition[];
  readonly beforeStateHash: Hash;
  readonly afterStateHash: Hash;
}

export interface TraceNode<Payload = unknown> {
  readonly id: TraceNodeId;
  readonly kind: string;
  readonly instant: LogicalInstant;
  readonly causalParents: readonly TraceNodeId[];
  readonly subjects: readonly EntityId[];
  readonly permittedAudience: readonly EntityId[] | "audit";
  readonly payload: Payload;
  readonly payloadHash: Hash;
}

export interface StableRandomKey {
  readonly seed: string;
  readonly mechanismId: MechanismId;
  readonly mechanismVersion: string;
  readonly causalInstanceId: string;
  readonly purpose: string;
  readonly drawIndex: number;
}

export interface RecordedRandomDraw {
  readonly key: StableRandomKey;
  readonly keyHash: Hash;
  readonly unitInterval: number;
}

export interface DecisionTrigger {
  readonly id: string;
  readonly source: MechanismId;
  readonly version: string;
  readonly actorId: EntityId;
  readonly instant: LogicalInstant;
  readonly causalParents: readonly TraceNodeId[];
  readonly reason: string;
  readonly requestedAuthority: string;
  readonly allowedActionKinds: readonly string[];
  readonly deadline?: LogicalInstant;
}

export interface EpistemicSnapshot {
  readonly observationIds: readonly EntityId[];
  readonly accessibleClaimIds: readonly EntityId[];
  readonly beliefSummaries: Readonly<Record<string, string>>;
}

export interface ActorDecisionContext<PerceivedState = unknown> {
  readonly schemaVersion: string;
  readonly triggerId: string;
  readonly actorId: EntityId;
  readonly instant: LogicalInstant;
  readonly epistemicState: EpistemicSnapshot;
  readonly perceivedState: PerceivedState;
  readonly availableRoles: readonly string[];
  readonly allowedActionKinds: readonly string[];
  readonly evidenceRefs: readonly EntityId[];
  readonly contextHash: Hash;
}

export interface CandidateAction<Action = unknown> {
  readonly id: string;
  readonly action: Action;
  readonly subjectiveReason: string;
  readonly expectedConsequence: string;
  readonly perceivedRisk: string;
  readonly informationBasis: readonly EntityId[];
}

export interface CandidateActionSet<Action = unknown> {
  readonly schemaVersion: string;
  readonly triggerId: string;
  readonly actorId: EntityId;
  readonly candidates: readonly CandidateAction<Action>[];
  readonly preferredCandidateId: string;
}

export interface ActorProposerContribution<Action = unknown> {
  readonly requestHash: Hash;
  readonly context: ActorDecisionContext;
  readonly result: CandidateActionSet<Action>;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly schemaVersion: string;
  readonly attemptCount: number;
  readonly promptVersion?: string;
  readonly sampling?: Readonly<Record<string, number | string | boolean>>;
  readonly rawOutput?: string;
  readonly parsedResultHash?: Hash;
  readonly validationIssues?: readonly string[];
  readonly disposition?: "accepted" | "rejected" | "technical-failure";
}

export interface ActorProposerFailureRecord {
  readonly status: "technical-failure";
  readonly disposition: "incomplete";
  readonly triggerId: string;
  readonly actorId: EntityId;
  readonly contextHash: Hash;
  readonly requestHash: Hash;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly schemaVersion: string;
  readonly attemptCount: number;
  readonly errorCode: string;
  readonly attemptErrors: readonly string[];
  readonly fallbackUsed: false;
  readonly externalModelCallCount: 0;
}

export interface AnchorRef {
  readonly parentRunId: string;
  readonly anchorTransitionId: TransitionId;
  readonly prefixTraceHash: Hash;
  readonly inputDeltaHash: Hash;
}

export interface RunManifest {
  readonly runId: string;
  readonly possibleHistoryId: string;
  readonly contractId: string;
  readonly contractVersion: string;
  readonly contractHash: Hash;
  readonly initialStateHash: Hash;
  readonly mechanismVersions: Readonly<Record<MechanismId, string>>;
  readonly schemaVersions: Readonly<Record<string, string>>;
  readonly seed: string;
  readonly horizon: LogicalInstant;
  readonly actorProposerContract: string;
  readonly externalInputs: Readonly<Record<string, unknown>>;
  readonly externalInputsHash: Hash;
  readonly recordedContributionSetHash: Hash;
  readonly anchor?: AnchorRef;
}

export type RunStatus = "complete" | "incomplete" | "invalid";

export interface RunArtifact<State = unknown, Action = unknown> {
  readonly manifest: RunManifest;
  readonly status: RunStatus;
  readonly initialState: State;
  readonly finalState: State;
  readonly transitions: readonly CommittedTransition<Action>[];
  readonly trace: readonly TraceNode[];
  readonly randomDraws: readonly RecordedRandomDraw[];
  readonly actorProposerContributions: readonly ActorProposerContribution[];
  readonly actorProposerFailures: readonly ActorProposerFailureRecord[];
  readonly finalStateHash: Hash;
  readonly traceHash: Hash;
  readonly incompleteAtTriggerId?: string;
}

/*
 * Engine Proof 00 world/domain contracts.
 *
 * These types intentionally remain a thin fixture over the generic kernel.
 * They are not a claim that every future World uses grain, roads, councils,
 * or this organizational procedure.
 */

export type PlaceId = EntityId;
export type RouteId = EntityId;
export type ActorId = EntityId;
export type OrganizationId = EntityId;
export type ClaimId = EntityId;
export type MovementId = EntityId;
export type GrainStockId = EntityId;

export type ActorLocation =
  | { readonly kind: "at-place"; readonly placeId: PlaceId }
  | { readonly kind: "in-transit"; readonly movementId: MovementId };

export interface Proof00ActorState {
  readonly id: ActorId;
  readonly name: string;
  readonly revision: number;
  readonly location: ActorLocation;
  readonly organizationRoles: Readonly<Record<OrganizationId, readonly string[]>>;
  readonly epistemicState: EpistemicSnapshot;
  readonly grainHolding: number;
  readonly currentPosition?: string;
  readonly decisionHistory: readonly EntityId[];
}

export interface ActorPositionState {
  readonly id: EntityId;
  readonly actorId: ActorId;
  readonly triggerId: EntityId;
  readonly action: Proof00ActorAction;
  readonly decidedAt: LogicalInstant;
  readonly evidenceRefs: readonly ClaimId[];
  readonly contributionHash: Hash;
}

export interface OrganizationDecisionState {
  readonly id: EntityId;
  readonly issue: string;
  readonly status: "open" | "adopted" | "rejected" | "blocked";
  readonly decidedAt?: LogicalInstant;
  readonly authorityActorId?: ActorId;
  readonly orderId?: EntityId;
  readonly stockId?: GrainStockId;
  readonly quantity?: number;
  readonly supportingPositionId?: EntityId;
  readonly causalParents: readonly TraceNodeId[];
}

export interface Proof00OrganizationState {
  readonly id: OrganizationId;
  readonly name: string;
  readonly revision: number;
  readonly placeId: PlaceId;
  readonly memberRoles: Readonly<Record<ActorId, readonly string[]>>;
  readonly recordsByRole: Readonly<Record<string, readonly ClaimId[]>>;
  readonly procedureId: string;
  readonly decisions: Readonly<Record<EntityId, OrganizationDecisionState>>;
}

export interface Proof00PlaceState {
  readonly id: PlaceId;
  readonly name: string;
  readonly revision: number;
}

export interface RouteSegmentState {
  readonly id: EntityId;
  readonly from: PlaceId;
  readonly to: PlaceId;
  readonly baseDurationMinutes: number;
  readonly delayMinutes: number;
  readonly status: "open" | "delayed" | "blocked";
  readonly capacity: number;
}

export interface Proof00RouteState {
  readonly id: RouteId;
  readonly name: string;
  readonly revision: number;
  readonly placePath: readonly PlaceId[];
  readonly segments: readonly RouteSegmentState[];
}

export interface Proof00MovementState {
  readonly id: MovementId;
  readonly revision: number;
  readonly moverId: ActorId;
  readonly cargoIds: readonly EntityId[];
  readonly routeId: RouteId;
  readonly origin: PlaceId;
  readonly destination: PlaceId;
  readonly startedAt: LogicalInstant;
  readonly earliestArrival: LogicalInstant;
  readonly currentSegmentIndex: number;
  readonly status: "planned" | "in-progress" | "blocked" | "arrived" | "failed";
  readonly arrivedAt?: LogicalInstant;
}

export interface Proof00ClaimState {
  readonly id: ClaimId;
  readonly revision: number;
  readonly proposition: string;
  readonly kind: "official-report" | "rumor" | "organization-order";
  readonly sourceActorId: ActorId;
  readonly formedAt: LogicalInstant;
  readonly provenance: readonly TraceNodeId[];
  readonly recipientActorIds: readonly ActorId[];
  readonly receivedBy: Readonly<Record<ActorId, LogicalInstant>>;
  readonly derivedFrom?: ClaimId;
  readonly transformation?: string;
}

export interface GrainStockState {
  readonly id: GrainStockId;
  readonly revision: number;
  readonly placeId: PlaceId;
  readonly unit: "sack";
  readonly openingQuantity: number;
  readonly physicalQuantity: number;
  readonly reservedQuantity: number;
}

export interface GrainReservationState {
  readonly id: EntityId;
  readonly revision: number;
  readonly stockId: GrainStockId;
  readonly quantity: number;
  readonly holderId: EntityId;
  readonly organizationId: OrganizationId;
  readonly decisionId: EntityId;
  readonly orderClaimId: ClaimId;
  readonly status: "active" | "released" | "fulfilled" | "rejected";
  readonly causalParents: readonly TraceNodeId[];
}

export interface GrainAllocationState {
  readonly id: EntityId;
  readonly revision: number;
  readonly stockId: GrainStockId;
  readonly requesterId: ActorId;
  readonly requestedQuantity: number;
  readonly grantedQuantity: number;
  readonly status: "pending" | "partial" | "fulfilled" | "rejected";
  readonly causalParents: readonly TraceNodeId[];
}

export interface Proof00WorldState {
  readonly contractId: string;
  readonly contractVersion: string;
  readonly revision: number;
  readonly instant: LogicalInstant;
  readonly actors: Readonly<Record<ActorId, Proof00ActorState>>;
  readonly organizations: Readonly<Record<OrganizationId, Proof00OrganizationState>>;
  readonly places: Readonly<Record<PlaceId, Proof00PlaceState>>;
  readonly routes: Readonly<Record<RouteId, Proof00RouteState>>;
  readonly movements: Readonly<Record<MovementId, Proof00MovementState>>;
  readonly claims: Readonly<Record<ClaimId, Proof00ClaimState>>;
  readonly decisionTriggers: Readonly<Record<EntityId, DecisionTrigger>>;
  readonly actorPositions: Readonly<Record<EntityId, ActorPositionState>>;
  readonly grainStocks: Readonly<Record<GrainStockId, GrainStockState>>;
  readonly grainReservations: Readonly<Record<EntityId, GrainReservationState>>;
  readonly grainAllocations: Readonly<Record<EntityId, GrainAllocationState>>;
}

export type Proof00ActorAction =
  | {
      readonly kind: "recommend-grain-reserve";
      readonly organizationId: OrganizationId;
      readonly stockId: GrainStockId;
      readonly quantity: number;
    }
  | {
      readonly kind: "request-verification";
      readonly organizationId: OrganizationId;
      readonly claimId: ClaimId;
    }
  | {
      readonly kind: "take-no-emergency-action";
      readonly organizationId: OrganizationId;
    };

export type Proof00Action =
  | {
      readonly kind: "set-route-state";
      readonly routeId: RouteId;
      readonly segmentId: EntityId;
      readonly status: RouteSegmentState["status"];
      readonly delayMinutes: number;
    }
  | { readonly kind: "create-claim"; readonly claim: Proof00ClaimState }
  | { readonly kind: "start-movement"; readonly movement: Proof00MovementState }
  | { readonly kind: "complete-movement"; readonly movementId: MovementId }
  | {
      readonly kind: "deliver-claim";
      readonly claimId: ClaimId;
      readonly recipientType: "actor" | "organization-role";
      readonly recipientId: EntityId;
      readonly role?: string;
      readonly channel: "in-person" | "gossip";
      readonly carrierId?: ActorId;
    }
  | { readonly kind: "emit-decision-trigger"; readonly trigger: DecisionTrigger }
  | { readonly kind: "record-actor-position"; readonly position: ActorPositionState }
  | {
      readonly kind: "record-organization-decision";
      readonly organizationId: OrganizationId;
      readonly decision: OrganizationDecisionState;
    }
  | { readonly kind: "reserve-grain"; readonly reservation: GrainReservationState }
  | { readonly kind: "request-grain"; readonly allocation: GrainAllocationState };

export interface Proof00WorldContract {
  readonly id: string;
  readonly version: string;
  readonly horizon: LogicalInstant;
  readonly mechanismVersions: Readonly<Record<MechanismId, string>>;
  readonly actorActionKinds: readonly Proof00ActorAction["kind"][];
  readonly grainUnit: "sack";
  readonly grainPrecision: number;
}
