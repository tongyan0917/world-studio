import { Kernel, type KernelCheckpoint } from "../kernel/kernel.ts";
import { hash } from "../kernel/stable.ts";
import type {
  ActorDecisionContext,
  ActorProposerContribution,
  CandidateActionSet,
  CommittedTransition,
  LogicalInstant,
  Proof00Action,
  Proof00ActorAction,
  Proof00ClaimState,
  Proof00WorldState,
  ProposalDisposition,
  ProposalPrecondition,
  RecordedRandomDraw,
  ResourceClaim,
  RunArtifact,
  RunManifest,
  TraceNode,
  TransitionProposal,
} from "../kernel/types.ts";
import {
  ACTION_VALIDATOR,
  GRAIN_RESOLVER,
  PRECONDITION_VALIDATOR,
  mechanismVersions,
  nextInstant,
  paths,
  proof00StateAdapter,
  registerProof00Domain,
} from "./domain.ts";
import {
  ids,
  proof00Contract,
  proof00ContractHash,
  proof00InitialStateHash,
  proof00SchemaVersions,
  createInitialState,
  time,
} from "./fixture.ts";
import {
  CANDIDATE_ACTION_SET_SCHEMA_VERSION,
  FailingActorProposer,
  RecordedActorProposer,
  recordActorProposerContribution,
  sealActorDecisionContext,
  type RecordedActorProposerContribution,
  type ActorProposerTechnicalFailure,
} from "./proposer.ts";

export type Proof00Variant = "base" | "anchored";

export interface Proof00RunOptions {
  readonly variant: Proof00Variant;
  readonly seed?: string;
  readonly reverseRegistration?: boolean;
  readonly replayContribution?: RecordedActorProposerContribution<Proof00ActorAction>;
  readonly simulateActorProposerFailure?: boolean;
}

export interface Proof00RunResult {
  readonly artifact: RunArtifact<Proof00WorldState, Proof00Action>;
  readonly reportDelayMinutes: number;
  readonly reportArrival: number;
  readonly orderArrival?: number;
  readonly requestDispositions?: readonly ProposalDisposition[];
  readonly reservationDisposition?: ProposalDisposition;
  readonly externalModelCallCount: number;
}

export interface Proof00PairResult {
  readonly base: Proof00RunResult;
  readonly anchored: Proof00RunResult;
}

interface CommonPrefix {
  readonly initialState: Proof00WorldState;
  readonly checkpoint: KernelCheckpoint<Proof00WorldState>;
  readonly blockTraceId: string;
  readonly officialAccessTraceId: string;
  readonly prefixTraceHash: string;
  readonly anchorTransitionId: string;
}

