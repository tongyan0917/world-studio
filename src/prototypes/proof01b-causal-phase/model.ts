/**
 * THROWAWAY PROTOTYPE — Proof 01B
 *
 * Question: can a single-process, in-memory state machine make the accepted
 * Proof 01 control boundary tangible: exhaustive boundary/source accounting
 * freezes a Frontier; a non-empty Frontier requires cascade admission before
 * one atomic publication can activate the next Base; a zero Frontier closes
 * without publication; and a B+1 same-time Frontier stops Incomplete without
 * mutating the last committed Base?
 *
 * Candidate state is checked against a module-issued in-process authority head,
 * standing in for the durable trusted head a real repository would own.
 *
 * This is an executable protocol sketch, not an implementation of ADR-0053
 * through ADR-0059. It intentionally omits persistence, concurrency, the full
 * validation/resolution pipeline, and a real model provider.
 */

import { hash, stableStringify } from "../../kernel/stable.ts";

export const DEFAULT_CASCADE_BUDGET = 2;
export const MODEL_ID = "fixture-recorded-llm-v1";
export const PROMPT_POLICY_VERSION = "proof01b-proposer-v1";
export const MODEL_SCHEMA_VERSION = "transition-proposal-v1";

export type WorldTime = "T0" | "T1" | "T2";
export type PhaseMode =
  | "boundary-open"
  | "source-collection"
  | "frontier-frozen"
  | "admitted"
  | "ready"
  | "incomplete"
  | "empty-closed"
  | "later-boundary-unmodeled";

export type FixtureSourceOutcome = "non-empty" | "zero";

export interface WorldState {
  readonly roadOpen: boolean;
  readonly councilAlerted: boolean;
  readonly watchLevel: number;
}

export interface CausalInputActivation {
  readonly id: string;
  readonly kind: "storm-front" | "road-blocked" | "council-alerted" | "watch-mobilized";
  readonly effectiveWorldTime: WorldTime;
  readonly origin: "declared-root" | "published-output";
  readonly outputId: string | null;
  readonly producerPlanId: string | null;
}

export interface CommittedBase {
  readonly id: string;
  readonly version: number;
  readonly worldTime: WorldTime;
  readonly phaseOrdinal: number;
  readonly parentBaseId: string | null;
  readonly world: WorldState;
  readonly history: readonly string[];
  readonly activeInputs: readonly CausalInputActivation[];
}

export interface BoundaryObligation {
  readonly id: string;
  readonly kind: "activated-input" | "active-process";
  readonly subjectId: string;
}

export interface BoundaryAnswer {
  readonly id: string;
  readonly obligationId: string;
  readonly kind: "candidate" | "exhausted";
  readonly candidateWorldTime: WorldTime | null;
}

export interface BoundarySelection {
  readonly id: string;
  readonly effectiveWorldTime: WorldTime;
  readonly winningAnswerIds: readonly string[];
}

export interface ProposalSourceObligation {
  readonly id: string;
  readonly sourceId: string;
  readonly activationId: string;
  readonly selectedBoundaryId: string;
}

export interface ContinuationClaim {
  readonly id: string;
  readonly sourceObligationId: string;
  readonly activationId: string;
  readonly branch: "exhaust-current-activation";
  readonly applied: false;
}

export interface ModelProposalPayload {
  readonly proposalKind: "close-road" | "alert-council" | "mobilize-watch" | "hold-watch";
  readonly summary: string;
  readonly rationale: string;
  readonly patch: {
    readonly roadOpen: boolean | null;
    readonly councilAlerted: boolean | null;
    readonly watchLevelDelta: number;
  };
  readonly worldCausalOutput: {
    readonly kind: CausalInputActivation["kind"];
    readonly summary: string;
  } | null;
}

export interface RecordedModelContribution {
  readonly id: string;
  readonly modelId: typeof MODEL_ID;
  readonly promptPolicyVersion: typeof PROMPT_POLICY_VERSION;
  readonly schemaVersion: typeof MODEL_SCHEMA_VERSION;
  readonly inputFingerprint: string;
  readonly rawOutput: string;
  readonly rawFingerprint: string;
  readonly parsedOutput: ModelProposalPayload;
  readonly parsedFingerprint: string;
}

export interface TransitionProposal {
  readonly id: string;
  readonly sourceObligationId: string;
  readonly activationId: string;
  readonly modelContributionId: string;
  readonly payload: ModelProposalPayload;
}

export interface ProposalSourceResult {
  readonly id: string;
  readonly obligationId: string;
  readonly kind: "proposals" | "no-proposal";
  readonly proposalIds: readonly string[];
  readonly continuationClaimIds: readonly string[];
  readonly modelContributionIds: readonly string[];
}

export interface CausalFrontier {
  readonly id: string;
  readonly kind: "non-empty" | "zero";
  readonly proposalIds: readonly string[];
  readonly resultIds: readonly string[];
}

export interface RootTriggerProof {
  readonly id: string;
  readonly kind: "root";
  readonly frontierId: string;
  readonly activationId: string;
  readonly selectedWorldTime: WorldTime;
  readonly priorWorldTime: WorldTime;
}

export interface SuccessorTriggerProof {
  readonly id: string;
  readonly kind: "successor";
  readonly predecessorReceiptId: string;
  readonly predecessorBundleId: string;
  readonly publishedOutputId: string;
  readonly activatedInputId: string;
  readonly activatedBaseId: string;
}

export type CascadeTriggerProof = RootTriggerProof | SuccessorTriggerProof;

export interface CascadeAdmission {
  readonly id: string;
  readonly runId: string;
  readonly branchId: string;
  readonly budgetId: string;
  readonly cascadeId: string;
  readonly frontierId: string;
  readonly completedDepth: number;
  readonly candidatePosition: number;
  readonly triggerProofId: string;
}

export interface RunCommitment {
  readonly id: string;
  readonly runId: string;
  readonly branchId: string;
  readonly budgetId: string;
  readonly fixtureId: string;
}

export interface CascadeLimitReached {
  readonly id: string;
  readonly baseId: string;
  readonly baseAuthorityHash: string;
  readonly cascadeId: string;
  readonly budgetId: string;
  readonly completedDepth: number;
  readonly candidatePosition: number;
  readonly frontierId: string;
  readonly receiptIds: readonly string[];
}

export interface StagedPhaseResult {
  readonly id: string;
  readonly proposalIds: readonly string[];
  readonly basePreimageHash: string;
  readonly privateWorld: WorldState;
  readonly eventSummaries: readonly string[];
  readonly outputDrafts: readonly {
    readonly id: string;
    readonly kind: CausalInputActivation["kind"];
    readonly summary: string;
  }[];
}

export interface PhasePublicationPlan {
  readonly id: string;
  readonly baseId: string;
  readonly frontierId: string;
  readonly admissionId: string;
  readonly stagedResultId: string;
  readonly resultingWorldHash: string;
  readonly publishedOutputIds: readonly string[];
}

export interface NextBaseCandidate {
  readonly id: string;
  readonly base: CommittedBase;
}

export interface PhasePublicationBundle {
  readonly id: string;
  readonly planId: string;
  readonly admissionId: string;
  readonly candidateBaseId: string;
  readonly publishedOutputs: readonly {
    readonly id: string;
    readonly kind: CausalInputActivation["kind"];
    readonly summary: string;
  }[];
}

export interface PhasePublicationReceipt {
  readonly id: string;
  readonly runCommitmentId: string;
  readonly cascadeId: string;
  readonly position: number;
  readonly priorBaseId: string;
  readonly activatedBaseId: string;
  readonly effectiveWorldTime: WorldTime;
  readonly boundarySelectionId: string;
  readonly planId: string;
  readonly bundleId: string;
  readonly admissionId: string;
  readonly admission: CascadeAdmission;
  readonly triggerProof: CascadeTriggerProof;
  readonly publishedOutputIds: readonly string[];
  readonly modelContributionIds: readonly string[];
}

export interface EmptyFrontierClosure {
  readonly id: string;
  readonly baseId: string;
  readonly baseAuthorityHash: string;
  readonly worldTime: WorldTime;
  readonly completedDepth: number;
  readonly receiptIds: readonly string[];
  readonly frontierId: string;
  readonly pendingClaimIds: readonly string[];
}

export interface BarrierFailure {
  readonly id: string;
  readonly bundleId: string;
  readonly baseId: string;
  readonly baseAuthorityHash: string;
  readonly completedDepth: number;
  readonly receiptCount: number;
}

export interface PhaseAttempt {
  readonly id: string;
  readonly runCommitmentId: string;
  readonly generation: number;
  readonly mode: PhaseMode;
  readonly boundaryManifestId: string;
  readonly boundaryObligations: readonly BoundaryObligation[];
  readonly boundaryAnswers: readonly BoundaryAnswer[];
  readonly boundaryCompletenessEvidenceId: string | null;
  readonly boundarySelection: BoundarySelection | null;
  readonly sourceManifestId: string | null;
  readonly sourceFixtureBindingId: string | null;
  readonly sourceObligations: readonly ProposalSourceObligation[];
  readonly sourceResults: readonly ProposalSourceResult[];
  readonly continuationClaims: readonly ContinuationClaim[];
  readonly proposals: readonly TransitionProposal[];
  readonly quiescenceEvidenceId: string | null;
  readonly frontier: CausalFrontier | null;
  readonly triggerProof: CascadeTriggerProof | null;
  readonly admission: CascadeAdmission | null;
  readonly limitReached: CascadeLimitReached | null;
  readonly stagedResult: StagedPhaseResult | null;
  readonly plan: PhasePublicationPlan | null;
  readonly candidate: NextBaseCandidate | null;
  readonly bundle: PhasePublicationBundle | null;
  readonly emptyClosure: EmptyFrontierClosure | null;
}

export interface LastAction {
  readonly action: string;
  readonly status: "accepted" | "rejected" | "barrier-failed";
  readonly message: string;
}

export interface Proof01BState {
  readonly run: {
    readonly id: string;
    readonly branchId: string;
    readonly status: "running" | "incomplete";
    readonly budget: {
      readonly id: string;
      readonly maximumPublishedPhases: number;
      readonly countingVersion: "successful-receipts-v1";
    };
    readonly fixture: {
      readonly id: string;
      readonly sourceOutcomes: readonly FixtureSourceOutcome[];
    };
  };
  readonly runCommitment: RunCommitment;
  readonly base: CommittedBase;
  readonly baseActivationReceiptId: string | null;
  readonly cascadeId: string | null;
  readonly receipts: readonly PhasePublicationReceipt[];
  readonly publishedBundles: readonly PhasePublicationBundle[];
  readonly modelLedger: readonly RecordedModelContribution[];
  readonly emptyClosures: readonly EmptyFrontierClosure[];
  readonly barrierFailures: readonly BarrierFailure[];
  readonly attempt: PhaseAttempt;
  readonly failNextBarrier: boolean;
  readonly lastAction: LastAction;
}

const TRUST_ANCHOR_ISSUER = Symbol("proof01b-trust-anchor-issuer");
const ISSUED_TRUST_ANCHORS = new WeakSet<object>();

class TrustAnchor {
  readonly runCommitmentId: string;
  readonly committedAuthorityHash: string;
  readonly #issuedByProof01B = true;

  constructor(
    issuer: typeof TRUST_ANCHOR_ISSUER,
    runCommitmentId: string,
    authorityHash: string,
  ) {
    if (issuer !== TRUST_ANCHOR_ISSUER) {
      throw new TypeError("Proof01B trust anchors can be issued only by this model module");
    }
    this.runCommitmentId = runCommitmentId;
    this.committedAuthorityHash = authorityHash;
    ISSUED_TRUST_ANCHORS.add(this);
    Object.freeze(this);
  }

  isIssuedByProof01B(): boolean {
    return this.#issuedByProof01B;
  }
}

export type Proof01BTrustAnchor = TrustAnchor;

export interface Proof01BSession {
  readonly state: Proof01BState;
  readonly trustAnchor: Proof01BTrustAnchor;
}

export type Proof01BAction =
  | { readonly type: "complete-boundary" }
  | {
      readonly type: "collect-frontier";
      readonly recordedContribution?: RecordedModelContribution;
    }
  | { readonly type: "admit" }
  | { readonly type: "prepare" }
  | { readonly type: "arm-barrier-failure" }
  | { readonly type: "publish" };