interface ProposalArguments {
  readonly id: string;
  readonly source: keyof typeof mechanismVersions;
  readonly instant: LogicalInstant;
  readonly subjects: readonly string[];
  readonly causalParents: readonly string[];
  readonly readPaths: readonly string[];
  readonly effectPaths: readonly string[];
  readonly action: Proof00Action;
  readonly preconditions?: readonly ProposalPrecondition[];
  readonly resourceClaims?: readonly ResourceClaim[];
  readonly resolution?: typeof GRAIN_RESOLVER;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function authorityFor(args: ProposalArguments) {
  if (args.action.kind === "set-route-state") {
    return { kind: "world-rule" as const, principalId: proof00Contract.id };
  }
  if (args.action.kind === "record-actor-position") {
    return { kind: "actor" as const, principalId: args.action.position.actorId };
  }
  if (args.action.kind === "record-organization-decision") {
    return { kind: "organization" as const, principalId: args.action.organizationId };
  }
  if (args.action.kind === "reserve-grain") {
    return { kind: "organization" as const, principalId: args.action.reservation.organizationId };
  }
  if (args.action.kind === "request-grain") {
    return { kind: "actor" as const, principalId: args.action.allocation.requesterId };
  }
  return { kind: "mechanism" as const, principalId: args.source };
}

export function makeProposal(
  kernel: Kernel<Proof00WorldState>,
  args: ProposalArguments,
): TransitionProposal<Proof00Action> {
  const authority = authorityFor(args);
  const capability = args.action.kind;
  const subjects = uniqueSorted(args.subjects);
  const readPaths = uniqueSorted(args.readPaths);
  const readSet = readPaths.map((path) => kernel.read(path));
  const causalParents = uniqueSorted([
    ...args.causalParents,
    ...readSet.flatMap((read) => read.producerTraceId ? [read.producerTraceId] : []),
  ]);
  return deepFreeze({
    id: args.id,
    source: args.source,
    version: mechanismVersions[args.source],
    authority: { ...authority, capability },
    subjects,
    instant: args.instant,
    causalParents,
    readSet,
    preconditions: args.preconditions ?? [],
    effectScope: {
      paths: uniqueSorted(args.effectPaths),
      entityIds: subjects,
    },
    resourceClaims: args.resourceClaims ?? [],
    permissionClaims: [{
      capability,
      subjectId: authority.principalId,
      objectId: subjects[0] ?? authority.principalId,
    }],
    validators: [ACTION_VALIDATOR, PRECONDITION_VALIDATOR],
    ...(args.resolution ? { resolution: args.resolution } : {}),
    action: args.action,
  });
}

function traceForProposal(
  traceNodes: readonly TraceNode[],
  proposalId: string,
): TraceNode | undefined {
  return traceNodes.find((node) =>
    node.kind === "proposal-disposition" &&
    (node.payload as { proposalId?: string }).proposalId === proposalId
  );
}

function commitRequired(
  kernel: Kernel<Proof00WorldState>,
  proposal: TransitionProposal<Proof00Action>,
): string {
  const result = kernel.commitPhase(proposal.instant, [proposal]);
  const disposition = result.dispositions.find((entry) => entry.proposalId === proposal.id);
  if (disposition?.kind !== "accepted") {
    throw new Error(`Required proposal ${proposal.id} was ${disposition?.kind}: ${disposition?.reasonCode}`);
  }
  const transitionNode = result.traceNodes.find((node) => node.kind === "committed-transition");
  if (!transitionNode) throw new Error(`Required proposal ${proposal.id} produced no transition trace`);
  return transitionNode.id;
}

function commitObserved(
  kernel: Kernel<Proof00WorldState>,
  proposal: TransitionProposal<Proof00Action>,
): { readonly disposition: ProposalDisposition; readonly traceNodeId: string } {
  const result = kernel.commitPhase(proposal.instant, [proposal]);
  const disposition = result.dispositions.find((entry) => entry.proposalId === proposal.id);
  const proposalNode = traceForProposal(result.traceNodes, proposal.id);
  if (!disposition || !proposalNode) throw new Error(`Proposal ${proposal.id} produced no disposition`);
  return { disposition, traceNodeId: proposalNode.id };
}

function createOfficialClaim(instant: LogicalInstant, provenance: readonly string[]): Proof00ClaimState {
  return {
    id: ids.officialClaim,
    revision: 0,
    proposition: "The northern supply road is blocked by the storm; scheduled grain carts cannot pass.",
    kind: "official-report",
    sourceActorId: ids.clerk,
    formedAt: instant,
    provenance,
    recipientActorIds: [ids.clerk, ids.chair],
    receivedBy: {},
  };
}

function buildCommonPrefix(seed: string, reverseRegistration: boolean): CommonPrefix {
  const initialState = createInitialState();
  const kernel = registerProof00Domain(
    new Kernel(initialState, proof00StateAdapter),
    seed,
    reverseRegistration,
  );

  const blockInstant = nextInstant(0, 0);
  const blockTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:storm-blocks-supply-route",
    source: "weather",
    instant: blockInstant,
    subjects: [ids.supplyRoute],
    causalParents: [],
    readPaths: [paths.route(ids.supplyRoute)],
    effectPaths: [paths.route(ids.supplyRoute)],
    action: {
      kind: "set-route-state",
      routeId: ids.supplyRoute,
      segmentId: ids.supplySegment,
      status: "blocked",
      delayMinutes: 0,
    },
  }));

  const claimInstant = nextInstant(0, 1);
  const claimTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:clerk-forms-official-report",
    source: "information",
    instant: claimInstant,
    subjects: [ids.officialClaim, ids.clerk],
    causalParents: [blockTraceId],
    readPaths: [paths.claim(ids.officialClaim), paths.actor(ids.clerk)],
    effectPaths: [paths.claim(ids.officialClaim)],
    action: { kind: "create-claim", claim: createOfficialClaim(claimInstant, [blockTraceId]) },
  }));

  const selfDeliveryInstant = nextInstant(0, 2);
  const officialAccessTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:clerk-receives-own-observation",
    source: "information",
    instant: selfDeliveryInstant,
    subjects: [ids.officialClaim, ids.clerk],
    causalParents: [claimTraceId],
    readPaths: [paths.claim(ids.officialClaim), paths.actorLocation(ids.clerk), paths.actorEpistemic(ids.clerk)],
    effectPaths: [paths.claim(ids.officialClaim), paths.actorEpistemic(ids.clerk)],
    action: {
      kind: "deliver-claim",
      claimId: ids.officialClaim,
      recipientType: "actor",
      recipientId: ids.clerk,
      channel: "in-person",
      carrierId: ids.clerk,
    },
  }));

  const checkpoint = kernel.checkpoint();
  const anchorTransitionId = checkpoint.transitions.at(-1)?.id;
  if (!anchorTransitionId) throw new Error("Common prefix contains no anchor transition");
  return {
    initialState,
    checkpoint,
    blockTraceId,
    officialAccessTraceId,
    prefixTraceHash: hash(checkpoint.trace),
    anchorTransitionId,
  };
}

function createBranchKernel(
  common: CommonPrefix,
  seed: string,
  reverseRegistration: boolean,
): Kernel<Proof00WorldState> {
  return registerProof00Domain(
    Kernel.fromCheckpoint(common.checkpoint, proof00StateAdapter),
    seed,
    reverseRegistration,
  );
}

function startReportJourney(
  kernel: Kernel<Proof00WorldState>,
  reportDelayMinutes: number,
): { readonly reportArrival: number; readonly reportStartTraceId: string } {
  const inputInstant = nextInstant(0, 3);
  const inputTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:report-route-delay-input",
    source: "weather",
    instant: inputInstant,
    subjects: [ids.reportRoute],
    causalParents: [kernel.trace().at(-1)!.id],
    readPaths: [paths.route(ids.reportRoute)],
    effectPaths: [paths.route(ids.reportRoute)],
    action: {
      kind: "set-route-state",
      routeId: ids.reportRoute,
      segmentId: ids.reportSegment,
      status: reportDelayMinutes > 0 ? "delayed" : "open",
      delayMinutes: reportDelayMinutes,
    },
  }));

  const reportArrival = time.anchoredReportArrival + reportDelayMinutes;
  const startInstant = nextInstant(0, 4);
  const reportStartTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:clerk-starts-report-journey",
    source: "movement",
    instant: startInstant,
    subjects: [ids.clerk, ids.reportMovement],
    causalParents: [inputTraceId],
    readPaths: [
      paths.movement(ids.reportMovement),
      paths.actorLocation(ids.clerk),
      paths.route(ids.reportRoute),
    ],
    effectPaths: [paths.movement(ids.reportMovement), paths.actorLocation(ids.clerk)],
    action: {
      kind: "start-movement",
      movement: {
        id: ids.reportMovement,
        revision: 0,
        moverId: ids.clerk,
        cargoIds: [ids.officialClaim],
        routeId: ids.reportRoute,
        origin: ids.northGate,
        destination: ids.councilHall,
        startedAt: startInstant,
        earliestArrival: nextInstant(reportArrival, 0),
        currentSegmentIndex: 0,
        status: "in-progress",
      },
    },
  }));
  return { reportArrival, reportStartTraceId };
}

function addRumor(
  kernel: Kernel<Proof00WorldState>,
  officialAccessTraceId: string,
): { readonly bakerTraceId: string; readonly innkeeperTraceId: string } {
  const createInstant = nextInstant(time.rumor, 0);
  const rumor: Proof00ClaimState = {
    id: ids.rumorClaim,
    revision: 0,
    proposition: "The northern road is gone and the town will receive no grain for weeks.",
    kind: "rumor",
    sourceActorId: ids.clerk,
    formedAt: createInstant,
    provenance: [officialAccessTraceId],
    recipientActorIds: [ids.innkeeper, ids.baker],
    receivedBy: {},
    derivedFrom: ids.officialClaim,
    transformation: "A gossip chain amplified the clerk's blocked-road report into a weeks-long total shortage.",
  };
  const createTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:distorted-shortage-rumor-forms",
    source: "information",
    instant: createInstant,
    subjects: [ids.rumorClaim, ids.clerk],
    causalParents: [officialAccessTraceId],
    readPaths: [
      paths.claim(ids.rumorClaim),
      paths.claim(ids.officialClaim),
      paths.actor(ids.clerk),
      paths.actorEpistemic(ids.clerk),
    ],
    effectPaths: [paths.claim(ids.rumorClaim)],
    action: { kind: "create-claim", claim: rumor },
  }));

  const innkeeperInstant = nextInstant(time.rumor, 1);
  const innkeeperTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:rumor-reaches-innkeeper",
    source: "information",
    instant: innkeeperInstant,
    subjects: [ids.rumorClaim, ids.innkeeper],
    causalParents: [createTraceId],
    readPaths: [paths.claim(ids.rumorClaim), paths.actorEpistemic(ids.innkeeper)],
    effectPaths: [paths.claim(ids.rumorClaim), paths.actorEpistemic(ids.innkeeper)],
    action: {
      kind: "deliver-claim",
      claimId: ids.rumorClaim,
      recipientType: "actor",
      recipientId: ids.innkeeper,
      channel: "gossip",
    },
  }));

  const bakerInstant = nextInstant(time.rumor, 2);
  const bakerTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:rumor-reaches-baker",
    source: "information",
    instant: bakerInstant,
    subjects: [ids.rumorClaim, ids.baker],
    causalParents: [createTraceId],
    readPaths: [paths.claim(ids.rumorClaim), paths.actorEpistemic(ids.baker)],
    effectPaths: [paths.claim(ids.rumorClaim), paths.actorEpistemic(ids.baker)],
    action: {
      kind: "deliver-claim",
      claimId: ids.rumorClaim,
      recipientType: "actor",
      recipientId: ids.baker,
      channel: "gossip",
    },
  }));
  return { bakerTraceId, innkeeperTraceId };
}

function grainRequestProposals(
  kernel: Kernel<Proof00WorldState>,
  rumorTraces: { readonly bakerTraceId: string; readonly innkeeperTraceId: string },
  instant: LogicalInstant,
): readonly TransitionProposal<Proof00Action>[] {
  const makeRequest = (
    actorId: string,
    allocationId: string,
    causalParent: string,
  ) => makeProposal(kernel, {
    id: `proposal:${allocationId}`,
    source: "grain",
    instant,
    subjects: [actorId, allocationId, ids.grainStock],
    causalParents: [causalParent],
    readPaths: [
      paths.grain(ids.grainStock),
      paths.allocation(allocationId),
      paths.actor(actorId),
      paths.actorEpistemic(actorId),
    ],
    effectPaths: [paths.grain(ids.grainStock), paths.allocation(allocationId), paths.actor(actorId)],
    preconditions: [{
      id: `precondition:${actorId}:heard-rumor`,
      kind: "actor-has-claim",
      paths: [paths.actorEpistemic(actorId)],
      arguments: { actorId, claimId: ids.rumorClaim },
    }],
    resourceClaims: [{
      resourceType: "grain",
      resourceId: ids.grainStock,
      mode: "consume",
      quantity: 70,
      unit: "sack",
    }],
    resolution: GRAIN_RESOLVER,
    action: {
      kind: "request-grain",
      allocation: {
        id: allocationId,
        revision: 0,
        stockId: ids.grainStock,
        requesterId: actorId,
        requestedQuantity: 70,
        grantedQuantity: 0,
        status: "pending",
        causalParents: [causalParent],
      },
    },
  });

  return [
    makeRequest(ids.baker, ids.bakerAllocation, rumorTraces.bakerTraceId),
    makeRequest(ids.innkeeper, ids.innkeeperAllocation, rumorTraces.innkeeperTraceId),
  ];
}