export interface InvariantCheck {
  readonly label: string;
  readonly status: "PASS" | "FAIL" | "PENDING";
  readonly detail: string;
}

function id(prefix: string, value: unknown): string {
  return `${prefix}:${hash(value).slice(0, 12)}`;
}

type PhasePublicationReceiptContent = Omit<PhasePublicationReceipt, "id">;

function publicationReceiptId(value: PhasePublicationReceiptContent): string {
  return id("publication-receipt", value);
}

function makeBase(
  value: Omit<CommittedBase, "id">,
): CommittedBase {
  return { id: id("base", value), ...value };
}

function worldTimeOrdinal(value: WorldTime): number {
  return Number(value.slice(1));
}

function initialBase(): CommittedBase {
  const activation: CausalInputActivation = {
    id: "activation:declared-storm-front",
    kind: "storm-front",
    effectiveWorldTime: "T1",
    origin: "declared-root",
    outputId: null,
    producerPlanId: null,
  };
  return makeBase({
    version: 0,
    worldTime: "T0",
    phaseOrdinal: 0,
    parentBaseId: null,
    world: {
      roadOpen: true,
      councilAlerted: false,
      watchLevel: 0,
    },
    history: ["T0: The town begins with an open supply road and no alarm."],
    activeInputs: [activation],
  });
}

function expectedBoundaryObligations(
  base: CommittedBase,
  generation: number,
): readonly BoundaryObligation[] {
  const inputObligation: BoundaryObligation | null = base.activeInputs.length > 0
    ? {
      id: id("boundary-obligation", {
        baseId: base.id,
        generation,
        kind: "activated-input",
        subjects: base.activeInputs.map((input) => input.id).sort(),
      }),
      kind: "activated-input",
      subjectId: base.activeInputs.map((input) => input.id).sort().join(","),
    }
    : null;
  return [
    ...(inputObligation ? [inputObligation] : []),
    {
      id: id("boundary-obligation", {
        baseId: base.id,
        generation,
        kind: "active-process",
        subject: "process:storm-recovery",
      }),
      kind: "active-process",
      subjectId: "process:storm-recovery",
    },
  ];
}

function expectedBoundarySelection(
  base: CommittedBase,
  generation: number,
): BoundarySelection | null {
  const obligations = expectedBoundaryObligations(base, generation);
  const manifestId = id("boundary-manifest", {
    baseId: base.id,
    generation,
    obligationIds: obligations.map((obligation) => obligation.id).sort(),
  });
  const activationCandidate = base.activeInputs
    .map((input) => input.effectiveWorldTime)
    .sort((a, b) => worldTimeOrdinal(a) - worldTimeOrdinal(b))[0] ?? "T2";
  const answers: readonly BoundaryAnswer[] = obligations.map((obligation) => {
    const candidateWorldTime = obligation.kind === "activated-input"
      ? activationCandidate
      : "T2";
    return {
      id: id("boundary-answer", { obligationId: obligation.id, candidateWorldTime }),
      obligationId: obligation.id,
      kind: "candidate",
      candidateWorldTime,
    };
  });
  const effectiveWorldTime = answers
    .map((answer) => answer.candidateWorldTime)
    .filter((value): value is WorldTime => value !== null)
    .sort((a, b) => worldTimeOrdinal(a) - worldTimeOrdinal(b))[0];
  if (!effectiveWorldTime) return null;
  const completenessId = id("boundary-complete", {
    manifestId,
    answerIds: answers.map((answer) => answer.id).sort(),
  });
  const winningAnswerIds = answers
    .filter((answer) => answer.candidateWorldTime === effectiveWorldTime)
    .map((answer) => answer.id)
    .sort();
  return {
    id: id("boundary-selection", {
      completenessId,
      effectiveWorldTime,
      winningAnswerIds,
    }),
    effectiveWorldTime,
    winningAnswerIds,
  };
}

function makeAttempt(
  base: CommittedBase,
  generation: number,
  runCommitmentId: string,
): PhaseAttempt {
  const boundaryObligations = expectedBoundaryObligations(base, generation);
  const boundaryManifestId = id("boundary-manifest", {
    baseId: base.id,
    generation,
    obligationIds: boundaryObligations.map((obligation) => obligation.id).sort(),
  });

  return {
    id: id("attempt", { baseId: base.id, generation }),
    runCommitmentId,
    generation,
    mode: "boundary-open",
    boundaryManifestId,
    boundaryObligations,
    boundaryAnswers: [],
    boundaryCompletenessEvidenceId: null,
    boundarySelection: null,
    sourceManifestId: null,
    sourceFixtureBindingId: null,
    sourceObligations: [],
    sourceResults: [],
    continuationClaims: [],
    proposals: [],
    quiescenceEvidenceId: null,
    frontier: null,
    triggerProof: null,
    admission: null,
    limitReached: null,
    stagedResult: null,
    plan: null,
    candidate: null,
    bundle: null,
    emptyClosure: null,
  };
}

function createInitialState(
  options: {
    readonly budget?: number;
    readonly sourceOutcomes?: readonly FixtureSourceOutcome[];
  } = {},
): Proof01BState {
  const maximumPublishedPhases = options.budget ?? DEFAULT_CASCADE_BUDGET;
  if (!Number.isSafeInteger(maximumPublishedPhases) || maximumPublishedPhases <= 0) {
    throw new RangeError("Cascade budget must be a positive safe integer");
  }
  const base = initialBase();
  const countingVersion = "successful-receipts-v1" as const;
  const budgetId = id("cascade-budget", {
    maximumPublishedPhases,
    countingVersion,
  });
  const sourceOutcomesInput = options.sourceOutcomes ?? [
    "non-empty",
    "non-empty",
    "non-empty",
  ];
  if (sourceOutcomesInput.some(
    (outcome) => outcome !== "non-empty" && outcome !== "zero",
  )) {
    throw new TypeError("Fixture source outcomes must be exactly 'non-empty' or 'zero'");
  }
  const sourceOutcomes = [...sourceOutcomesInput] as readonly FixtureSourceOutcome[];
  if (sourceOutcomes.length === 0) {
    throw new RangeError("Fixture source outcome schedule cannot be empty");
  }
  const fixtureId = id("source-fixture", { sourceOutcomes });
  const branchId = "branch:root";
  const runId = id("run", { fixtureId, budgetId, branchId });
  const runCommitmentValue = {
    runId,
    branchId,
    budgetId,
    fixtureId,
  };
  return {
    run: {
      id: runId,
      branchId,
      status: "running",
      budget: {
        id: budgetId,
        maximumPublishedPhases,
        countingVersion,
      },
      fixture: {
        id: fixtureId,
        sourceOutcomes,
      },
    },
    runCommitment: {
      id: id("run-commitment", runCommitmentValue),
      ...runCommitmentValue,
    },
    base,
    baseActivationReceiptId: null,
    cascadeId: null,
    receipts: [],
    publishedBundles: [],
    modelLedger: [],
    emptyClosures: [],
    barrierFailures: [],
    attempt: makeAttempt(base, 1, id("run-commitment", runCommitmentValue)),
    failNextBarrier: false,
    lastAction: {
      action: "reset",
      status: "accepted",
      message: "Frozen the initial committed Base; boundary obligations are open.",
    },
  };
}

export function createProof01BSession(
  options: {
    readonly budget?: number;
    readonly sourceOutcomes?: readonly FixtureSourceOutcome[];
  } = {},
): Proof01BSession {
  const state = createInitialState(options);
  return {
    state,
    trustAnchor: new TrustAnchor(
      TRUST_ANCHOR_ISSUER,
      state.runCommitment.id,
      committedAuthorityHash(state),
    ),
  };
}

function reject(state: Proof01BState, action: string, message: string): Proof01BState {
  return {
    ...state,
    lastAction: { action, status: "rejected", message },
  };
}

function accept(state: Proof01BState, action: string, message: string): Proof01BState {
  return {
    ...state,
    lastAction: { action, status: "accepted", message },
  };
}

function runCommitmentError(state: Proof01BState): string | null {
  if (state.run.branchId !== "branch:root") return "Run branch is outside this bounded prototype.";
  if (state.run.budget.countingVersion !== "successful-receipts-v1") {
    return "Cascade Budget uses an unknown counting contract.";
  }
  const expectedBudgetId = id("cascade-budget", {
    maximumPublishedPhases: state.run.budget.maximumPublishedPhases,
    countingVersion: state.run.budget.countingVersion,
  });
  if (state.run.budget.id !== expectedBudgetId) return "Frozen cascade Budget identity is invalid.";
  const expectedFixtureId = id("source-fixture", {
    sourceOutcomes: state.run.fixture.sourceOutcomes,
  });
  if (state.run.fixture.id !== expectedFixtureId) return "Frozen source fixture identity is invalid.";
  const expectedRunId = id("run", {
    fixtureId: state.run.fixture.id,
    budgetId: state.run.budget.id,
    branchId: state.run.branchId,
  });
  if (state.run.id !== expectedRunId) {
    return "Run identity does not bind its frozen fixture and Budget.";
  }
  const expectedRunCommitment: RunCommitment = {
    id: id("run-commitment", {
      runId: state.run.id,
      branchId: state.run.branchId,
      budgetId: state.run.budget.id,
      fixtureId: state.run.fixture.id,
    }),
    runId: state.run.id,
    branchId: state.run.branchId,
    budgetId: state.run.budget.id,
    fixtureId: state.run.fixture.id,
  };
  if (!sameJson(state.runCommitment, expectedRunCommitment)) {
    return "Current Run, Budget, or fixture no longer matches the initial Run Commitment.";
  }
  return null;
}

function runControlError(state: Proof01BState): string | null {
  const commitmentError = runCommitmentError(state);
  if (commitmentError) return commitmentError;
  if (state.attempt.generation !== state.receipts.length + 1) {
    return "Current attempt generation is not contiguous with successful Receipt ancestry.";
  }
  if (state.attempt.runCommitmentId !== state.runCommitment.id) {
    return "Current attempt no longer belongs to the initially committed Run.";
  }
  if (state.attempt.id !== id("attempt", {
    baseId: state.base.id,
    generation: state.attempt.generation,
  })) return "Current attempt identity is stale or forged.";
  return receiptLineageError(state);
}

export function completedCascadeDepth(state: Proof01BState): number {
  if (!state.cascadeId) return 0;
  const receipts = state.receipts.filter(
    (receipt) => receipt.cascadeId === state.cascadeId,
  );
  for (let index = 0; index < receipts.length; index += 1) {
    if (receipts[index].position !== index + 1) return Number.NaN;
  }
  return receipts.length;
}