function requestGrain(
  kernel: Kernel<Proof00WorldState>,
  rumorTraces: { readonly bakerTraceId: string; readonly innkeeperTraceId: string },
): readonly ProposalDisposition[] {
  const instant = nextInstant(time.grainRequests, 0);
  return kernel.commitPhase(
    instant,
    grainRequestProposals(kernel, rumorTraces, instant),
  ).dispositions;
}

interface ChairPerceivedState {
  readonly accessibleClaims: readonly {
    readonly claimId: string;
    readonly kind: string;
    readonly proposition: string;
    readonly sourceActorId: string;
  }[];
  readonly organizationId: string;
  readonly role: "chair";
  readonly knownGrainLedger: { readonly stockId: string; readonly openingQuantity: number };
}

function chairDecisionContext(
  state: Proof00WorldState,
  instant: LogicalInstant,
  triggerTraceId: string,
): ActorDecisionContext<ChairPerceivedState> {
  const actor = state.actors[ids.chair]!;
  const accessibleClaims = actor.epistemicState.accessibleClaimIds
    .map((claimId) => state.claims[claimId])
    .filter((claim): claim is Proof00ClaimState => Boolean(claim))
    .map((claim) => ({
      claimId: claim.id,
      kind: claim.kind,
      proposition: claim.proposition,
      sourceActorId: claim.sourceActorId,
    }));
  return sealActorDecisionContext({
    schemaVersion: "proof00.actor-decision-context.v1",
    triggerId: ids.chairTrigger,
    actorId: ids.chair,
    instant,
    epistemicState: structuredClone(actor.epistemicState),
    perceivedState: {
      accessibleClaims,
      organizationId: ids.council,
      role: "chair",
      knownGrainLedger: { stockId: ids.grainStock, openingQuantity: 100 },
    },
    availableRoles: ["chair", "member"],
    allowedActionKinds: proof00Contract.actorActionKinds,
    evidenceRefs: [ids.officialClaim],
  });
}

function chairCandidateSet(): CandidateActionSet<Proof00ActorAction> {
  return {
    schemaVersion: CANDIDATE_ACTION_SET_SCHEMA_VERSION,
    triggerId: ids.chairTrigger,
    actorId: ids.chair,
    candidates: [
      {
        id: "candidate:reserve-sixty",
        action: {
          kind: "recommend-grain-reserve",
          organizationId: ids.council,
          stockId: ids.grainStock,
          quantity: 60,
        },
        subjectiveReason: "The official road report makes a minimum public reserve prudent.",
        expectedConsequence: "Sixty sacks remain protected for town-wide emergency use.",
        perceivedRisk: "Private buyers may receive less grain before the next verified shipment.",
        informationBasis: [ids.officialClaim],
      },
      {
        id: "candidate:verify-first",
        action: {
          kind: "request-verification",
          organizationId: ids.council,
          claimId: ids.officialClaim,
        },
        subjectiveReason: "A second report could reduce uncertainty.",
        expectedConsequence: "The council delays material intervention pending confirmation.",
        perceivedRisk: "The unreserved stock may be gone before confirmation arrives.",
        informationBasis: [ids.officialClaim],
      },
    ],
    preferredCandidateId: "candidate:reserve-sixty",
  };
}

function semanticContributionHash(
  contributions: readonly ActorProposerContribution[],
): string {
  return hash(contributions.map((contribution) => ({
    provider: contribution.provider,
    model: contribution.model,
    modelVersion: contribution.modelVersion,
    schemaVersion: contribution.schemaVersion,
    result: contribution.result,
    rawOutput: contribution.rawOutput ?? null,
    sampling: contribution.sampling ?? null,
  })));
}

interface ReportResult {
  readonly contribution?: RecordedActorProposerContribution<Proof00ActorAction>;
  readonly externalModelCallCount: number;
  readonly incomplete: boolean;
  readonly failure?: ActorProposerTechnicalFailure;
  readonly orderArrival?: number;
  readonly orderStartTraceId?: string;
  readonly organizationDecisionTraceId?: string;
}

function processReport(
  kernel: Kernel<Proof00WorldState>,
  arrival: number,
  reportStartTraceId: string,
  options: Proof00RunOptions,
): ReportResult {
  const completeInstant = nextInstant(arrival, 0);
  const completeTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:clerk-completes-report-journey",
    source: "movement",
    instant: completeInstant,
    subjects: [ids.clerk, ids.reportMovement],
    causalParents: [reportStartTraceId],
    readPaths: [
      paths.movement(ids.reportMovement),
      paths.actorLocation(ids.clerk),
      paths.route(ids.reportRoute),
    ],
    effectPaths: [paths.movement(ids.reportMovement), paths.actorLocation(ids.clerk)],
    action: { kind: "complete-movement", movementId: ids.reportMovement },
  }));

  const chairDeliveryInstant = nextInstant(arrival, 1);
  const chairDeliveryTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:official-report-reaches-chair",
    source: "information",
    instant: chairDeliveryInstant,
    subjects: [ids.officialClaim, ids.chair, ids.clerk],
    causalParents: [completeTraceId],
    readPaths: [
      paths.claim(ids.officialClaim),
      paths.actorLocation(ids.chair),
      paths.actorLocation(ids.clerk),
      paths.actorEpistemic(ids.chair),
    ],
    effectPaths: [paths.claim(ids.officialClaim), paths.actorEpistemic(ids.chair)],
    action: {
      kind: "deliver-claim",
      claimId: ids.officialClaim,
      recipientType: "actor",
      recipientId: ids.chair,
      channel: "in-person",
      carrierId: ids.clerk,
    },
  }));

  const recordInstant = nextInstant(arrival, 2);
  const recordTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:clerk-files-official-report",
    source: "information",
    instant: recordInstant,
    subjects: [ids.officialClaim, ids.council, ids.clerk],
    causalParents: [completeTraceId],
    readPaths: [
      paths.claim(ids.officialClaim),
      paths.actorLocation(ids.clerk),
      paths.organization(ids.council),
      paths.organizationRecords(ids.council, "clerk"),
    ],
    effectPaths: [paths.organizationRecords(ids.council, "clerk")],
    action: {
      kind: "deliver-claim",
      claimId: ids.officialClaim,
      recipientType: "organization-role",
      recipientId: ids.council,
      role: "clerk",
      channel: "in-person",
      carrierId: ids.clerk,
    },
  }));

  const triggerInstant = nextInstant(arrival, 3);
  const triggerTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:official-report-triggers-chair-decision",
    source: "decision-trigger",
    instant: triggerInstant,
    subjects: [ids.chair, ids.chairTrigger],
    causalParents: [chairDeliveryTraceId],
    readPaths: [paths.trigger(ids.chairTrigger), paths.actorEpistemic(ids.chair)],
    effectPaths: [paths.trigger(ids.chairTrigger)],
    action: {
      kind: "emit-decision-trigger",
      trigger: {
        id: ids.chairTrigger,
        source: "information",
        version: mechanismVersions.information,
        actorId: ids.chair,
        instant: triggerInstant,
        causalParents: [chairDeliveryTraceId],
        reason: "An official supply interruption report reached the council chair.",
        requestedAuthority: "recommend-council-response",
        allowedActionKinds: proof00Contract.actorActionKinds,
        deadline: nextInstant(arrival + 60, 0),
      },
    },
  }));

  const decisionInstant = nextInstant(arrival, 4);
  const context = chairDecisionContext(kernel.state(), decisionInstant, triggerTraceId);
  const proposer = options.simulateActorProposerFailure
    ? new FailingActorProposer({
        provider: "fixture-provider",
        model: "fixture-chair-model",
        modelVersion: "1",
        attemptCount: 2,
        errorCode: "recorded-timeout",
        attemptErrors: ["attempt 1 timed out", "attempt 2 timed out"],
      })
    : new RecordedActorProposer<Proof00ActorAction>([
        options.replayContribution ?? recordActorProposerContribution(
          context,
          chairCandidateSet(),
          {
            provider: "recorded-fixture",
            model: "chair-deliberation-cassette",
            modelVersion: "1",
            attemptCount: 1,
            sampling: { temperature: 0, top_p: 1 },
          },
        ),
      ]);
  const proposed = proposer.propose(context);
  if (!proposed.ok) {
    return {
      externalModelCallCount: proposed.externalModelCallCount,
      incomplete: true,
      failure: proposed,
    };
  }
  const contribution = proposed.contribution;
  const preferred = contribution.result.candidates.find(
    (candidate) => candidate.id === contribution.result.preferredCandidateId,
  );
  if (!preferred || preferred.action.kind !== "recommend-grain-reserve") {
    throw new Error("Proof 00 cassette must prefer a grain reservation recommendation");
  }

  const positionTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:chair-records-reservation-position",
    source: "actor-decision",
    instant: decisionInstant,
    subjects: [ids.chair, ids.chairPosition],
    causalParents: [triggerTraceId],
    readPaths: [
      paths.trigger(ids.chairTrigger),
      paths.actor(ids.chair),
      paths.actorEpistemic(ids.chair),
      paths.actorPosition(ids.chairPosition),
    ],
    effectPaths: [paths.actorPosition(ids.chairPosition), paths.actor(ids.chair)],
    preconditions: [{
      id: "precondition:chair-has-official-report",
      kind: "actor-has-claim",
      paths: [paths.actorEpistemic(ids.chair)],
      arguments: { actorId: ids.chair, claimId: ids.officialClaim },
    }],
    action: {
      kind: "record-actor-position",
      position: {
        id: ids.chairPosition,
        actorId: ids.chair,
        triggerId: ids.chairTrigger,
        action: preferred.action,
        decidedAt: decisionInstant,
        evidenceRefs: [ids.officialClaim],
        contributionHash: contribution.contributionHash,
      },
    },
  }));

  const organizationInstant = nextInstant(arrival, 5);
  const organizationDecisionTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:council-adopts-reservation-order",
    source: "organization",
    instant: organizationInstant,
    subjects: [ids.council, ids.councilDecision, ids.chair],
    causalParents: [positionTraceId, recordTraceId],
    readPaths: [
      paths.organization(ids.council),
      paths.organizationRecords(ids.council, "clerk"),
      paths.organizationDecision(ids.council, ids.councilDecision),
      paths.actorPosition(ids.chairPosition),
    ],
    effectPaths: [paths.organizationDecision(ids.council, ids.councilDecision)],
    preconditions: [{
      id: "precondition:council-clerked-official-report",
      kind: "organization-role-has-claim",
      paths: [paths.organizationRecords(ids.council, "clerk")],
      arguments: { organizationId: ids.council, role: "clerk", claimId: ids.officialClaim },
    }],
    action: {
      kind: "record-organization-decision",
      organizationId: ids.council,
      decision: {
        id: ids.councilDecision,
        issue: "Protect an emergency grain reserve after the northern route closure.",
        status: "adopted",
        decidedAt: organizationInstant,
        authorityActorId: ids.chair,
        orderId: ids.orderClaim,
        stockId: ids.grainStock,
        quantity: 60,
        supportingPositionId: ids.chairPosition,
        causalParents: [positionTraceId, recordTraceId],
      },
    },
  }));

  const orderClaimInstant = nextInstant(arrival, 6);
  const orderClaim: Proof00ClaimState = {
    id: ids.orderClaim,
    revision: 0,
    proposition: "By council decision, reserve sixty sacks in the town grain store.",
    kind: "organization-order",
    sourceActorId: ids.chair,
    formedAt: orderClaimInstant,
    provenance: [organizationDecisionTraceId],
    recipientActorIds: [ids.clerk, ids.keeper],
    receivedBy: {},
    derivedFrom: ids.officialClaim,
    transformation: `Authorized by ${ids.councilDecision}`,
  };
  const orderClaimTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:council-order-is-issued",
    source: "information",
    instant: orderClaimInstant,
    subjects: [ids.orderClaim, ids.chair],
    causalParents: [organizationDecisionTraceId],
    readPaths: [paths.claim(ids.orderClaim), paths.actor(ids.chair)],
    effectPaths: [paths.claim(ids.orderClaim)],
    action: { kind: "create-claim", claim: orderClaim },
  }));

  const clerkOrderInstant = nextInstant(arrival, 7);
  const clerkOrderTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:reservation-order-reaches-clerk",
    source: "information",
    instant: clerkOrderInstant,
    subjects: [ids.orderClaim, ids.clerk, ids.chair],
    causalParents: [orderClaimTraceId],
    readPaths: [
      paths.claim(ids.orderClaim),
      paths.actorLocation(ids.chair),
      paths.actorLocation(ids.clerk),
      paths.actorEpistemic(ids.clerk),
    ],
    effectPaths: [paths.claim(ids.orderClaim), paths.actorEpistemic(ids.clerk)],
    action: {
      kind: "deliver-claim",
      claimId: ids.orderClaim,
      recipientType: "actor",
      recipientId: ids.clerk,
      channel: "in-person",
      carrierId: ids.chair,
    },
  }));

  const orderStartInstant = nextInstant(arrival, 8);
  const orderArrival = arrival + time.orderTravel;
  const orderStartTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:clerk-starts-order-journey",
    source: "movement",
    instant: orderStartInstant,
    subjects: [ids.clerk, ids.orderMovement],
    causalParents: [clerkOrderTraceId],
    readPaths: [
      paths.movement(ids.orderMovement),
      paths.actorLocation(ids.clerk),
      paths.route(ids.orderRoute),
    ],
    effectPaths: [paths.movement(ids.orderMovement), paths.actorLocation(ids.clerk)],
    action: {
      kind: "start-movement",
      movement: {
        id: ids.orderMovement,
        revision: 0,
        moverId: ids.clerk,
        cargoIds: [ids.orderClaim],
        routeId: ids.orderRoute,
        origin: ids.councilHall,
        destination: ids.grainStore,
        startedAt: orderStartInstant,
        earliestArrival: nextInstant(orderArrival, 0),
        currentSegmentIndex: 0,
        status: "in-progress",
      },
    },
  }));

  return {
    contribution,
    externalModelCallCount: proposed.externalModelCallCount,
    incomplete: false,
    orderArrival,
    orderStartTraceId,
    organizationDecisionTraceId,
  };
}