function receiptLineageError(state: Proof01BState): string | null {
  if (state.receipts.length !== state.publishedBundles.length) {
    return "Successful Receipt ancestry and published Bundle ledger have different lengths.";
  }
  if (state.receipts.length === 0) {
    if (state.publishedBundles.length !== 0) return "A published Bundle exists without a Receipt.";
    if (
      state.base.version !== 0 ||
      state.baseActivationReceiptId !== null ||
      !baseIdentityIsCurrent(state.base)
    ) return "Initial committed Base authority is invalid.";
    return null;
  }
  if (!state.cascadeId) return "Successful Receipts exist without a Cascade identity.";
  const seenBundles = new Set<string>();
  for (let index = 0; index < state.receipts.length; index += 1) {
    const receipt = state.receipts[index];
    const bundles = state.publishedBundles.filter((bundle) => bundle.id === receipt.bundleId);
    if (bundles.length !== 1 || seenBundles.has(receipt.bundleId)) {
      return "A successful Receipt lacks exactly one unique published Bundle.";
    }
    const bundle = bundles[0];
    seenBundles.add(bundle.id);
    const expectedBundleId = id("publication-bundle", {
      planId: bundle.planId,
      admissionId: bundle.admissionId,
      candidateBaseId: bundle.candidateBaseId,
      publishedOutputs: bundle.publishedOutputs,
    });
    if (bundle.id !== expectedBundleId) return "A published Bundle identity is invalid.";
    const { id: ignoredReceiptId, ...receiptContent } = receipt;
    const expectedReceiptId = publicationReceiptId(receiptContent);
    const admission = receipt.admission;
    const expectedAdmission: CascadeAdmission = {
      id: id("cascade-admission", {
        runId: state.run.id,
        branchId: state.run.branchId,
        budgetId: state.run.budget.id,
        cascadeId: state.cascadeId,
        frontierId: admission.frontierId,
        completedDepth: index,
        candidatePosition: index + 1,
        triggerProofId: receipt.triggerProof.id,
      }),
      runId: state.run.id,
      branchId: state.run.branchId,
      budgetId: state.run.budget.id,
      cascadeId: state.cascadeId,
      frontierId: admission.frontierId,
      completedDepth: index,
      candidatePosition: index + 1,
      triggerProofId: receipt.triggerProof.id,
    };
    if (
      receipt.id !== expectedReceiptId ||
      receipt.runCommitmentId !== state.runCommitment.id ||
      receipt.position !== index + 1 ||
      receipt.cascadeId !== state.cascadeId ||
      receipt.bundleId !== bundle.id ||
      receipt.planId !== bundle.planId ||
      receipt.admissionId !== admission.id ||
      receipt.admissionId !== bundle.admissionId ||
      !sameJson(admission, expectedAdmission) ||
      receipt.activatedBaseId !== bundle.candidateBaseId ||
      receipt.boundarySelectionId.length === 0 ||
      !sameJson(
        receipt.publishedOutputIds,
        bundle.publishedOutputs.map((output) => output.id),
      )
    ) return "A successful Receipt does not bind its exact Bundle and position.";
    const matchingContributions = receipt.modelContributionIds.flatMap((contributionId) =>
      state.modelLedger.filter((contribution) => contribution.id === contributionId)
    );
    if (
      receipt.modelContributionIds.length !== 1 ||
      matchingContributions.length !== 1
    ) return "A successful Receipt lost its exact recorded model contribution.";
    const contribution = matchingContributions[0];

    if (index === 0) {
      const proof = receipt.triggerProof;
      const rootBase = initialBase();
      const selection = expectedBoundarySelection(rootBase, 1);
      const rootActivation = proof.kind === "root"
        ? rootBase.activeInputs.find((activation) => activation.id === proof.activationId)
        : undefined;
      const expectedCascadeId = proof.kind === "root" && selection
        ? id("cascade", {
            rootBaseId: rootBase.id,
            boundarySelectionId: selection.id,
            rootActivationId: proof.activationId,
            effectiveWorldTime: selection.effectiveWorldTime,
            rootFrontierId: proof.frontierId,
          })
        : null;
      let expectedRootFrontierId: string | null = null;
      let rootContributionError: string | null = "Root publication inputs are incomplete.";
      if (selection && rootActivation) {
        const obligation: ProposalSourceObligation = {
          id: id("source-obligation", {
            baseId: rootBase.id,
            activationId: rootActivation.id,
            selectionId: selection.id,
          }),
          sourceId: `mechanism:${rootActivation.kind}`,
          activationId: rootActivation.id,
          selectedBoundaryId: selection.id,
        };
        const expectedInputFingerprint = hash({
          baseId: rootBase.id,
          world: rootBase.world,
          worldTime: rootBase.worldTime,
          selectedBoundary: selection,
          obligation,
          activation: rootActivation,
          promptPolicyVersion: PROMPT_POLICY_VERSION,
          schemaVersion: MODEL_SCHEMA_VERSION,
        });
        rootContributionError = validateContributionFingerprint(
          contribution,
          expectedInputFingerprint,
        );
        const proposal: TransitionProposal = {
          id: id("proposal", {
            baseId: rootBase.id,
            obligationId: obligation.id,
            modelContributionId: contribution.id,
            parsedFingerprint: contribution.parsedFingerprint,
          }),
          sourceObligationId: obligation.id,
          activationId: obligation.activationId,
          modelContributionId: contribution.id,
          payload: contribution.parsedOutput,
        };
        const result: ProposalSourceResult = {
          id: id("source-result", {
            obligationId: obligation.id,
            proposalIds: [proposal.id],
            contributionIds: [contribution.id],
          }),
          obligationId: obligation.id,
          kind: "proposals",
          proposalIds: [proposal.id],
          continuationClaimIds: [],
          modelContributionIds: [contribution.id],
        };
        const sourceManifestId = id("source-manifest", {
          baseId: rootBase.id,
          selectionId: selection.id,
          obligationIds: [obligation.id],
        });
        const sourceFixtureBindingId = id("source-fixture-binding", {
          baseId: rootBase.id,
          attemptId: id("attempt", { baseId: rootBase.id, generation: 1 }),
          generation: 1,
          outcome: "non-empty",
        });
        const quiescenceEvidenceId = id("frontier-quiescence", {
          sourceManifestId,
          sourceFixtureBindingId,
          resultIds: [result.id],
        });
        expectedRootFrontierId = id("frontier", {
          baseId: rootBase.id,
          selectionId: selection.id,
          quiescenceEvidenceId,
          proposalIds: [proposal.id],
        });
      }
      if (
        proof.kind !== "root" ||
        !selection ||
        !rootActivation ||
        rootContributionError !== null ||
        proof.id !== id("root-trigger", {
          kind: proof.kind,
          frontierId: proof.frontierId,
          activationId: proof.activationId,
          selectedWorldTime: proof.selectedWorldTime,
          priorWorldTime: proof.priorWorldTime,
        }) ||
        receipt.priorBaseId !== rootBase.id ||
        receipt.boundarySelectionId !== selection.id ||
        proof.frontierId !== expectedRootFrontierId ||
        proof.frontierId !== admission.frontierId ||
        proof.activationId !== rootActivation.id ||
        rootActivation.origin !== "declared-root" ||
        rootActivation.outputId !== null ||
        proof.priorWorldTime !== rootBase.worldTime ||
        proof.selectedWorldTime !== rootActivation.effectiveWorldTime ||
        proof.selectedWorldTime !== receipt.effectiveWorldTime ||
        proof.selectedWorldTime !== selection.effectiveWorldTime ||
        worldTimeOrdinal(proof.selectedWorldTime) <= worldTimeOrdinal(proof.priorWorldTime) ||
        receipt.cascadeId !== expectedCascadeId
      ) return "Root Receipt trigger proof is invalid.";
    } else {
      const predecessor = state.receipts[index - 1];
      const proof = receipt.triggerProof;
      const expectedActivatedInputId = proof.kind === "successor"
        ? id("activation", {
            outputId: proof.publishedOutputId,
            producerPlanId: predecessor.planId,
            effectiveWorldTime: predecessor.effectiveWorldTime,
          })
        : null;
      if (
        proof.kind !== "successor" ||
        proof.id !== id("successor-trigger", {
          kind: proof.kind,
          predecessorReceiptId: proof.predecessorReceiptId,
          predecessorBundleId: proof.predecessorBundleId,
          publishedOutputId: proof.publishedOutputId,
          activatedInputId: proof.activatedInputId,
          activatedBaseId: proof.activatedBaseId,
        }) ||
        receipt.priorBaseId !== predecessor.activatedBaseId ||
        proof.predecessorReceiptId !== predecessor.id ||
        proof.predecessorBundleId !== predecessor.bundleId ||
        proof.activatedBaseId !== receipt.priorBaseId ||
        !predecessor.publishedOutputIds.includes(proof.publishedOutputId) ||
        proof.activatedInputId !== expectedActivatedInputId ||
        receipt.effectiveWorldTime !== predecessor.effectiveWorldTime
      ) return "Same-time successor Receipt lost its immediate predecessor output witness.";
    }
  }
  const latest = state.receipts.at(-1);
  const latestBundle = latest
    ? state.publishedBundles.find((bundle) => bundle.id === latest.bundleId)
    : undefined;
  const expectedLatestInputs = latest && latestBundle
    ? latestBundle.publishedOutputs.map((output) => ({
        id: id("activation", {
          outputId: output.id,
          producerPlanId: latest.planId,
          effectiveWorldTime: latest.effectiveWorldTime,
        }),
        kind: output.kind,
        effectiveWorldTime: latest.effectiveWorldTime,
        origin: "published-output" as const,
        outputId: output.id,
        producerPlanId: latest.planId,
      }))
    : [];
  if (
    !latest ||
    !latestBundle ||
    state.baseActivationReceiptId !== latest.id ||
    state.base.id !== latest.activatedBaseId ||
    state.base.version !== state.receipts.length ||
    state.base.parentBaseId !== latest.priorBaseId ||
    state.base.worldTime !== latest.effectiveWorldTime ||
    !sameJson(state.base.activeInputs, expectedLatestInputs) ||
    !baseIdentityIsCurrent(state.base)
  ) return "Latest successful Receipt no longer activates the exact committed Base.";
  return null;
}

export function committedAuthorityHash(state: Proof01BState): string {
  return hash({
    runCommitment: state.runCommitment,
    base: state.base,
    baseActivationReceiptId: state.baseActivationReceiptId,
    receipts: state.receipts,
    publishedBundles: state.publishedBundles,
  });
}

function boundaryLayerError(
  state: Proof01BState,
  requireComplete: boolean,
): string | null {
  if (!baseIdentityIsCurrent(state.base)) {
    return "Committed Base content no longer matches its identity.";
  }
  const expectedObligations = expectedBoundaryObligations(
    state.base,
    state.attempt.generation,
  );
  if (!sameJson(state.attempt.boundaryObligations, expectedObligations)) {
    return "Boundary Source Manifest obligations no longer derive exhaustively from the Base.";
  }
  const expectedManifestId = id("boundary-manifest", {
    baseId: state.base.id,
    generation: state.attempt.generation,
    obligationIds: expectedObligations.map((obligation) => obligation.id).sort(),
  });
  if (state.attempt.boundaryManifestId !== expectedManifestId) {
    return "Boundary Source Manifest identity is stale or forged.";
  }
  if (!requireComplete) return null;

  const activationCandidate = state.base.activeInputs
    .map((input) => input.effectiveWorldTime)
    .sort((a, b) => worldTimeOrdinal(a) - worldTimeOrdinal(b))[0] ?? "T2";
  const expectedAnswers: readonly BoundaryAnswer[] = expectedObligations.map(
    (obligation) => {
      const candidateWorldTime = obligation.kind === "activated-input"
        ? activationCandidate
        : "T2";
      return {
        id: id("boundary-answer", {
          obligationId: obligation.id,
          candidateWorldTime,
        }),
        obligationId: obligation.id,
        kind: "candidate",
        candidateWorldTime,
      };
    },
  );
  if (
    !exactCoverage(expectedObligations, state.attempt.boundaryAnswers) ||
    !sameJson(state.attempt.boundaryAnswers, expectedAnswers)
  ) {
    return "Boundary answers are missing, duplicated, reordered, or not canonical for this Base.";
  }
  const completenessId = id("boundary-complete", {
    manifestId: expectedManifestId,
    answerIds: expectedAnswers.map((answer) => answer.id).sort(),
  });
  if (state.attempt.boundaryCompletenessEvidenceId !== completenessId) {
    return "Boundary Completeness Evidence identity is stale or forged.";
  }
  const effectiveWorldTime = expectedAnswers
    .map((answer) => answer.candidateWorldTime)
    .filter((value): value is WorldTime => value !== null)
    .sort((a, b) => worldTimeOrdinal(a) - worldTimeOrdinal(b))[0];
  if (!effectiveWorldTime) return "Complete boundary answers contain no candidate time.";
  const winningAnswerIds = expectedAnswers
    .filter((answer) => answer.candidateWorldTime === effectiveWorldTime)
    .map((answer) => answer.id)
    .sort();
  const expectedSelection: BoundarySelection = {
    id: id("boundary-selection", {
      completenessId,
      effectiveWorldTime,
      winningAnswerIds,
    }),
    effectiveWorldTime,
    winningAnswerIds,
  };
  if (!sameJson(state.attempt.boundarySelection, expectedSelection)) {
    return "Boundary Selection is not the canonical outcome of complete answers.";
  }
  const expectedSourceObligations: readonly ProposalSourceObligation[] = state.base.activeInputs
    .filter((input) => input.effectiveWorldTime === effectiveWorldTime)
    .map((input) => ({
      id: id("source-obligation", {
        baseId: state.base.id,
        activationId: input.id,
        selectionId: expectedSelection.id,
      }),
      sourceId: `mechanism:${input.kind}`,
      activationId: input.id,
      selectedBoundaryId: expectedSelection.id,
    }));
  if (!sameJson(state.attempt.sourceObligations, expectedSourceObligations)) {
    return "Proposal Source obligations no longer derive from the selected Base inputs.";
  }
  if (expectedSourceObligations.length === 0) {
    return state.attempt.sourceManifestId === null
      ? null
      : "A later unmodeled Process boundary cannot forge a Proposal Source Manifest.";
  }
  const expectedSourceManifestId = id("source-manifest", {
    baseId: state.base.id,
    selectionId: expectedSelection.id,
    obligationIds: expectedSourceObligations.map((obligation) => obligation.id).sort(),
  });
  return state.attempt.sourceManifestId === expectedSourceManifestId
    ? null
    : "Proposal Source Manifest identity is stale or forged.";
}