function finishOrderAndReserve(
  kernel: Kernel<Proof00WorldState>,
  orderArrival: number,
  orderStartTraceId: string,
  organizationDecisionTraceId: string,
  coordinatedRumorTraces?: {
    readonly bakerTraceId: string;
    readonly innkeeperTraceId: string;
  },
): {
  readonly reservationDisposition: ProposalDisposition;
  readonly requestDispositions?: readonly ProposalDisposition[];
} {
  const completeInstant = nextInstant(orderArrival, 0);
  const completeTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:clerk-completes-order-journey",
    source: "movement",
    instant: completeInstant,
    subjects: [ids.clerk, ids.orderMovement],
    causalParents: [orderStartTraceId],
    readPaths: [
      paths.movement(ids.orderMovement),
      paths.actorLocation(ids.clerk),
      paths.route(ids.orderRoute),
    ],
    effectPaths: [paths.movement(ids.orderMovement), paths.actorLocation(ids.clerk)],
    action: { kind: "complete-movement", movementId: ids.orderMovement },
  }));

  const deliveryInstant = nextInstant(orderArrival, 1);
  const deliveryTraceId = commitRequired(kernel, makeProposal(kernel, {
    id: "proposal:reservation-order-reaches-keeper",
    source: "information",
    instant: deliveryInstant,
    subjects: [ids.orderClaim, ids.keeper, ids.clerk],
    causalParents: [completeTraceId],
    readPaths: [
      paths.claim(ids.orderClaim),
      paths.actorLocation(ids.clerk),
      paths.actorLocation(ids.keeper),
      paths.actorEpistemic(ids.keeper),
    ],
    effectPaths: [paths.claim(ids.orderClaim), paths.actorEpistemic(ids.keeper)],
    action: {
      kind: "deliver-claim",
      claimId: ids.orderClaim,
      recipientType: "actor",
      recipientId: ids.keeper,
      channel: "in-person",
      carrierId: ids.clerk,
    },
  }));

  const reserveInstant = nextInstant(orderArrival, 2);
  const reservationProposal = makeProposal(kernel, {
    id: "proposal:keeper-reserves-emergency-grain",
    source: "grain",
    instant: reserveInstant,
    subjects: [ids.keeper, ids.grainStock, ids.reservation],
    causalParents: [deliveryTraceId, organizationDecisionTraceId],
    readPaths: [
      paths.grain(ids.grainStock),
      paths.reservation(ids.reservation),
      paths.actorEpistemic(ids.keeper),
      paths.claim(ids.orderClaim),
      paths.organizationDecision(ids.council, ids.councilDecision),
    ],
    effectPaths: [paths.grain(ids.grainStock), paths.reservation(ids.reservation)],
    preconditions: [
      {
        id: "precondition:keeper-has-council-order",
        kind: "actor-has-claim",
        paths: [paths.actorEpistemic(ids.keeper)],
        arguments: { actorId: ids.keeper, claimId: ids.orderClaim },
      },
      {
        id: "precondition:sixty-unreserved-sacks",
        kind: "grain-at-least",
        paths: [paths.grain(ids.grainStock)],
        arguments: { stockId: ids.grainStock, quantity: 60 },
      },
    ],
    resourceClaims: [{
      resourceType: "grain",
      resourceId: ids.grainStock,
      mode: "reserve",
      quantity: 60,
      unit: "sack",
    }],
    ...(coordinatedRumorTraces ? { resolution: GRAIN_RESOLVER } : {}),
    action: {
      kind: "reserve-grain",
      reservation: {
        id: ids.reservation,
        revision: 0,
        stockId: ids.grainStock,
        quantity: 60,
        holderId: ids.keeper,
        organizationId: ids.council,
        decisionId: ids.councilDecision,
        orderClaimId: ids.orderClaim,
        status: "active",
        causalParents: [deliveryTraceId, organizationDecisionTraceId],
      },
    },
  });
  if (!coordinatedRumorTraces) {
    return { reservationDisposition: commitObserved(kernel, reservationProposal).disposition };
  }
  const requests = grainRequestProposals(kernel, coordinatedRumorTraces, reserveInstant);
  const result = kernel.commitPhase(reserveInstant, [reservationProposal, ...requests]);
  const reservationDisposition = result.dispositions.find(
    ({ proposalId }) => proposalId === reservationProposal.id,
  );
  if (!reservationDisposition) throw new Error("Coordinated reservation produced no disposition");
  const requestIds = new Set(requests.map(({ id }) => id));
  return {
    reservationDisposition,
    requestDispositions: result.dispositions.filter(({ proposalId }) => requestIds.has(proposalId)),
  };
}

function buildArtifact(
  kernel: Kernel<Proof00WorldState>,
  initialState: Proof00WorldState,
  common: CommonPrefix,
  options: Proof00RunOptions,
  delay: number,
  status: "complete" | "incomplete",
  contributions: readonly RecordedActorProposerContribution<Proof00ActorAction>[],
  failures: readonly ActorProposerTechnicalFailure[] = [],
): RunArtifact<Proof00WorldState, Proof00Action> {
  const seed = options.seed ?? "proof00-seed-v1";
  const externalInputs = {
    scenarioVersion: "cut-off-town-proof00.v1",
    reportRouteDelayMinutes: delay,
  };
  const manifest: RunManifest = {
    runId: `run:proof00:${options.variant}:v1`,
    possibleHistoryId: `history:proof00:${options.variant}:v1`,
    contractId: proof00Contract.id,
    contractVersion: proof00Contract.version,
    contractHash: proof00ContractHash,
    initialStateHash: proof00InitialStateHash,
    mechanismVersions,
    schemaVersions: proof00SchemaVersions,
    seed,
    horizon: proof00Contract.horizon,
    actorProposerContract: "proof00.actor-proposer.v1",
    externalInputs,
    externalInputsHash: hash(externalInputs),
    recordedContributionSetHash: semanticContributionHash(contributions),
    ...(options.variant === "anchored"
      ? {
          anchor: {
            parentRunId: "run:proof00:base:v1",
            anchorTransitionId: common.anchorTransitionId,
            prefixTraceHash: common.prefixTraceHash,
            inputDeltaHash: hash({
              reportRouteDelayMinutes: { from: time.baseReportArrival - time.anchoredReportArrival, to: 0 },
            }),
          },
        }
      : {}),
  };
  const finalState = kernel.state();
  const trace = kernel.trace();
  return deepFreeze({
    manifest,
    status,
    initialState,
    finalState,
    transitions: kernel.transitions() as readonly CommittedTransition<Proof00Action>[],
    trace,
    randomDraws: kernel.randomDraws() as readonly RecordedRandomDraw[],
    actorProposerContributions: contributions,
    actorProposerFailures: failures,
    finalStateHash: hash(finalState),
    traceHash: hash(trace),
    ...(status === "incomplete" ? { incompleteAtTriggerId: ids.chairTrigger } : {}),
  });
}