function completeBoundaryAccounting(state: Proof01BState): Proof01BState {
  const controlError = runControlError(state);
  if (controlError) return reject(state, "complete-boundary", controlError);
  if (state.run.status !== "running" || state.attempt.mode !== "boundary-open") {
    return reject(
      state,
      "complete-boundary",
      "Boundary accounting is legal only on a running boundary-open attempt.",
    );
  }
  const manifestError = boundaryLayerError(state, false);
  if (manifestError) return reject(state, "complete-boundary", manifestError);

  const activationCandidate = state.base.activeInputs
    .map((input) => input.effectiveWorldTime)
    .sort((a, b) => worldTimeOrdinal(a) - worldTimeOrdinal(b))[0] ?? "T2";
  const answers: readonly BoundaryAnswer[] = state.attempt.boundaryObligations.map(
    (obligation) => {
      const candidateWorldTime = obligation.kind === "activated-input"
        ? activationCandidate
        : "T2";
      return {
        id: id("boundary-answer", {
          obligationId: obligation.id,
          candidateWorldTime,
        }),
        obligationId: obligation.id,
        kind: "candidate",
        candidateWorldTime,
      };
    },
  );
  const effectiveWorldTime = answers
    .map((answer) => answer.candidateWorldTime)
    .filter((value): value is WorldTime => value !== null)
    .sort((a, b) => worldTimeOrdinal(a) - worldTimeOrdinal(b))[0];
  if (!effectiveWorldTime) {
    return reject(state, "complete-boundary", "No boundary candidate exists.");
  }
  const winningAnswerIds = answers
    .filter((answer) => answer.candidateWorldTime === effectiveWorldTime)
    .map((answer) => answer.id)
    .sort();
  const completenessId = id("boundary-complete", {
    manifestId: state.attempt.boundaryManifestId,
    answerIds: answers.map((answer) => answer.id).sort(),
  });
  const selection: BoundarySelection = {
    id: id("boundary-selection", {
      completenessId,
      effectiveWorldTime,
      winningAnswerIds,
    }),
    effectiveWorldTime,
    winningAnswerIds,
  };
  const eligibleInputs = state.base.activeInputs.filter(
    (input) => input.effectiveWorldTime === effectiveWorldTime,
  );
  const sourceObligations: readonly ProposalSourceObligation[] = eligibleInputs.map(
    (input) => ({
      id: id("source-obligation", {
        baseId: state.base.id,
        activationId: input.id,
        selectionId: selection.id,
      }),
      sourceId: `mechanism:${input.kind}`,
      activationId: input.id,
      selectedBoundaryId: selection.id,
    }),
  );
  if (sourceObligations.length === 0) {
    return accept({
      ...state,
      attempt: {
        ...state.attempt,
        mode: "later-boundary-unmodeled",
        boundaryAnswers: answers,
        boundaryCompletenessEvidenceId: completenessId,
        boundarySelection: selection,
      },
    }, "complete-boundary", `Answered ${answers.length}/${state.attempt.boundaryObligations.length} boundary obligations and selected ${effectiveWorldTime}; the later Process source is outside this same-time prototype.`);
  }
  const sourceManifestId = id("source-manifest", {
    baseId: state.base.id,
    selectionId: selection.id,
    obligationIds: sourceObligations.map((obligation) => obligation.id).sort(),
  });

  return accept({
    ...state,
    attempt: {
      ...state.attempt,
      mode: "source-collection",
      boundaryAnswers: answers,
      boundaryCompletenessEvidenceId: completenessId,
      boundarySelection: selection,
      sourceManifestId,
      sourceObligations,
    },
  }, "complete-boundary", `Answered ${answers.length}/${state.attempt.boundaryObligations.length} boundary obligations and selected ${effectiveWorldTime}.`);
}

function payloadForActivation(
  activation: CausalInputActivation,
): ModelProposalPayload {
  switch (activation.kind) {
    case "storm-front":
      return {
        proposalKind: "close-road",
        summary: "Floodwater closes the only supply road.",
        rationale: "The declared storm reaches the exposed pass.",
        patch: { roadOpen: false, councilAlerted: null, watchLevelDelta: 0 },
        worldCausalOutput: {
          kind: "road-blocked",
          summary: "The supply road is now blocked by floodwater.",
        },
      };
    case "road-blocked":
      return {
        proposalKind: "alert-council",
        summary: "The town watch carries the road alarm to the council.",
        rationale: "The newly blocked road activates the watch's reporting duty.",
        patch: { roadOpen: null, councilAlerted: true, watchLevelDelta: 0 },
        worldCausalOutput: {
          kind: "council-alerted",
          summary: "The council receives the verified road-closure alarm.",
        },
      };
    case "council-alerted":
      return {
        proposalKind: "mobilize-watch",
        summary: "The council asks the watch to secure the market approaches.",
        rationale: "The verified alarm creates an immediate public-order concern.",
        patch: { roadOpen: null, councilAlerted: null, watchLevelDelta: 1 },
        worldCausalOutput: {
          kind: "watch-mobilized",
          summary: "A reinforced watch is mobilized around the market.",
        },
      };
    case "watch-mobilized":
      return {
        proposalKind: "hold-watch",
        summary: "The reinforced watch holds its posts.",
        rationale: "No new disturbance has yet displaced the standing order.",
        patch: { roadOpen: null, councilAlerted: null, watchLevelDelta: 0 },
        worldCausalOutput: null,
      };
  }
}

function expectedModelInputFingerprint(
  state: Proof01BState,
  obligation: ProposalSourceObligation,
): string {
  const activation = state.base.activeInputs.find(
    (candidate) => candidate.id === obligation.activationId,
  );
  return hash({
    baseId: state.base.id,
    world: state.base.world,
    worldTime: state.base.worldTime,
    selectedBoundary: state.attempt.boundarySelection,
    obligation,
    activation,
    promptPolicyVersion: PROMPT_POLICY_VERSION,
    schemaVersion: MODEL_SCHEMA_VERSION,
  });
}

function createFixtureContribution(
  state: Proof01BState,
  obligation: ProposalSourceObligation,
): RecordedModelContribution {
  const activation = state.base.activeInputs.find(
    (candidate) => candidate.id === obligation.activationId,
  );
  if (!activation) throw new RangeError("Source obligation lost its activation");
  const parsedOutput = payloadForActivation(activation);
  const rawOutput = stableStringify(parsedOutput);
  const inputFingerprint = expectedModelInputFingerprint(state, obligation);
  const identity = {
    modelId: MODEL_ID,
    promptPolicyVersion: PROMPT_POLICY_VERSION,
    schemaVersion: MODEL_SCHEMA_VERSION,
    inputFingerprint,
    rawFingerprint: hash(rawOutput),
    parsedFingerprint: hash(parsedOutput),
  };
  return {
    id: id("model-contribution", identity),
    ...identity,
    modelId: MODEL_ID,
    promptPolicyVersion: PROMPT_POLICY_VERSION,
    schemaVersion: MODEL_SCHEMA_VERSION,
    rawOutput,
    parsedOutput,
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function modelPayloadError(value: unknown): string | null {
  const payload = recordValue(value);
  if (!payload) return "Parsed model payload must be an object.";
  const proposalKinds = new Set(["close-road", "alert-council", "mobilize-watch", "hold-watch"]);
  if (!proposalKinds.has(String(payload.proposalKind))) return "Model proposalKind is outside the schema enum.";
  if (typeof payload.summary !== "string" || payload.summary.length === 0) {
    return "Model summary must be a non-empty string.";
  }
  if (typeof payload.rationale !== "string" || payload.rationale.length === 0) {
    return "Model rationale must be a non-empty string.";
  }
  const patch = recordValue(payload.patch);
  if (!patch) return "Model patch must be an object.";
  if (patch.roadOpen !== null && typeof patch.roadOpen !== "boolean") {
    return "Model patch.roadOpen must be boolean or null.";
  }
  if (patch.councilAlerted !== null && typeof patch.councilAlerted !== "boolean") {
    return "Model patch.councilAlerted must be boolean or null.";
  }
  if (
    typeof patch.watchLevelDelta !== "number" ||
    !Number.isSafeInteger(patch.watchLevelDelta) ||
    Math.abs(patch.watchLevelDelta) > 1
  ) return "Model patch.watchLevelDelta must be a safe integer in [-1, 1].";
  if (payload.worldCausalOutput === null) return null;
  const output = recordValue(payload.worldCausalOutput);
  if (!output) return "Model worldCausalOutput must be an object or null.";
  const outputKinds = new Set(["storm-front", "road-blocked", "council-alerted", "watch-mobilized"]);
  if (!outputKinds.has(String(output.kind))) return "Model worldCausalOutput.kind is outside the schema enum.";
  return typeof output.summary === "string" && output.summary.length > 0
    ? null
    : "Model worldCausalOutput.summary must be a non-empty string.";
}

function validateRecordedContribution(
  state: Proof01BState,
  obligation: ProposalSourceObligation,
  contribution: RecordedModelContribution,
): string | null {
  return validateContributionFingerprint(
    contribution,
    expectedModelInputFingerprint(state, obligation),
  );
}

function validateContributionFingerprint(
  contribution: RecordedModelContribution,
  expectedInputFingerprint: string,
): string | null {
  if (
    contribution.modelId !== MODEL_ID ||
    contribution.promptPolicyVersion !== PROMPT_POLICY_VERSION ||
    contribution.schemaVersion !== MODEL_SCHEMA_VERSION
  ) {
    return "Recorded contribution uses a different model, prompt, or schema contract.";
  }
  if (contribution.inputFingerprint !== expectedInputFingerprint) {
    return "Recorded contribution does not bind the current Base and source obligation.";
  }
  if (hash(contribution.rawOutput) !== contribution.rawFingerprint) {
    return "Recorded contribution raw fingerprint is invalid.";
  }
  if (hash(contribution.parsedOutput) !== contribution.parsedFingerprint) {
    return "Recorded contribution parsed fingerprint is invalid.";
  }
  const payloadError = modelPayloadError(contribution.parsedOutput);
  if (payloadError) return payloadError;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contribution.rawOutput);
  } catch {
    return "Recorded contribution raw output is not valid JSON.";
  }
  if (hash(parsed) !== contribution.parsedFingerprint) {
    return "Recorded raw and parsed model outputs disagree.";
  }
  const expectedId = id("model-contribution", {
    modelId: contribution.modelId,
    promptPolicyVersion: contribution.promptPolicyVersion,
    schemaVersion: contribution.schemaVersion,
    inputFingerprint: contribution.inputFingerprint,
    rawFingerprint: contribution.rawFingerprint,
    parsedFingerprint: contribution.parsedFingerprint,
  });
  return expectedId === contribution.id ? null : "Recorded contribution identity is invalid.";
}

function rootTriggerProof(
  state: Proof01BState,
  frontier: CausalFrontier,
): RootTriggerProof | null {
  const selection = state.attempt.boundarySelection;
  const activation = state.base.activeInputs.find(
    (input) => input.origin === "declared-root" &&
      input.effectiveWorldTime === selection?.effectiveWorldTime,
  );
  if (
    !selection ||
    !activation ||
    worldTimeOrdinal(selection.effectiveWorldTime) <= worldTimeOrdinal(state.base.worldTime)
  ) return null;
  const value = {
    kind: "root" as const,
    frontierId: frontier.id,
    activationId: activation.id,
    selectedWorldTime: selection.effectiveWorldTime,
    priorWorldTime: state.base.worldTime,
  };
  return { id: id("root-trigger", value), ...value };
}