function runFromCommon(common: CommonPrefix, options: Proof00RunOptions): Proof00RunResult {
  const seed = options.seed ?? "proof00-seed-v1";
  const reverseRegistration = options.reverseRegistration ?? false;
  const reportDelayMinutes = options.variant === "base"
    ? time.baseReportArrival - time.anchoredReportArrival
    : 0;
  const kernel = createBranchKernel(common, seed, reverseRegistration);
  const started = startReportJourney(kernel, reportDelayMinutes);
  let requestDispositions: readonly ProposalDisposition[] | undefined;
  let reservationDisposition: ProposalDisposition | undefined;
  let report: ReportResult;

  if (options.variant === "anchored") {
    report = processReport(kernel, started.reportArrival, started.reportStartTraceId, options);
    if (report.incomplete) {
      return {
        artifact: buildArtifact(
          kernel,
          common.initialState,
          common,
          options,
          reportDelayMinutes,
          "incomplete",
          [],
          report.failure ? [report.failure] : [],
        ),
        reportDelayMinutes,
        reportArrival: started.reportArrival,
        externalModelCallCount: report.externalModelCallCount,
      };
    }
    const rumorTraces = addRumor(kernel, common.officialAccessTraceId);
    const coordinated = finishOrderAndReserve(
      kernel,
      report.orderArrival!,
      report.orderStartTraceId!,
      report.organizationDecisionTraceId!,
      rumorTraces,
    );
    reservationDisposition = coordinated.reservationDisposition;
    requestDispositions = coordinated.requestDispositions;
  } else {
    const rumorTraces = addRumor(kernel, common.officialAccessTraceId);
    requestDispositions = requestGrain(kernel, rumorTraces);
    report = processReport(kernel, started.reportArrival, started.reportStartTraceId, options);
    if (report.incomplete) {
      return {
        artifact: buildArtifact(
          kernel,
          common.initialState,
          common,
          options,
          reportDelayMinutes,
          "incomplete",
          [],
          report.failure ? [report.failure] : [],
        ),
        reportDelayMinutes,
        reportArrival: started.reportArrival,
        requestDispositions,
        externalModelCallCount: report.externalModelCallCount,
      };
    }
    reservationDisposition = finishOrderAndReserve(
      kernel,
      report.orderArrival!,
      report.orderStartTraceId!,
      report.organizationDecisionTraceId!,
    ).reservationDisposition;
  }

  const contributions = report.contribution ? [report.contribution] : [];
  return {
    artifact: buildArtifact(kernel, common.initialState, common, options, reportDelayMinutes, "complete", contributions),
    reportDelayMinutes,
    reportArrival: started.reportArrival,
    orderArrival: report.orderArrival,
    requestDispositions,
    reservationDisposition,
    externalModelCallCount: report.externalModelCallCount,
  };
}

export function runProof00Variant(options: Proof00RunOptions): Proof00RunResult {
  const seed = options.seed ?? "proof00-seed-v1";
  const common = buildCommonPrefix(seed, options.reverseRegistration ?? false);
  return runFromCommon(common, options);
}

export function runProof00Pair(
  options: Omit<Proof00RunOptions, "variant" | "replayContribution"> = {},
): Proof00PairResult {
  const seed = options.seed ?? "proof00-seed-v1";
  const common = buildCommonPrefix(seed, options.reverseRegistration ?? false);
  return {
    base: runFromCommon(common, { ...options, variant: "base" }),
    anchored: runFromCommon(common, { ...options, variant: "anchored" }),
  };
}

export function replayProof00Artifact(
  artifact: RunArtifact<Proof00WorldState, Proof00Action>,
): Proof00RunResult {
  const delay = artifact.manifest.externalInputs.reportRouteDelayMinutes;
  const variant: Proof00Variant = delay === 0 ? "anchored" : "base";
  const contribution = artifact.actorProposerContributions[0] as
    | RecordedActorProposerContribution<Proof00ActorAction>
    | undefined;
  if (!contribution) throw new Error("Completed Proof 00 replay requires one recorded ActorProposer contribution");
  return runProof00Variant({
    variant,
    seed: artifact.manifest.seed,
    replayContribution: contribution,
  });
}