function successorTriggerProof(
  state: Proof01BState,
): SuccessorTriggerProof | null {
  const selection = state.attempt.boundarySelection;
  const receipt = state.receipts.at(-1);
  if (
    !selection ||
    !receipt ||
    !state.cascadeId ||
    receipt.cascadeId !== state.cascadeId ||
    receipt.activatedBaseId !== state.base.id ||
    state.baseActivationReceiptId !== receipt.id ||
    receipt.effectiveWorldTime !== selection.effectiveWorldTime ||
    state.base.worldTime !== selection.effectiveWorldTime
  ) return null;
  const activation = state.base.activeInputs.find(
    (input) => input.origin === "published-output" &&
      input.outputId !== null &&
      input.producerPlanId === receipt.planId &&
      receipt.publishedOutputIds.includes(input.outputId),
  );
  if (!activation || !activation.outputId) return null;
  const value = {
    kind: "successor" as const,
    predecessorReceiptId: receipt.id,
    predecessorBundleId: receipt.bundleId,
    publishedOutputId: activation.outputId,
    activatedInputId: activation.id,
    activatedBaseId: state.base.id,
  };
  return { id: id("successor-trigger", value), ...value };
}

function collectNonEmpty(
  state: Proof01BState,
  sourceFixtureBindingId: string,
  recordedContribution?: RecordedModelContribution,
): Proof01BState {
  const obligation = state.attempt.sourceObligations[0];
  if (!obligation || state.attempt.sourceObligations.length !== 1) {
    return reject(
      state,
      "collect-non-empty",
      "This bounded fixture expects exactly one current Proposal source obligation.",
    );
  }
  const contribution = recordedContribution ?? createFixtureContribution(state, obligation);
  const contributionError = validateRecordedContribution(state, obligation, contribution);
  if (contributionError) {
    return reject(state, "collect-non-empty", contributionError);
  }
  const proposal: TransitionProposal = {
    id: id("proposal", {
      baseId: state.base.id,
      obligationId: obligation.id,
      modelContributionId: contribution.id,
      parsedFingerprint: contribution.parsedFingerprint,
    }),
    sourceObligationId: obligation.id,
    activationId: obligation.activationId,
    modelContributionId: contribution.id,
    payload: contribution.parsedOutput,
  };
  const result: ProposalSourceResult = {
    id: id("source-result", {
      obligationId: obligation.id,
      proposalIds: [proposal.id],
      contributionIds: [contribution.id],
    }),
    obligationId: obligation.id,
    kind: "proposals",
    proposalIds: [proposal.id],
    continuationClaimIds: [],
    modelContributionIds: [contribution.id],
  };
  const quiescenceEvidenceId = id("frontier-quiescence", {
    sourceManifestId: state.attempt.sourceManifestId,
    sourceFixtureBindingId,
    resultIds: [result.id],
  });
  const frontier: CausalFrontier = {
    id: id("frontier", {
      baseId: state.base.id,
      selectionId: state.attempt.boundarySelection?.id,
      quiescenceEvidenceId,
      proposalIds: [proposal.id],
    }),
    kind: "non-empty",
    proposalIds: [proposal.id],
    resultIds: [result.id],
  };
  const triggerProof = state.cascadeId
    ? successorTriggerProof(state)
    : rootTriggerProof(state, frontier);
  const cascadeId = state.cascadeId ?? (triggerProof?.kind === "root"
    ? id("cascade", {
        rootBaseId: state.base.id,
        boundarySelectionId: state.attempt.boundarySelection?.id,
        rootActivationId: triggerProof.activationId,
        effectiveWorldTime: triggerProof.selectedWorldTime,
        rootFrontierId: frontier.id,
      })
    : null);

  return accept({
    ...state,
    cascadeId,
    modelLedger: [...state.modelLedger, contribution],
    attempt: {
      ...state.attempt,
      mode: "frontier-frozen",
      sourceFixtureBindingId,
      sourceResults: [result],
      proposals: [proposal],
      quiescenceEvidenceId,
      frontier,
      triggerProof,
    },
  }, "collect-non-empty", `Collected 1/1 source Results and froze Frontier ${frontier.id}.`);
}

function collectZero(
  state: Proof01BState,
  sourceFixtureBindingId: string,
): Proof01BState {
  const claims = state.attempt.sourceObligations.map((obligation) => ({
    id: id("continuation-claim", {
      obligationId: obligation.id,
      activationId: obligation.activationId,
      branch: "exhaust-current-activation",
    }),
    sourceObligationId: obligation.id,
    activationId: obligation.activationId,
    branch: "exhaust-current-activation" as const,
    applied: false as const,
  }));
  const results = state.attempt.sourceObligations.map((obligation) => {
    const claim = claims.find(
      (candidate) => candidate.sourceObligationId === obligation.id,
    );
    if (!claim) throw new RangeError("Zero Result lost its continuation Claim");
    return {
      id: id("source-result", {
        obligationId: obligation.id,
        kind: "no-proposal",
        claimId: claim.id,
      }),
      obligationId: obligation.id,
      kind: "no-proposal" as const,
      proposalIds: [],
      continuationClaimIds: [claim.id],
      modelContributionIds: [],
    };
  });
  const quiescenceEvidenceId = id("frontier-quiescence", {
    sourceManifestId: state.attempt.sourceManifestId,
    sourceFixtureBindingId,
    resultIds: results.map((result) => result.id).sort(),
    claimIds: claims.map((claim) => claim.id).sort(),
  });
  const frontier: CausalFrontier = {
    id: id("frontier", {
      baseId: state.base.id,
      selectionId: state.attempt.boundarySelection?.id,
      quiescenceEvidenceId,
      proposalIds: [],
    }),
    kind: "zero",
    proposalIds: [],
    resultIds: results.map((result) => result.id),
  };
  const closure: EmptyFrontierClosure = {
    id: id("empty-closure", {
      baseId: state.base.id,
      frontierId: frontier.id,
      claimIds: claims.map((claim) => claim.id).sort(),
      receiptIds: state.receipts.map((receipt) => receipt.id),
    }),
    baseId: state.base.id,
    baseAuthorityHash: committedAuthorityHash(state),
    worldTime: state.attempt.boundarySelection?.effectiveWorldTime ?? state.base.worldTime,
    completedDepth: completedCascadeDepth(state),
    receiptIds: state.receipts.map((receipt) => receipt.id),
    frontierId: frontier.id,
    pendingClaimIds: claims.map((claim) => claim.id),
  };

  return accept({
    ...state,
    emptyClosures: [...state.emptyClosures, closure],
    attempt: {
      ...state.attempt,
      mode: "empty-closed",
      sourceFixtureBindingId,
      sourceResults: results,
      continuationClaims: claims,
      proposals: [],
      quiescenceEvidenceId,
      frontier,
      emptyClosure: closure,
    },
  }, "collect-zero", `Collected ${results.length}/${state.attempt.sourceObligations.length} explicit No Proposal Results; this collection point closed without publication. Later-boundary scheduling is not modeled here.`);
}

function collectFrontier(
  state: Proof01BState,
  recordedContribution?: RecordedModelContribution,
): Proof01BState {
  const controlError = runControlError(state);
  if (controlError) return reject(state, "collect-frontier", controlError);
  const kind = state.run.fixture.sourceOutcomes[state.attempt.generation - 1];
  if (!kind) {
    return reject(
      state,
      "collect-frontier",
      `The frozen source fixture has no Result for attempt generation ${state.attempt.generation}.`,
    );
  }
  if (state.run.status !== "running" || state.attempt.mode !== "source-collection") {
    return reject(
      state,
      "collect-frontier",
      "Frontier collection requires complete boundary accounting and an open source collection.",
    );
  }
  const boundaryError = boundaryLayerError(state, true);
  if (boundaryError) return reject(state, "collect-frontier", boundaryError);
  const sourceFixtureBindingId = id("source-fixture-binding", {
    baseId: state.base.id,
    attemptId: state.attempt.id,
    generation: state.attempt.generation,
    outcome: kind,
  });
  switch (kind) {
    case "non-empty":
      return collectNonEmpty(state, sourceFixtureBindingId, recordedContribution);
    case "zero":
      return collectZero(state, sourceFixtureBindingId);
    default:
      return reject(state, "collect-frontier", "Unknown source Result kind; collection failed closed.");
  }
}

function admitCascade(state: Proof01BState): Proof01BState {
  const controlError = runControlError(state);
  if (controlError) return reject(state, "admit", controlError);
  const frontier = state.attempt.frontier;
  if (
    state.run.status !== "running" ||
    state.attempt.mode !== "frontier-frozen" ||
    !frontier ||
    frontier.kind !== "non-empty"
  ) {
    return reject(
      state,
      "admit",
      "Admission exists only for a frozen non-empty Frontier in a running Run.",
    );
  }
  if (!state.cascadeId || !state.attempt.triggerProof) {
    return reject(
      state,
      "admit",
      "No valid root or immediate-predecessor causal trigger proves this cascade position.",
    );
  }
  const frontierError = validateAdmissionChain(state, false);
  if (frontierError) return reject(state, "admit", frontierError);
  const completedDepth = completedCascadeDepth(state);
  if (!Number.isSafeInteger(completedDepth)) {
    return reject(state, "admit", "Successful Receipt ancestry is not contiguous.");
  }
  const candidatePosition = completedDepth + 1;
  if (candidatePosition > state.run.budget.maximumPublishedPhases) {
    const limitReached: CascadeLimitReached = {
      id: id("cascade-limit", {
        baseId: state.base.id,
        cascadeId: state.cascadeId,
        budgetId: state.run.budget.id,
        completedDepth,
        candidatePosition,
        frontierId: frontier.id,
        receiptIds: state.receipts.map((receipt) => receipt.id),
      }),
      baseId: state.base.id,
      baseAuthorityHash: committedAuthorityHash(state),
      cascadeId: state.cascadeId,
      budgetId: state.run.budget.id,
      completedDepth,
      candidatePosition,
      frontierId: frontier.id,
      receiptIds: state.receipts.map((receipt) => receipt.id),
    };
    return accept({
      ...state,
      run: { ...state.run, status: "incomplete" },
      attempt: {
        ...state.attempt,
        mode: "incomplete",
        limitReached,
      },
    }, "admit", `Position ${candidatePosition} exceeds Budget ${state.run.budget.maximumPublishedPhases}; Run stopped Incomplete before Stage 1.`);
  }
  const admission: CascadeAdmission = {
    id: id("cascade-admission", {
      runId: state.run.id,
      branchId: state.run.branchId,
      budgetId: state.run.budget.id,
      cascadeId: state.cascadeId,
      frontierId: frontier.id,
      completedDepth,
      candidatePosition,
      triggerProofId: state.attempt.triggerProof.id,
    }),
    runId: state.run.id,
    branchId: state.run.branchId,
    budgetId: state.run.budget.id,
    cascadeId: state.cascadeId,
    frontierId: frontier.id,
    completedDepth,
    candidatePosition,
    triggerProofId: state.attempt.triggerProof.id,
  };
  return accept({
    ...state,
    attempt: {
      ...state.attempt,
      mode: "admitted",
      admission,
    },
  }, "admit", `Admitted same-time cascade position ${candidatePosition}/${state.run.budget.maximumPublishedPhases}.`);
}

function applyPatch(world: WorldState, payload: ModelProposalPayload): WorldState {
  return {
    roadOpen: payload.patch.roadOpen ?? world.roadOpen,
    councilAlerted: payload.patch.councilAlerted ?? world.councilAlerted,
    watchLevel: world.watchLevel + payload.patch.watchLevelDelta,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function baseIdentityIsCurrent(base: CommittedBase): boolean {
  const expected = makeBase({
    version: base.version,
    worldTime: base.worldTime,
    phaseOrdinal: base.phaseOrdinal,
    parentBaseId: base.parentBaseId,
    world: base.world,
    history: base.history,
    activeInputs: base.activeInputs,
  });
  return expected.id === base.id;
}

/** Recompute the complete bounded pre-publication chain from its upstream data. */
function validateAdmissionChain(
  state: Proof01BState,
  requireAdmission = true,
): string | null {
  const attempt = state.attempt;
  const selection = attempt.boundarySelection;
  const frontier = attempt.frontier;
  const admission = attempt.admission;
  if (!baseIdentityIsCurrent(state.base)) return "Committed Base content no longer matches its identity.";
  const boundaryError = boundaryLayerError(state, true);
  if (boundaryError) return boundaryError;
  if (!selection || !frontier || frontier.kind !== "non-empty") {
    return "The non-empty Frontier or boundary selection is missing.";
  }
  if (state.run.fixture.sourceOutcomes[attempt.generation - 1] !== "non-empty") {
    return "The frozen Run fixture does not authorize a non-empty Result at this attempt.";
  }
  const expectedFixtureBindingId = id("source-fixture-binding", {
    baseId: state.base.id,
    attemptId: attempt.id,
    generation: attempt.generation,
    outcome: "non-empty",
  });
  if (attempt.sourceFixtureBindingId !== expectedFixtureBindingId) {
    return "The frozen source Result is not bound to this Run fixture and attempt.";
  }
  if (!exactCoverage(attempt.boundaryObligations, attempt.boundaryAnswers)) {
    return "Boundary obligation coverage is no longer exact.";
  }
  const expectedCompletenessId = id("boundary-complete", {
    manifestId: attempt.boundaryManifestId,
    answerIds: attempt.boundaryAnswers.map((answer) => answer.id).sort(),
  });
  if (attempt.boundaryCompletenessEvidenceId !== expectedCompletenessId) {
    return "Boundary completeness identity is stale or forged.";
  }
  for (const answer of attempt.boundaryAnswers) {
    const expectedAnswerId = id("boundary-answer", {
      obligationId: answer.obligationId,
      candidateWorldTime: answer.candidateWorldTime,
    });
    if (answer.id !== expectedAnswerId) return "A boundary answer identity is invalid.";
  }
  const candidateTimes = attempt.boundaryAnswers
    .map((answer) => answer.candidateWorldTime)
    .filter((value): value is WorldTime => value !== null)
    .sort((a, b) => worldTimeOrdinal(a) - worldTimeOrdinal(b));
  const expectedTime = candidateTimes[0];
  if (!expectedTime) return "Complete boundary accounting contains no candidate time.";
  const expectedWinningAnswerIds = attempt.boundaryAnswers
    .filter((answer) => answer.candidateWorldTime === expectedTime)
    .map((answer) => answer.id)
    .sort();
  const expectedSelection: BoundarySelection = {
    id: id("boundary-selection", {
      completenessId: expectedCompletenessId,
      effectiveWorldTime: expectedTime,
      winningAnswerIds: expectedWinningAnswerIds,
    }),
    effectiveWorldTime: expectedTime,
    winningAnswerIds: expectedWinningAnswerIds,
  };
  if (!sameJson(selection, expectedSelection)) return "Boundary selection is not the canonical exhaustive outcome.";

  const expectedSourceObligations: readonly ProposalSourceObligation[] = state.base.activeInputs
    .filter((input) => input.effectiveWorldTime === selection.effectiveWorldTime)
    .map((input) => ({
      id: id("source-obligation", {
        baseId: state.base.id,
        activationId: input.id,
        selectionId: selection.id,
      }),
      sourceId: `mechanism:${input.kind}`,
      activationId: input.id,
      selectedBoundaryId: selection.id,
    }));
  if (!sameJson(attempt.sourceObligations, expectedSourceObligations)) {
    return "Proposal source obligations no longer match the frozen Base and boundary.";
  }
  const expectedSourceManifestId = id("source-manifest", {
    baseId: state.base.id,
    selectionId: selection.id,
    obligationIds: expectedSourceObligations.map((obligation) => obligation.id).sort(),
  });
  if (attempt.sourceManifestId !== expectedSourceManifestId) {
    return "Proposal source manifest identity is stale or forged.";
  }
  if (!exactCoverage(attempt.sourceObligations, attempt.sourceResults)) {
    return "Proposal source Result coverage is no longer exact.";
  }
  if (attempt.sourceObligations.length !== 1 || attempt.sourceResults.length !== 1) {
    return "This bounded chain expects exactly one source obligation and Result.";
  }
  const obligation = attempt.sourceObligations[0];
  const result = attempt.sourceResults[0];
  if (
    result.kind !== "proposals" ||
    result.proposalIds.length !== 1 ||
    result.modelContributionIds.length !== 1 ||
    result.continuationClaimIds.length !== 0 ||
    attempt.proposals.length !== 1
  ) return "The non-empty source Result shape is invalid.";
  const proposal = attempt.proposals[0];
  const contributions = state.modelLedger.filter(
    (contribution) => contribution.id === result.modelContributionIds[0],
  );
  if (contributions.length !== 1) return "The exact recorded model contribution is missing or duplicated.";
  const contribution = contributions[0];
  const contributionError = validateRecordedContribution(state, obligation, contribution);
  if (contributionError) return contributionError;
  const expectedProposal: TransitionProposal = {
    id: id("proposal", {
      baseId: state.base.id,
      obligationId: obligation.id,
      modelContributionId: contribution.id,
      parsedFingerprint: contribution.parsedFingerprint,
    }),
    sourceObligationId: obligation.id,
    activationId: obligation.activationId,
    modelContributionId: contribution.id,
    payload: contribution.parsedOutput,
  };
  if (!sameJson(proposal, expectedProposal) || result.proposalIds[0] !== proposal.id) {
    return "Proposal content or identity no longer matches the recorded contribution.";
  }
  const expectedResult: ProposalSourceResult = {
    id: id("source-result", {
      obligationId: obligation.id,
      proposalIds: [proposal.id],
      contributionIds: [contribution.id],
    }),
    obligationId: obligation.id,
    kind: "proposals",
    proposalIds: [proposal.id],
    continuationClaimIds: [],
    modelContributionIds: [contribution.id],
  };
  if (!sameJson(result, expectedResult)) return "Proposal source Result content or identity is invalid.";
  const expectedQuiescenceId = id("frontier-quiescence", {
    sourceManifestId: attempt.sourceManifestId,
    sourceFixtureBindingId: expectedFixtureBindingId,
    resultIds: [result.id],
  });
  if (attempt.quiescenceEvidenceId !== expectedQuiescenceId) {
    return "Frontier Quiescence identity is stale or forged.";
  }
  const expectedFrontier: CausalFrontier = {
    id: id("frontier", {
      baseId: state.base.id,
      selectionId: selection.id,
      quiescenceEvidenceId: expectedQuiescenceId,
      proposalIds: [proposal.id],
    }),
    kind: "non-empty",
    proposalIds: [proposal.id],
    resultIds: [result.id],
  };
  if (!sameJson(frontier, expectedFrontier)) return "Frozen Frontier content or identity is invalid.";

  const completedDepth = completedCascadeDepth(state);
  const expectedTrigger = completedDepth === 0
    ? rootTriggerProof(state, frontier)
    : successorTriggerProof(state);
  if (!expectedTrigger || !sameJson(attempt.triggerProof, expectedTrigger)) {
    return "Root or immediate-predecessor trigger proof is invalid.";
  }
  if (!state.cascadeId) return "Cascade identity is missing.";
  if (completedDepth === 0) {
    const expectedCascadeId = id("cascade", {
      rootBaseId: state.base.id,
      boundarySelectionId: selection.id,
      rootActivationId: expectedTrigger.kind === "root" ? expectedTrigger.activationId : null,
      effectiveWorldTime: selection.effectiveWorldTime,
      rootFrontierId: frontier.id,
    });
    if (state.cascadeId !== expectedCascadeId) return "Root Cascade identity is invalid.";
  } else if (state.receipts.some((receipt) => receipt.cascadeId !== state.cascadeId)) {
    return "Successful Receipt ancestry changed Cascade identity.";
  }
  if (!admission) {
    return requireAdmission ? "Cascade Admission is missing." : null;
  }
  const expectedAdmission: CascadeAdmission = {
    id: id("cascade-admission", {
      runId: state.run.id,
      branchId: state.run.branchId,
      budgetId: state.run.budget.id,
      cascadeId: state.cascadeId,
      frontierId: frontier.id,
      completedDepth,
      candidatePosition: completedDepth + 1,
      triggerProofId: expectedTrigger.id,
    }),
    runId: state.run.id,
    branchId: state.run.branchId,
    budgetId: state.run.budget.id,
    cascadeId: state.cascadeId,
    frontierId: frontier.id,
    completedDepth,
    candidatePosition: completedDepth + 1,
    triggerProofId: expectedTrigger.id,
  };
  if (!sameJson(admission, expectedAdmission)) return "Cascade Admission content or identity is invalid.";
  if (admission.candidatePosition > state.run.budget.maximumPublishedPhases) {
    return "An over-budget position cannot have Admission Evidence.";
  }
  return null;
}

function validateReadyPublicationChain(state: Proof01BState): string | null {
  const admissionError = validateAdmissionChain(state);
  if (admissionError) return admissionError;
  const { admission, frontier, stagedResult, plan, candidate, bundle } = state.attempt;
  if (!admission || !frontier || !stagedResult || !plan || !candidate || !bundle) {
    return "The ready publication artifact chain is incomplete.";
  }
  let privateWorld = state.base.world;
  const eventSummaries: string[] = [];
  const outputDrafts: {
    readonly id: string;
    readonly kind: CausalInputActivation["kind"];
    readonly summary: string;
  }[] = [];
  for (const proposal of [...state.attempt.proposals].sort((a, b) => a.id.localeCompare(b.id))) {
    privateWorld = applyPatch(privateWorld, proposal.payload);
    eventSummaries.push(proposal.payload.summary);
    if (proposal.payload.worldCausalOutput) {
      outputDrafts.push({
        id: id("world-output", {
          baseId: state.base.id,
          frontierId: frontier.id,
          proposalId: proposal.id,
          output: proposal.payload.worldCausalOutput,
        }),
        ...proposal.payload.worldCausalOutput,
      });
    }
  }
  const expectedStaged: StagedPhaseResult = {
    id: id("staged-result", {
      baseId: state.base.id,
      frontierId: frontier.id,
      proposalIds: state.attempt.proposals.map((proposal) => proposal.id).sort(),
      privateWorld,
      outputIds: outputDrafts.map((output) => output.id).sort(),
    }),
    proposalIds: state.attempt.proposals.map((proposal) => proposal.id),
    basePreimageHash: hash(state.base.world),
    privateWorld,
    eventSummaries,
    outputDrafts,
  };
  if (!sameJson(stagedResult, expectedStaged)) return "Staged Result does not match the Base, Proposals, or output drafts.";
  const expectedPlan: PhasePublicationPlan = {
    id: id("publication-plan", {
      baseId: state.base.id,
      frontierId: frontier.id,
      admissionId: admission.id,
      stagedResultId: expectedStaged.id,
      resultingWorldHash: hash(privateWorld),
      outputIds: outputDrafts.map((output) => output.id).sort(),
    }),
    baseId: state.base.id,
    frontierId: frontier.id,
    admissionId: admission.id,
    stagedResultId: expectedStaged.id,
    resultingWorldHash: hash(privateWorld),
    publishedOutputIds: outputDrafts.map((output) => output.id),
  };
  if (!sameJson(plan, expectedPlan)) return "Publication Plan does not bind the exact staged result and Admission.";
  const effectiveWorldTime = state.attempt.boundarySelection?.effectiveWorldTime;
  if (!effectiveWorldTime) return "The ready chain lost its selected World Time.";
  const activeInputs: readonly CausalInputActivation[] = outputDrafts.map((output) => ({
    id: id("activation", {
      outputId: output.id,
      producerPlanId: expectedPlan.id,
      effectiveWorldTime,
    }),
    kind: output.kind,
    effectiveWorldTime,
    origin: "published-output",
    outputId: output.id,
    producerPlanId: expectedPlan.id,
  }));
  const expectedBase = makeBase({
    version: state.base.version + 1,
    worldTime: effectiveWorldTime,
    phaseOrdinal: state.base.phaseOrdinal + 1,
    parentBaseId: state.base.id,
    world: privateWorld,
    history: [
      ...state.base.history,
      ...eventSummaries.map((summary) => `${effectiveWorldTime}: ${summary}`),
    ],
    activeInputs,
  });
  const expectedCandidate: NextBaseCandidate = {
    id: id("base-candidate", { planId: expectedPlan.id, baseId: expectedBase.id }),
    base: expectedBase,
  };
  if (!sameJson(candidate, expectedCandidate)) return "Next Base Candidate content or identity is invalid.";
  const expectedBundle: PhasePublicationBundle = {
    id: id("publication-bundle", {
      planId: expectedPlan.id,
      admissionId: admission.id,
      candidateBaseId: expectedBase.id,
      publishedOutputs: outputDrafts,
    }),
    planId: expectedPlan.id,
    admissionId: admission.id,
    candidateBaseId: expectedBase.id,
    publishedOutputs: outputDrafts,
  };
  return sameJson(bundle, expectedBundle)
    ? null
    : "Publication Bundle content or identity is invalid.";
}

function preparePublication(state: Proof01BState): Proof01BState {
  const controlError = runControlError(state);
  if (controlError) return reject(state, "prepare", controlError);
  const admission = state.attempt.admission;
  const frontier = state.attempt.frontier;
  if (
    state.run.status !== "running" ||
    state.attempt.mode !== "admitted" ||
    !admission ||
    !frontier ||
    frontier.kind !== "non-empty"
  ) {
    return reject(
      state,
      "prepare",
      "Private staging requires a current non-empty Frontier and successful Admission.",
    );
  }
  const admissionError = validateAdmissionChain(state);
  if (admissionError) return reject(state, "prepare", admissionError);
  let privateWorld = state.base.world;
  const eventSummaries: string[] = [];
  const outputDrafts: {
    readonly id: string;
    readonly kind: CausalInputActivation["kind"];
    readonly summary: string;
  }[] = [];
  for (const proposal of [...state.attempt.proposals].sort((a, b) => a.id.localeCompare(b.id))) {
    privateWorld = applyPatch(privateWorld, proposal.payload);
    eventSummaries.push(proposal.payload.summary);
    if (proposal.payload.worldCausalOutput) {
      outputDrafts.push({
        id: id("world-output", {
          baseId: state.base.id,
          frontierId: frontier.id,
          proposalId: proposal.id,
          output: proposal.payload.worldCausalOutput,
        }),
        ...proposal.payload.worldCausalOutput,
      });
    }
  }
  const stagedResult: StagedPhaseResult = {
    id: id("staged-result", {
      baseId: state.base.id,
      frontierId: frontier.id,
      proposalIds: state.attempt.proposals.map((proposal) => proposal.id).sort(),
      privateWorld,
      outputIds: outputDrafts.map((output) => output.id).sort(),
    }),
    proposalIds: state.attempt.proposals.map((proposal) => proposal.id),
    basePreimageHash: hash(state.base.world),
    privateWorld,
    eventSummaries,
    outputDrafts,
  };
  const plan: PhasePublicationPlan = {
    id: id("publication-plan", {
      baseId: state.base.id,
      frontierId: frontier.id,
      admissionId: admission.id,
      stagedResultId: stagedResult.id,
      resultingWorldHash: hash(privateWorld),
      outputIds: outputDrafts.map((output) => output.id).sort(),
    }),
    baseId: state.base.id,
    frontierId: frontier.id,
    admissionId: admission.id,
    stagedResultId: stagedResult.id,
    resultingWorldHash: hash(privateWorld),
    publishedOutputIds: outputDrafts.map((output) => output.id),
  };
  const effectiveWorldTime = state.attempt.boundarySelection?.effectiveWorldTime;
  if (!effectiveWorldTime) {
    return reject(state, "prepare", "The admitted phase lost its selected World Time.");
  }
  const activeInputs: readonly CausalInputActivation[] = outputDrafts.map((output) => ({
    id: id("activation", {
      outputId: output.id,
      producerPlanId: plan.id,
      effectiveWorldTime,
    }),
    kind: output.kind,
    effectiveWorldTime,
    origin: "published-output",
    outputId: output.id,
    producerPlanId: plan.id,
  }));
  const candidateBase = makeBase({
    version: state.base.version + 1,
    worldTime: effectiveWorldTime,
    phaseOrdinal: state.base.phaseOrdinal + 1,
    parentBaseId: state.base.id,
    world: privateWorld,
    history: [
      ...state.base.history,
      ...eventSummaries.map((summary) => `${effectiveWorldTime}: ${summary}`),
    ],
    activeInputs,
  });
  const candidate: NextBaseCandidate = {
    id: id("base-candidate", { planId: plan.id, baseId: candidateBase.id }),
    base: candidateBase,
  };
  const bundle: PhasePublicationBundle = {
    id: id("publication-bundle", {
      planId: plan.id,
      admissionId: admission.id,
      candidateBaseId: candidateBase.id,
      publishedOutputs: outputDrafts,
    }),
    planId: plan.id,
    admissionId: admission.id,
    candidateBaseId: candidateBase.id,
    publishedOutputs: outputDrafts,
  };
  return accept({
    ...state,
    attempt: {
      ...state.attempt,
      mode: "ready",
      stagedResult,
      plan,
      candidate,
      bundle,
    },
  }, "prepare", `Prepared private Plan and Bundle for position ${admission.candidatePosition}; committed Base is still unchanged.`);
}

function armBarrierFailure(state: Proof01BState): Proof01BState {
  const controlError = runControlError(state);
  if (controlError) return reject(state, "arm-barrier-failure", controlError);
  if (state.run.status !== "running" || state.attempt.mode !== "ready") {
    return reject(
      state,
      "arm-barrier-failure",
      "A barrier failure can be armed only for a ready unpublished Bundle.",
    );
  }
  return accept({
    ...state,
    failNextBarrier: true,
  }, "arm-barrier-failure", "The next publication barrier attempt will fail before authority changes.");
}

function publish(state: Proof01BState): Proof01BState {
  const controlError = runControlError(state);
  if (controlError) return reject(state, "publish", controlError);
  const { admission, candidate, bundle, plan, triggerProof, boundarySelection } = state.attempt;
  if (
    state.run.status !== "running" ||
    state.attempt.mode !== "ready" ||
    !admission ||
    !candidate ||
    !bundle ||
    !plan ||
    !triggerProof ||
    !boundarySelection
  ) {
    return reject(
      state,
      "publish",
      "Atomic publication requires the exact ready Admission, Plan, Candidate, Bundle, and trigger proof.",
    );
  }
  const chainError = validateReadyPublicationChain(state);
  if (chainError) {
    return reject(state, "publish", `Barrier rejected the artifact chain: ${chainError}`);
  }
  if (state.failNextBarrier) {
    const failure: BarrierFailure = {
      id: id("barrier-failure", {
        bundleId: bundle.id,
        attempt: state.barrierFailures.filter((item) => item.bundleId === bundle.id).length + 1,
      }),
      bundleId: bundle.id,
      baseId: state.base.id,
      baseAuthorityHash: committedAuthorityHash(state),
      completedDepth: completedCascadeDepth(state),
      receiptCount: state.receipts.length,
    };
    return {
      ...state,
      failNextBarrier: false,
      barrierFailures: [...state.barrierFailures, failure],
      lastAction: {
        action: "publish",
        status: "barrier-failed",
        message: "Injected barrier failure: Bundle remains ready; Base, World, Receipt ancestry, and depth did not change.",
      },
    };
  }
  if (
    admission.completedDepth !== completedCascadeDepth(state) ||
    admission.candidatePosition !== completedCascadeDepth(state) + 1 ||
    plan.baseId !== state.base.id ||
    bundle.candidateBaseId !== candidate.base.id
  ) {
    return reject(state, "publish", "Barrier currentness check failed; nothing was published.");
  }
  const receiptContent: PhasePublicationReceiptContent = {
    runCommitmentId: state.runCommitment.id,
    cascadeId: admission.cascadeId,
    position: admission.candidatePosition,
    priorBaseId: state.base.id,
    activatedBaseId: candidate.base.id,
    effectiveWorldTime: candidate.base.worldTime,
    boundarySelectionId: boundarySelection.id,
    planId: plan.id,
    bundleId: bundle.id,
    admissionId: admission.id,
    admission,
    triggerProof,
    publishedOutputIds: bundle.publishedOutputs.map((output) => output.id),
    modelContributionIds: state.attempt.proposals.map(
      (proposal) => proposal.modelContributionId,
    ),
  };
  const receipt: PhasePublicationReceipt = {
    id: publicationReceiptId(receiptContent),
    ...receiptContent,
  };
  const nextAttempt = makeAttempt(
    candidate.base,
    state.attempt.generation + 1,
    state.runCommitment.id,
  );
  return accept({
    ...state,
    base: candidate.base,
    baseActivationReceiptId: receipt.id,
    receipts: [...state.receipts, receipt],
    publishedBundles: [...state.publishedBundles, bundle],
    attempt: nextAttempt,
    failNextBarrier: false,
  }, "publish", `Atomically published Receipt ${receipt.id}; next Base activated at ${candidate.base.worldTime}.`);
}

export function applyAction(
  session: Proof01BSession,
  action: Proof01BAction,
): Proof01BSession {
  const { state, trustAnchor } = session;
  let hasIssuedAnchor = false;
  try {
    hasIssuedAnchor = trustAnchor instanceof TrustAnchor &&
      ISSUED_TRUST_ANCHORS.has(trustAnchor) &&
      trustAnchor.isIssuedByProof01B();
  } catch {
    hasIssuedAnchor = false;
  }
  if (!hasIssuedAnchor) {
    return {
      ...session,
      state: reject(
        state,
        action.type,
        "This transition lacks a module-issued external authority anchor.",
      ),
    };
  }
  if (
    trustAnchor.runCommitmentId !== state.runCommitment.id ||
    trustAnchor.committedAuthorityHash !== committedAuthorityHash(state)
  ) {
    return {
      ...session,
      state: reject(
        state,
        action.type,
        "Candidate state does not match the external Run/committed-authority anchor.",
      ),
    };
  }
  let nextState: Proof01BState;
  switch (action.type) {
    case "complete-boundary":
      nextState = completeBoundaryAccounting(state);
      break;
    case "collect-frontier":
      nextState = collectFrontier(state, action.recordedContribution);
      break;
    case "admit":
      nextState = admitCascade(state);
      break;
    case "prepare":
      nextState = preparePublication(state);
      break;
    case "arm-barrier-failure":
      nextState = armBarrierFailure(state);
      break;
    case "publish":
      nextState = publish(state);
      break;
  }
  const nextAuthorityHash = committedAuthorityHash(nextState);
  if (nextAuthorityHash === trustAnchor.committedAuthorityHash) {
    return { state: nextState, trustAnchor };
  }
  if (
    nextState.lastAction.action !== "publish" ||
    nextState.lastAction.status !== "accepted"
  ) {
    return {
      state: reject(
        state,
        action.type,
        "A non-publication transition attempted to replace committed authority.",
      ),
      trustAnchor,
    };
  }
  return {
    state: nextState,
    trustAnchor: new TrustAnchor(
      TRUST_ANCHOR_ISSUER,
      nextState.runCommitment.id,
      nextAuthorityHash,
    ),
  };
}

export function describeWorld(world: WorldState): string {
  const road = world.roadOpen ? "road open" : "road blocked";
  const council = world.councilAlerted ? "council alerted" : "council unaware";
  return `${road}; ${council}; watch level ${world.watchLevel}`;
}

function exactCoverage(
  obligations: readonly { readonly id: string }[],
  answers: readonly { readonly obligationId: string }[],
): boolean {
  const expected = obligations.map((obligation) => obligation.id).sort();
  const actual = answers.map((answer) => answer.obligationId).sort();
  return expected.length === actual.length &&
    expected.every((value, index) => value === actual[index]) &&
    new Set(actual).size === actual.length;
}

export function inspectInvariants(state: Proof01BState): readonly InvariantCheck[] {
  const attempt = state.attempt;
  const runCommitmentFailure = runCommitmentError(state);
  const boundaryComplete = exactCoverage(
    attempt.boundaryObligations,
    attempt.boundaryAnswers,
  ) && Boolean(attempt.boundaryCompletenessEvidenceId && attempt.boundarySelection);
  const sourceComplete = exactCoverage(attempt.sourceObligations, attempt.sourceResults);
  const nonEmptyChainValid = attempt.frontier?.kind === "non-empty"
    ? validateAdmissionChain(state, Boolean(attempt.admission)) === null
    : true;
  const frontierLegal = !attempt.frontier ||
    (boundaryComplete && sourceComplete && Boolean(attempt.quiescenceEvidenceId) &&
      nonEmptyChainValid);
  const downstreamExists = Boolean(
    attempt.admission || attempt.stagedResult || attempt.plan || attempt.candidate || attempt.bundle,
  );
  const expectedZeroFixtureBindingId = id("source-fixture-binding", {
    baseId: state.base.id,
    attemptId: attempt.id,
    generation: attempt.generation,
    outcome: "zero",
  });
  const emptyClaimCoverage = attempt.sourceObligations.every((obligation) => {
    const results = attempt.sourceResults.filter(
      (result) => result.obligationId === obligation.id,
    );
    if (results.length !== 1 || results[0].kind !== "no-proposal") return false;
    const claims = attempt.continuationClaims.filter(
      (claim) => claim.sourceObligationId === obligation.id,
    );
    return claims.length === 1 &&
      claims[0].activationId === obligation.activationId &&
      !claims[0].applied &&
      claims[0].id === id("continuation-claim", {
        obligationId: obligation.id,
        activationId: obligation.activationId,
        branch: "exhaust-current-activation",
      }) &&
      results[0].id === id("source-result", {
        obligationId: obligation.id,
        kind: "no-proposal",
        claimId: claims[0].id,
      }) &&
      sameJson(results[0].continuationClaimIds, [claims[0].id]);
  }) && attempt.continuationClaims.length === attempt.sourceObligations.length;
  const expectedZeroQuiescenceId = id("frontier-quiescence", {
    sourceManifestId: attempt.sourceManifestId,
    sourceFixtureBindingId: expectedZeroFixtureBindingId,
    resultIds: attempt.sourceResults.map((result) => result.id).sort(),
    claimIds: attempt.continuationClaims.map((claim) => claim.id).sort(),
  });
  const zeroChainValid = attempt.frontier?.kind !== "zero" || (
    state.run.fixture.sourceOutcomes[attempt.generation - 1] === "zero" &&
    attempt.sourceFixtureBindingId === expectedZeroFixtureBindingId &&
    attempt.quiescenceEvidenceId === expectedZeroQuiescenceId &&
    attempt.frontier.id === id("frontier", {
      baseId: state.base.id,
      selectionId: attempt.boundarySelection?.id,
      quiescenceEvidenceId: expectedZeroQuiescenceId,
      proposalIds: [],
    })
  );
  const emptyLegal = !attempt.emptyClosure || (
    attempt.frontier?.kind === "zero" &&
    !downstreamExists &&
    emptyClaimCoverage &&
    zeroChainValid &&
    state.base.id === attempt.emptyClosure.baseId &&
    committedAuthorityHash(state) === attempt.emptyClosure.baseAuthorityHash &&
    completedCascadeDepth(state) === attempt.emptyClosure.completedDepth &&
    attempt.emptyClosure.worldTime === attempt.boundarySelection?.effectiveWorldTime &&
    sameJson(
      attempt.emptyClosure.receiptIds,
      state.receipts.map((receipt) => receipt.id),
    )
  );
  const limitLegal = !attempt.limitReached || (
    attempt.frontier?.kind === "non-empty" &&
    attempt.limitReached.candidatePosition ===
      state.run.budget.maximumPublishedPhases + 1 &&
    !downstreamExists &&
    nonEmptyChainValid &&
    state.base.id === attempt.limitReached.baseId &&
    committedAuthorityHash(state) === attempt.limitReached.baseAuthorityHash &&
    completedCascadeDepth(state) === attempt.limitReached.completedDepth &&
    sameJson(
      attempt.limitReached.receiptIds,
      state.receipts.map((receipt) => receipt.id),
    ) &&
    attempt.limitReached.id === id("cascade-limit", {
      baseId: attempt.limitReached.baseId,
      cascadeId: attempt.limitReached.cascadeId,
      budgetId: attempt.limitReached.budgetId,
      completedDepth: attempt.limitReached.completedDepth,
      candidatePosition: attempt.limitReached.candidatePosition,
      frontierId: attempt.limitReached.frontierId,
      receiptIds: attempt.limitReached.receiptIds,
    })
  );
  const receiptChainError = receiptLineageError(state);
  const receiptsContiguous = receiptChainError === null;
  const baseAuthorized = state.receipts.length === 0
    ? baseIdentityIsCurrent(state.base) && state.base.version === 0 &&
      state.baseActivationReceiptId === null
    : baseIdentityIsCurrent(state.base) &&
      state.receipts.at(-1)?.activatedBaseId === state.base.id &&
      state.baseActivationReceiptId === state.receipts.at(-1)?.id &&
      state.base.version === state.receipts.length;
  const successorProofsValid = receiptsContiguous && state.receipts.every((receipt, index) => {
    if (index === 0) return receipt.triggerProof.kind === "root" && receipt.position === 1;
    const predecessor = state.receipts[index - 1];
    return receipt.triggerProof.kind === "successor" &&
      receipt.triggerProof.predecessorReceiptId === predecessor.id &&
      receipt.triggerProof.predecessorBundleId === predecessor.bundleId &&
      receipt.triggerProof.activatedBaseId === receipt.priorBaseId &&
      predecessor.activatedBaseId === receipt.priorBaseId &&
      predecessor.publishedOutputIds.includes(receipt.triggerProof.publishedOutputId) &&
      receipt.position === index + 1;
  });
  const modelLedgerValid = state.modelLedger.every((contribution) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contribution.rawOutput);
    } catch {
      return false;
    }
    const expectedId = id("model-contribution", {
      modelId: contribution.modelId,
      promptPolicyVersion: contribution.promptPolicyVersion,
      schemaVersion: contribution.schemaVersion,
      inputFingerprint: contribution.inputFingerprint,
      rawFingerprint: contribution.rawFingerprint,
      parsedFingerprint: contribution.parsedFingerprint,
    });
    return contribution.id === expectedId &&
      hash(contribution.rawOutput) === contribution.rawFingerprint &&
      hash(contribution.parsedOutput) === contribution.parsedFingerprint &&
      hash(parsed) === contribution.parsedFingerprint &&
      modelPayloadError(contribution.parsedOutput) === null;
  });

  return [
    {
      label: "Run matches retained commitment",
      status: runCommitmentFailure ? "FAIL" : "PASS",
      detail: runCommitmentFailure ??
        `Commitment ${state.runCommitment.id} fixes Run, branch, Budget, and source fixture`,
    },
    {
      label: "boundary before Frontier",
      status: frontierLegal ? "PASS" : "FAIL",
      detail: attempt.frontier
        ? `${attempt.boundaryAnswers.length}/${attempt.boundaryObligations.length} boundary answers; ${attempt.sourceResults.length}/${attempt.sourceObligations.length} source Results`
        : "Frontier not frozen yet",
    },
    {
      label: "zero means closure, not publication",
      status: attempt.emptyClosure ? emptyLegal ? "PASS" : "FAIL" : "PENDING",
      detail: attempt.emptyClosure
        ? `${attempt.continuationClaims.length} unapplied Claim(s); Base and depth retained`
        : "checked when a zero Frontier closes",
    },
    {
      label: "non-empty Frontier is gated",
      status: attempt.limitReached
        ? limitLegal ? "PASS" : "FAIL"
        : downstreamExists
          ? attempt.admission ? "PASS" : "FAIL"
          : "PENDING",
      detail: attempt.limitReached
        ? `position ${attempt.limitReached.candidatePosition} stopped before Stage 1`
        : attempt.admission
          ? `Admission ${attempt.admission.candidatePosition}/${state.run.budget.maximumPublishedPhases} is bound downstream`
          : "checked at Admission or Limit-Reached",
    },
    {
      label: "depth comes only from successful Receipts",
      status: receiptsContiguous ? "PASS" : "FAIL",
      detail: receiptChainError ??
        `${completedCascadeDepth(state)} derived depth from ${state.receipts.length} successful Receipt(s) with exact Bundle lineage`,
    },
    {
      label: "atomic Base authority",
      status: baseAuthorized ? "PASS" : "FAIL",
      detail: state.receipts.length === 0
        ? "initial Base remains authoritative"
        : `latest Receipt alone activates Base v${state.base.version}`,
    },
    {
      label: "exact same-time successor proof",
      status: state.receipts.length === 0
        ? "PENDING"
        : successorProofsValid ? "PASS" : "FAIL",
      detail: state.receipts.length === 0
        ? "checked after the first successful publication"
        : state.receipts.length === 1
          ? "root Receipt recorded; successor checked after another publication"
        : `${state.receipts.length - 1} successor Receipt(s) bind immediate predecessor output witnesses`,
    },
    {
      label: "recorded model contribution cannot commit directly",
      status: modelLedgerValid ? "PASS" : "FAIL",
      detail: `${state.modelLedger.length} contribution(s) fingerprinted; authority still requires Frontier → Admission → Bundle → Receipt`,
    },
  ];
}

export function summarizeState(state: Proof01BState): Record<string, unknown> {
  const depth = completedCascadeDepth(state);
  const frontier = state.attempt.frontier;
  const latestModel = state.modelLedger.at(-1) ?? null;
  return {
    run: {
      id: state.run.id,
      commitmentId: state.runCommitment.id,
      branchId: state.run.branchId,
      status: state.run.status,
      cascadeId: state.cascadeId,
      budgetId: state.run.budget.id,
      budget: state.run.budget.maximumPublishedPhases,
      fixtureId: state.run.fixture.id,
      fixtureSourceOutcomes: state.run.fixture.sourceOutcomes,
      completedDepth: depth,
      remainingPublishedCapacity: Math.max(
        0,
        state.run.budget.maximumPublishedPhases - depth,
      ),
    },
    committedBase: {
      id: state.base.id,
      version: state.base.version,
      worldTime: state.base.worldTime,
      phaseOrdinal: state.base.phaseOrdinal,
      activatedByReceiptId: state.baseActivationReceiptId,
      world: state.base.world,
      worldSummary: describeWorld(state.base.world),
      activeInputs: state.base.activeInputs,
      history: state.base.history,
      authorityHash: committedAuthorityHash(state),
    },
    currentPhase: {
      attemptId: state.attempt.id,
      runCommitmentId: state.attempt.runCommitmentId,
      generation: state.attempt.generation,
      mode: state.attempt.mode,
      boundaryManifestId: state.attempt.boundaryManifestId,
      boundaryAccounting: `${state.attempt.boundaryAnswers.length}/${state.attempt.boundaryObligations.length}`,
      boundaryCompletenessEvidenceId: state.attempt.boundaryCompletenessEvidenceId,
      selectedWorldTime: state.attempt.boundarySelection?.effectiveWorldTime ?? null,
      sourceManifestId: state.attempt.sourceManifestId,
      sourceFixtureBindingId: state.attempt.sourceFixtureBindingId,
      sourceAccounting: `${state.attempt.sourceResults.length}/${state.attempt.sourceObligations.length}`,
      frontier: frontier
        ? { id: frontier.id, kind: frontier.kind, proposalIds: frontier.proposalIds }
        : null,
      triggerProof: state.attempt.triggerProof,
      admission: state.attempt.admission,
      limitReached: state.attempt.limitReached,
      stagedResultId: state.attempt.stagedResult?.id ?? null,
      planId: state.attempt.plan?.id ?? null,
      candidateBaseId: state.attempt.candidate?.base.id ?? null,
      bundleId: state.attempt.bundle?.id ?? null,
      emptyClosure: state.attempt.emptyClosure,
    },
    modelFixture: latestModel
      ? {
          count: state.modelLedger.length,
          id: latestModel.id,
          modelId: latestModel.modelId,
          promptPolicyVersion: latestModel.promptPolicyVersion,
          schemaVersion: latestModel.schemaVersion,
          inputFingerprint: latestModel.inputFingerprint,
          rawFingerprint: latestModel.rawFingerprint,
          parsedFingerprint: latestModel.parsedFingerprint,
          parsedSummary: latestModel.parsedOutput.summary,
        }
      : { count: 0 },
    publication: {
      receiptIds: state.receipts.map((receipt) => receipt.id),
      publishedBundleIds: state.publishedBundles.map((bundle) => bundle.id),
      barrierFailures: state.barrierFailures,
      emptyClosureIds: state.emptyClosures.map((closure) => closure.id),
    },
    lastAction: state.lastAction,
    checks: inspectInvariants(state),
    projectionHash: hash({
      run: state.run,
      runCommitment: state.runCommitment,
      base: state.base,
      baseActivationReceiptId: state.baseActivationReceiptId,
      cascadeId: state.cascadeId,
      receipts: state.receipts,
      publishedBundles: state.publishedBundles,
      modelLedger: state.modelLedger,
      emptyClosures: state.emptyClosures,
      barrierFailures: state.barrierFailures,
      attempt: state.attempt,
      failNextBarrier: state.failNextBarrier,
      lastAction: state.lastAction,
    }),
  };
}
