#!/usr/bin/env node

/**
 * THROWAWAY PROTOTYPE — delete this terminal shell after Proof 01B answers its
 * learning question. Portable state transitions live in model.ts.
 */

import {
  applyAction,
  committedAuthorityHash,
  completedCascadeDepth,
  createProof01BSession,
  describeWorld,
  inspectInvariants,
  summarizeState,
  type FixtureSourceOutcome,
  type Proof01BAction,
  type Proof01BSession,
  type Proof01BState,
  type RecordedModelContribution,
} from "./model.ts";
import { hash, stableStringify } from "../../kernel/stable.ts";

const ansi = {
  clear: "\x1b[2J\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
} as const;

type DemoKey = "boundary" | "collect" | "admit" | "prepare" | "arm-failure" | "publish";

interface DemoRun extends Proof01BSession {
  readonly steps: readonly string[];
}

interface DemoRunOptions {
  readonly budget?: number;
  readonly sourceOutcomes?: readonly FixtureSourceOutcome[];
  readonly recordings?: readonly RecordedModelContribution[];
  readonly strictReplay?: boolean;
}

interface DemoVerdict {
  readonly ok: boolean;
  readonly line: string;
}

function short(value: string | null | undefined): string {
  if (!value) return "—";
  const [prefix, digest] = value.split(":");
  if (!digest) return value;
  if (/^[0-9a-f]{12,}$/.test(digest)) return `${prefix}:${digest.slice(0, 6)}…`;
  return value.length > 30 ? `${value.slice(0, 29)}…` : value;
}

function semanticId(prefix: string, value: unknown): string {
  return `${prefix}:${hash(value).slice(0, 12)}`;
}

function statusColor(status: "accepted" | "rejected" | "barrier-failed"): string {
  if (status === "accepted") return ansi.green;
  if (status === "rejected") return ansi.red;
  return ansi.yellow;
}

function checkColor(status: "PASS" | "FAIL" | "PENDING"): string {
  if (status === "PASS") return ansi.green;
  if (status === "FAIL") return ansi.red;
  return ansi.yellow;
}

function actionFor(
  key: DemoKey,
  recordedContribution?: RecordedModelContribution,
): Proof01BAction {
  switch (key) {
    case "boundary":
      return { type: "complete-boundary" };
    case "collect":
      return {
        type: "collect-frontier",
        ...(recordedContribution ? { recordedContribution } : {}),
      };
    case "admit":
      return { type: "admit" };
    case "prepare":
      return { type: "prepare" };
    case "arm-failure":
      return { type: "arm-barrier-failure" };
    case "publish":
      return { type: "publish" };
  }
}

function applyCandidateState(
  authoritySource: Proof01BSession,
  state: Proof01BState,
  action: Proof01BAction,
): Proof01BState {
  return applyAction({
    state,
    trustAnchor: authoritySource.trustAnchor,
  }, action).state;
}

function stepLine(index: number, key: DemoKey, state: Proof01BState): string {
  const attempt = state.attempt;
  const gate = attempt.limitReached
    ? `LIMIT@${attempt.limitReached.candidatePosition}`
    : attempt.admission
      ? `ADMIT@${attempt.admission.candidatePosition}`
      : "—";
  const publication = state.lastAction.status === "barrier-failed"
    ? "BARRIER-FAIL"
    : state.lastAction.action === "publish" && state.lastAction.status === "accepted"
      ? short(state.receipts.at(-1)?.id)
      : attempt.emptyClosure
        ? "EMPTY-CLOSE"
        : "—";
  return [
    String(index).padStart(2, "0"),
    key.padEnd(11),
    `mode=${attempt.mode.padEnd(17)}`,
    `base=v${state.base.version}@${state.base.worldTime}`,
    `depth=${completedCascadeDepth(state)}/${state.run.budget.maximumPublishedPhases}`,
    `frontier=${attempt.frontier?.kind ?? "—"}`,
    `gate=${gate}`,
    `result=${publication}`,
    `world=${describeWorld(state.base.world)}`,
  ].join(" | ");
}

function runKeys(
  keys: readonly DemoKey[],
  options: DemoRunOptions = {},
): DemoRun {
  const recordings = options.recordings ?? [];
  const strictReplay = options.strictReplay ?? false;
  let session = createProof01BSession({
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.sourceOutcomes ? { sourceOutcomes: options.sourceOutcomes } : {}),
  });
  let state = session.state;
  const steps: string[] = [];
  let recordingIndex = 0;
  keys.forEach((key, index) => {
    const recorded = key === "collect" ? recordings[recordingIndex] : undefined;
    if (key === "collect" && state.run.fixture.sourceOutcomes[state.attempt.generation - 1] === "non-empty") {
      if (strictReplay && !recorded) {
        throw new RangeError(`Replay is missing recorded model contribution ${recordingIndex + 1}.`);
      }
      recordingIndex += 1;
    }
    session = applyAction(session, actionFor(key, recorded));
    state = session.state;
    steps.push(stepLine(index + 1, key, state));
  });
  if (strictReplay && recordingIndex !== recordings.length) {
    throw new RangeError(
      `Replay consumed ${recordingIndex} of ${recordings.length} recorded model contributions.`,
    );
  }
  return { ...session, steps };
}

function verdict(label: string, condition: boolean, detail: string): DemoVerdict {
  return {
    ok: condition,
    line: `[${condition ? "PASS" : "FAIL"}] ${label}: ${detail}`,
  };
}

function compactSnapshot(label: string, state: Proof01BState): readonly string[] {
  const summary = summarizeState(state);
  const attempt = state.attempt;
  return [
    `${label} RUN: ${state.run.status}; cascade ${short(state.cascadeId)}; depth ${completedCascadeDepth(state)}/${state.run.budget.maximumPublishedPhases}`,
    `${label} BASE: ${short(state.base.id)} v${state.base.version}@${state.base.worldTime}; ${describeWorld(state.base.world)}; receipts ${state.receipts.length}`,
    `${label} PHASE: ${attempt.mode}; boundary ${attempt.boundaryAnswers.length}/${attempt.boundaryObligations.length}; sources ${attempt.sourceResults.length}/${attempt.sourceObligations.length}; Frontier ${attempt.frontier?.kind ?? "—"}`,
    `${label} GATE: Admission ${attempt.admission?.candidatePosition ?? "—"}; Limit ${attempt.limitReached?.candidatePosition ?? "—"}; Plan ${short(attempt.plan?.id)}; Bundle ${short(attempt.bundle?.id)}; Closure ${short(attempt.emptyClosure?.id)}`,
    `${label} TRACE: models ${state.modelLedger.length}; barrier failures ${state.barrierFailures.length}; projection ${String(summary.projectionHash).slice(0, 16)}`,
  ];
}

function runDemo(): void {
  const mainKeys: readonly DemoKey[] = [
    "boundary", "collect", "admit", "prepare", "publish",
    "boundary", "collect", "admit", "prepare", "publish",
    "boundary", "collect", "admit",
  ];
  const beforeLimit = runKeys(mainKeys.slice(0, -1));
  const authorityBeforeLimit = committedAuthorityHash(beforeLimit.state);
  const baseIdBeforeLimit = beforeLimit.state.base.id;
  const baseVersionBeforeLimit = beforeLimit.state.base.version;
  const depthBeforeLimit = completedCascadeDepth(beforeLimit.state);
  const receiptsBeforeLimit = beforeLimit.state.receipts.length;
  const limitedSession = applyAction(beforeLimit, actionFor("admit"));
  const limitedState = limitedSession.state;
  const main: DemoRun = {
    ...limitedSession,
    steps: [
      ...beforeLimit.steps,
      stepLine(mainKeys.length, "admit", limitedState),
    ],
  };
  const mainChecks = [
    verdict(
      "B+1 stops Incomplete",
      main.state.run.status === "incomplete" &&
        main.state.attempt.limitReached?.candidatePosition === 3,
      "Budget 2 admits two successful phases and blocks only the proven third non-empty Frontier",
    ),
    verdict(
      "last committed Base retained",
      committedAuthorityHash(main.state) === authorityBeforeLimit &&
        main.state.base.id === baseIdBeforeLimit &&
        main.state.base.version === baseVersionBeforeLimit &&
        completedCascadeDepth(main.state) === depthBeforeLimit &&
        main.state.receipts.length === receiptsBeforeLimit,
      `pre-limit authority ${short(baseIdBeforeLimit)} remains byte-equivalent at version ${baseVersionBeforeLimit}`,
    ),
    verdict(
      "blocked Frontier has no publication artifacts",
      !main.state.attempt.stagedResult && !main.state.attempt.plan &&
        !main.state.attempt.candidate && !main.state.attempt.bundle &&
        main.state.receipts.length === 2,
      "no Stage 1 result, Plan, Candidate, Bundle, or third Receipt exists",
    ),
  ];

  const replay = runKeys(mainKeys, {
    recordings: main.state.modelLedger,
    strictReplay: true,
  });
  const mainHash = summarizeState(main.state).projectionHash;
  const replayHash = summarizeState(replay.state).projectionHash;
  mainChecks.push(verdict(
    "recorded replay",
    mainHash === replayHash,
    `${String(mainHash).slice(0, 16)} reproduced from recorded model contributions`,
  ));

  const zeroKeys: readonly DemoKey[] = [
    "boundary", "collect", "admit", "prepare", "publish",
    "boundary", "collect", "admit", "prepare", "publish",
    "boundary", "collect",
  ];
  let zeroSession = createProof01BSession({
    sourceOutcomes: ["non-empty", "non-empty", "zero"],
  });
  let zeroState = zeroSession.state;
  const zeroSteps: string[] = [];
  for (const key of zeroKeys) {
    const beforeAuthority = committedAuthorityHash(zeroState);
    const beforeDepth = completedCascadeDepth(zeroState);
    zeroSession = applyAction(zeroSession, actionFor(key));
    zeroState = zeroSession.state;
    zeroSteps.push(stepLine(zeroSteps.length + 1, key, zeroState));
    if (key === "collect" && zeroState.attempt.mode === "empty-closed") {
      zeroSteps.push(verdict(
        "zero closure keeps authority",
        beforeAuthority === committedAuthorityHash(zeroState) &&
          beforeDepth === completedCascadeDepth(zeroState),
        "Base, World, successful Receipt ancestry, and depth are byte-equivalent",
      ).line);
    }
  }
  const zeroChecks = [
    verdict(
      "zero Result was frozen before the Run",
      zeroState.run.fixture.sourceOutcomes[2] === "zero" &&
        zeroState.run.fixture.id !== main.state.run.fixture.id,
      "the B+1 and zero scenarios are distinct Run fixtures, not two buttons at one checkpoint",
    ),
    verdict(
      "execution fixture does not redefine the causal root",
      zeroState.cascadeId === main.state.cascadeId,
      "different Run Commitments preserve the same Cascade identity when the actual root Base, boundary, activation, and first Frontier are identical",
    ),
    verdict(
      "zero at depth B is legal",
      zeroState.run.status === "running" &&
        zeroState.attempt.mode === "empty-closed" &&
        completedCascadeDepth(zeroState) === 2 &&
        zeroState.attempt.emptyClosure?.worldTime ===
          zeroState.attempt.boundarySelection?.effectiveWorldTime &&
        !zeroState.attempt.limitReached,
      "current collection closed; Run did not claim global Quiescence and bypassed Admission/Limit",
    ),
    verdict(
      "zero is not an empty publication",
      zeroState.receipts.length === 2 &&
        !zeroState.attempt.plan && !zeroState.attempt.bundle &&
        zeroState.attempt.continuationClaims.every((claim) => !claim.applied),
      "no third Receipt or downstream bundle; explicit continuation Claim remains unapplied",
    ),
  ];

  const barrierSetup: readonly DemoKey[] = [
    "boundary", "collect", "admit", "prepare",
  ];
  const prepared = runKeys(barrierSetup);
  const authorityBeforeFailure = committedAuthorityHash(prepared.state);
  const depthBeforeFailure = completedCascadeDepth(prepared.state);
  const bundleBeforeFailure = prepared.state.attempt.bundle?.id;
  let barrierSession = applyAction(prepared, actionFor("arm-failure"));
  let barrierState = barrierSession.state;
  const barrierSteps = [...prepared.steps, stepLine(5, "arm-failure", barrierState)];
  barrierSession = applyAction(barrierSession, actionFor("publish"));
  barrierState = barrierSession.state;
  barrierSteps.push(stepLine(6, "publish", barrierState));
  const failedCleanly = authorityBeforeFailure === committedAuthorityHash(barrierState) &&
    depthBeforeFailure === completedCascadeDepth(barrierState) &&
    bundleBeforeFailure === barrierState.attempt.bundle?.id &&
    barrierState.receipts.length === 0 &&
    barrierState.attempt.mode === "ready";
  barrierSession = applyAction(barrierSession, actionFor("publish"));
  barrierState = barrierSession.state;
  barrierSteps.push(stepLine(7, "publish", barrierState));
  const barrierChecks = [
    verdict(
      "failed barrier is non-authoritative",
      failedCleanly,
      "same Base, depth, and retryable Bundle remained after the injected failure",
    ),
    verdict(
      "retry consumes the position once",
      barrierState.receipts.length === 1 && completedCascadeDepth(barrierState) === 1,
      "the unchanged candidate published once on retry",
    ),
  ];

  const missingCoverageOpen = createProof01BSession();
  const missingCoverageCompleted = applyAction(
    missingCoverageOpen,
    { type: "complete-boundary" },
  );
  let missingCoverageState = missingCoverageCompleted.state;
  missingCoverageState = {
    ...missingCoverageState,
    attempt: {
      ...missingCoverageState.attempt,
      boundaryAnswers: missingCoverageState.attempt.boundaryAnswers.slice(0, 1),
    },
  };
  const missingCoverageResult = applyCandidateState(
    missingCoverageCompleted,
    missingCoverageState,
    { type: "collect-frontier" },
  );
  const duplicatedAnswerState: Proof01BState = {
    ...missingCoverageState,
    attempt: {
      ...missingCoverageState.attempt,
      boundaryAnswers: [
        missingCoverageState.attempt.boundaryAnswers[0],
        missingCoverageState.attempt.boundaryAnswers[0],
      ],
    },
  };
  const duplicatedAnswerResult = applyCandidateState(
    missingCoverageCompleted,
    duplicatedAnswerState,
    { type: "collect-frontier" },
  );
  const openBoundarySession = createProof01BSession();
  const openBoundary = openBoundarySession.state;
  const omittedObligationState: Proof01BState = {
    ...openBoundary,
    attempt: {
      ...openBoundary.attempt,
      boundaryObligations: openBoundary.attempt.boundaryObligations.slice(0, 1),
    },
  };
  const omittedObligationResult = applyCandidateState(
    openBoundarySession,
    omittedObligationState,
    { type: "complete-boundary" },
  );
  const frozenFixtureOpen = createProof01BSession();
  const frozenFixtureCompleted = applyAction(
    frozenFixtureOpen,
    { type: "complete-boundary" },
  );
  const frozenFixtureState = frozenFixtureCompleted.state;
  const reclassifiedFixtureState: Proof01BState = {
    ...frozenFixtureState,
    run: {
      ...frozenFixtureState.run,
      fixture: {
        ...frozenFixtureState.run.fixture,
        sourceOutcomes: ["zero", "non-empty", "non-empty"],
      },
    },
  };
  const reclassificationResult = applyCandidateState(
    frozenFixtureCompleted,
    reclassifiedFixtureState,
    { type: "collect-frontier" },
  );
  const collectedNonEmptyRun = runKeys(["boundary", "collect"]);
  const collectedNonEmpty = collectedNonEmptyRun.state;
  const selfConsistentZeroRun = createProof01BSession({
    sourceOutcomes: ["zero", "non-empty", "non-empty"],
  }).state.run;
  const switchedRunAfterCollection: Proof01BState = {
    ...collectedNonEmpty,
    run: selfConsistentZeroRun,
  };
  const switchedRunResult = applyCandidateState(
    collectedNonEmptyRun,
    switchedRunAfterCollection,
    { type: "admit" },
  );
  const validRecordedContribution = runKeys(["boundary", "collect"])
    .state.modelLedger[0];
  const malformedParsedOutput = {
    ...validRecordedContribution.parsedOutput,
    patch: {
      ...validRecordedContribution.parsedOutput.patch,
      watchLevelDelta: "oops",
    },
  } as unknown as RecordedModelContribution["parsedOutput"];
  const malformedRawOutput = stableStringify(malformedParsedOutput);
  const malformedIdentity = {
    modelId: validRecordedContribution.modelId,
    promptPolicyVersion: validRecordedContribution.promptPolicyVersion,
    schemaVersion: validRecordedContribution.schemaVersion,
    inputFingerprint: validRecordedContribution.inputFingerprint,
    rawFingerprint: hash(malformedRawOutput),
    parsedFingerprint: hash(malformedParsedOutput),
  };
  const malformedContribution: RecordedModelContribution = {
    id: `model-contribution:${hash(malformedIdentity).slice(0, 12)}`,
    ...malformedIdentity,
    rawOutput: malformedRawOutput,
    parsedOutput: malformedParsedOutput,
  };
  const malformedReplayOpen = createProof01BSession();
  const malformedReplayCompleted = applyAction(
    malformedReplayOpen,
    { type: "complete-boundary" },
  );
  const malformedModelResult = applyAction(malformedReplayCompleted, {
    type: "collect-frontier",
    recordedContribution: malformedContribution,
  }).state;

  const readyForTamperRun = runKeys(barrierSetup);
  const readyForTamper = readyForTamperRun.state;
  const originalCandidate = readyForTamper.attempt.candidate;
  if (!originalCandidate || !readyForTamper.attempt.bundle) {
    throw new TypeError("Tamper fixture did not reach a ready artifact chain");
  }
  const candidateTampered: Proof01BState = {
    ...readyForTamper,
    attempt: {
      ...readyForTamper.attempt,
      candidate: {
        ...originalCandidate,
        base: {
          ...originalCandidate.base,
          world: { ...originalCandidate.base.world, watchLevel: 999 },
        },
      },
    },
  };
  const candidateTamperResult = applyCandidateState(
    readyForTamperRun,
    candidateTampered,
    { type: "publish" },
  );
  const bundleTampered: Proof01BState = {
    ...readyForTamper,
    attempt: {
      ...readyForTamper.attempt,
      bundle: {
        ...readyForTamper.attempt.bundle,
        planId: "forged-plan",
        admissionId: "forged-admission",
      },
    },
  };
  const bundleTamperResult = applyCandidateState(
    readyForTamperRun,
    bundleTampered,
    { type: "publish" },
  );

  const oncePublishedRun = runKeys([
    "boundary", "collect", "admit", "prepare", "publish",
  ]);
  const oncePublished = oncePublishedRun.state;
  const counterfeitAnchorResult = applyAction({
    state: oncePublished,
    trustAnchor: {
      runCommitmentId: oncePublished.runCommitment.id,
      committedAuthorityHash: committedAuthorityHash(oncePublished),
      isIssuedByProof01B: () => true,
    } as unknown as Proof01BSession["trustAnchor"],
  }, { type: "complete-boundary" }).state;
  const alternateBudgetThreeRun = runKeys(mainKeys.slice(0, -1), { budget: 3 });
  const budgetSwitchResult = applyCandidateState(
    beforeLimit,
    alternateBudgetThreeRun.state,
    { type: "admit" },
  );
  const alternateFutureFixtureRun = runKeys(
    ["boundary", "collect", "admit", "prepare", "publish"],
    {
      sourceOutcomes: ["non-empty", "non-empty", "zero"],
    },
  );
  const fixtureSwitchResult = applyCandidateState(
    oncePublishedRun,
    alternateFutureFixtureRun.state,
    { type: "complete-boundary" },
  );
  const lostPublishedBundle: Proof01BState = {
    ...oncePublished,
    publishedBundles: [],
  };
  const lostBundleResult = applyCandidateState(
    oncePublishedRun,
    lostPublishedBundle,
    { type: "complete-boundary" },
  );
  const publishedBundle = oncePublished.publishedBundles[0];
  const rootReceipt = oncePublished.receipts[0];
  if (!publishedBundle || !publishedBundle.publishedOutputs[0] || !rootReceipt) {
    throw new TypeError("Published lineage tamper fixture is incomplete");
  }
  const rehashedOutput = {
    ...publishedBundle.publishedOutputs[0],
    summary: "forged historical output summary",
  };
  const rehashedOutputBundleContent = {
    planId: publishedBundle.planId,
    admissionId: publishedBundle.admissionId,
    candidateBaseId: publishedBundle.candidateBaseId,
    publishedOutputs: [rehashedOutput],
  };
  const rehashedOutputBundle = {
    id: semanticId("publication-bundle", rehashedOutputBundleContent),
    ...rehashedOutputBundleContent,
  };
  const { id: ignoredOutputReceiptId, ...outputReceiptContent } = rootReceipt;
  const rehashedOutputReceiptContent = {
    ...outputReceiptContent,
    bundleId: rehashedOutputBundle.id,
  };
  const rehashedOutputReceipt = {
    id: semanticId("publication-receipt", rehashedOutputReceiptContent),
    ...rehashedOutputReceiptContent,
  };
  const outputContentTampered: Proof01BState = {
    ...oncePublished,
    publishedBundles: [rehashedOutputBundle],
    receipts: [rehashedOutputReceipt],
    baseActivationReceiptId: rehashedOutputReceipt.id,
  };
  const outputContentTamperResult = applyCandidateState(
    oncePublishedRun,
    outputContentTampered,
    { type: "complete-boundary" },
  );
  if (rootReceipt.triggerProof.kind !== "root") {
    throw new TypeError("First published Receipt did not retain a root trigger");
  }
  const forgedProofValue = {
    kind: "root" as const,
    frontierId: "frontier:forged-root",
    activationId: "activation:forged-root",
    selectedWorldTime: rootReceipt.triggerProof.selectedWorldTime,
    priorWorldTime: rootReceipt.triggerProof.priorWorldTime,
  };
  const forgedProof = {
    id: semanticId("root-trigger", forgedProofValue),
    ...forgedProofValue,
  };
  const forgedCascadeId = semanticId("cascade", {
    rootBaseId: rootReceipt.priorBaseId,
    boundarySelectionId: rootReceipt.boundarySelectionId,
    rootActivationId: forgedProof.activationId,
    effectiveWorldTime: forgedProof.selectedWorldTime,
    rootFrontierId: forgedProof.frontierId,
  });
  const forgedAdmissionValue = {
    runId: rootReceipt.admission.runId,
    branchId: rootReceipt.admission.branchId,
    budgetId: rootReceipt.admission.budgetId,
    cascadeId: forgedCascadeId,
    frontierId: forgedProof.frontierId,
    completedDepth: rootReceipt.admission.completedDepth,
    candidatePosition: rootReceipt.admission.candidatePosition,
    triggerProofId: forgedProof.id,
  };
  const forgedAdmission = {
    id: semanticId("cascade-admission", forgedAdmissionValue),
    ...forgedAdmissionValue,
  };
  const forgedBundleId = semanticId("publication-bundle", {
    planId: publishedBundle.planId,
    admissionId: forgedAdmission.id,
    candidateBaseId: publishedBundle.candidateBaseId,
    publishedOutputs: publishedBundle.publishedOutputs,
  });
  const forgedBundle = {
    ...publishedBundle,
    id: forgedBundleId,
    admissionId: forgedAdmission.id,
  };
  const { id: ignoredRootReceiptId, ...rootReceiptContent } = rootReceipt;
  const forgedReceiptContent = {
    ...rootReceiptContent,
    cascadeId: forgedCascadeId,
    bundleId: forgedBundle.id,
    admissionId: forgedAdmission.id,
    admission: forgedAdmission,
    triggerProof: forgedProof,
  };
  const forgedReceipt = {
    id: semanticId("publication-receipt", forgedReceiptContent),
    ...forgedReceiptContent,
  };
  const rootMetadataRewritten: Proof01BState = {
    ...oncePublished,
    cascadeId: forgedCascadeId,
    receipts: [forgedReceipt],
    publishedBundles: [forgedBundle],
    baseActivationReceiptId: forgedReceipt.id,
  };
  const rootMetadataRewriteResult = applyCandidateState(
    oncePublishedRun,
    rootMetadataRewritten,
    { type: "complete-boundary" },
  );

  const noOutputKeys: DemoKey[] = [];
  for (let phase = 0; phase < 4; phase += 1) {
    noOutputKeys.push("boundary", "collect", "admit", "prepare", "publish");
  }
  noOutputKeys.push("boundary");
  const noOutput = runKeys(noOutputKeys, {
    budget: 4,
    sourceOutcomes: ["non-empty", "non-empty", "non-empty", "non-empty"],
  });
  const failClosedChecks = [
    verdict(
      "external authority anchor blocks a fully valid alternate Run",
      budgetSwitchResult.lastAction.status === "rejected" &&
        fixtureSwitchResult.lastAction.status === "rejected" &&
        counterfeitAnchorResult.lastAction.status === "rejected" &&
        completedCascadeDepth(budgetSwitchResult) === 2 &&
        budgetSwitchResult.receipts.length === 2,
      "even a separately valid, fully re-hashed Run cannot replace the anchored B=2 Run; a look-alike anchor is rejected too",
    ),
    verdict(
      "checkpoint cannot reclassify non-empty work as zero",
      reclassificationResult.lastAction.status === "rejected" &&
        switchedRunResult.lastAction.status === "rejected" &&
        !reclassificationResult.attempt.frontier &&
        reclassificationResult.base.version === 0,
      "both in-place mutation and attaching an old Frontier to a new self-consistent zero Run fail closed",
    ),
    verdict(
      "self-consistent malformed model payload cannot become a Proposal",
      malformedModelResult.lastAction.status === "rejected" &&
        !malformedModelResult.attempt.frontier &&
        malformedModelResult.modelLedger.length === 0,
      "runtime schema rejects a string watchLevelDelta even when every raw/parsed hash is recomputed",
    ),
    verdict(
      "missing or duplicate boundary accounting cannot freeze a Frontier",
      missingCoverageResult.lastAction.status === "rejected" &&
        duplicatedAnswerResult.lastAction.status === "rejected" &&
        omittedObligationResult.lastAction.status === "rejected" &&
        !missingCoverageResult.attempt.frontier &&
        missingCoverageResult.base.version === 0,
      "missing answer, duplicate answer, and omitted Base-derived obligation all fail closed",
    ),
    verdict(
      "successor work requires intact committed Receipt/Bundle lineage",
      lostBundleResult.lastAction.status === "rejected" &&
        lostBundleResult.base.version === 1 &&
        lostBundleResult.receipts.length === 1,
      "removing the predecessor's published Bundle blocks the next action without rewriting its Base",
    ),
    verdict(
      "committed semantic lineage rejects local history rewrites",
      outputContentTamperResult.lastAction.status === "rejected" &&
        rootMetadataRewriteResult.lastAction.status === "rejected" &&
        outputContentTamperResult.base.version === 1 &&
        rootMetadataRewriteResult.base.version === 1,
      "the external authority head rejects a re-hashed output/Bundle/Receipt; retained root witnesses also reject a forged root activation, Frontier, Admission, Cascade, and Bundle",
    ),
    verdict(
      "Barrier revalidates exact Candidate and Bundle content",
      candidateTamperResult.lastAction.status === "rejected" &&
        bundleTamperResult.lastAction.status === "rejected" &&
        candidateTamperResult.receipts.length === 0 &&
        bundleTamperResult.receipts.length === 0,
      "world tampering under an old Candidate ID and forged Bundle bindings both fail closed",
    ),
    verdict(
      "publication without a new causal output cannot create a same-time successor",
      completedCascadeDepth(noOutput.state) === 4 &&
        noOutput.state.base.activeInputs.length === 0 &&
        noOutput.state.attempt.mode === "later-boundary-unmodeled" &&
        noOutput.state.attempt.boundarySelection?.effectiveWorldTime === "T2" &&
        noOutput.state.attempt.sourceObligations.length === 0,
      "the next visible candidate is the later T2 Process boundary, which this same-time slice leaves unmodeled",
    ),
  ];

  const allVerdicts = [
    ...mainChecks,
    ...zeroChecks,
    ...barrierChecks,
    ...failClosedChecks,
  ];
  const output = [
    "THROWAWAY PROTOTYPE — Proof 01B causal-phase control",
    "Question: can exhaustive accounting, admission, atomic publication, zero closure, and B+1 fail-stop be made tangible before full implementation?",
    "",
    "=== A · TWO PUBLICATIONS, THEN B+1 LIMIT ===",
    ...main.steps,
    ...mainChecks.map((item) => item.line),
    ...compactSnapshot("A", main.state),
    "",
    "=== B · ZERO FRONTIER AT FULL DEPTH ===",
    ...zeroSteps,
    ...zeroChecks.map((item) => item.line),
    ...compactSnapshot("B", zeroState),
    "",
    "=== C · FAILED BARRIER, SAME-POSITION RETRY ===",
    ...barrierSteps,
    ...barrierChecks.map((item) => item.line),
    ...compactSnapshot("C", barrierState),
    "",
    "=== D · ADDITIONAL FAIL-CLOSED CHECKS ===",
    ...failClosedChecks.map((item) => item.line),
    ...compactSnapshot("D", noOutput.state),
    "",
    "This exercises only the throwaway control sketch. It does not implement ADR-0053–0059.",
    "",
  ];
  process.stdout.write(output.join("\n"));
  if (allVerdicts.some((item) => !item.ok)) process.exitCode = 1;
}

function section(title: string, lines: readonly string[]): readonly string[] {
  return [`${ansi.bold}${ansi.cyan}${title}${ansi.reset}`, ...lines];
}

function renderInteractive(
  state: Proof01BState,
  trustAnchor: Proof01BSession["trustAnchor"],
  uiNote: string | null = null,
): void {
  const attempt = state.attempt;
  const depth = completedCascadeDepth(state);
  const currentModelId = attempt.proposals.at(-1)?.modelContributionId;
  const currentModel = currentModelId
    ? state.modelLedger.find((contribution) => contribution.id === currentModelId)
    : undefined;
  const lastHistoricalModel = currentModel ? undefined : state.modelLedger.at(-1);
  const shownModel = currentModel ?? lastHistoricalModel;
  const latestReceipt = state.receipts.at(-1);
  const candidatePosition = attempt.frontier?.kind === "non-empty"
    ? attempt.limitReached?.candidatePosition ??
      attempt.admission?.candidatePosition ?? depth + 1
    : null;
  const boundaryLines = attempt.boundaryObligations.map((obligation) => {
    const answer = attempt.boundaryAnswers.find(
      (candidate) => candidate.obligationId === obligation.id,
    );
    return `${answer ? "✓" : "·"} ${obligation.kind.padEnd(15)} ${short(obligation.id)} → ${answer?.candidateWorldTime ?? "unanswered"}`;
  });
  const sourceLines = attempt.sourceObligations.length === 0
    ? ["· source obligations derive only after boundary completeness"]
    : attempt.sourceObligations.map((obligation) => {
        const result = attempt.sourceResults.find(
          (candidate) => candidate.obligationId === obligation.id,
        );
        return `${result ? "✓" : "·"} ${short(obligation.id)} ← ${short(obligation.activationId)} → ${result?.kind ?? "unanswered"}`;
      });
  const checks = inspectInvariants(state).map((check) =>
    `${checkColor(check.status)}[${check.status}]${ansi.reset} ${check.label}: ${check.detail}`
  );
  const lastColor = statusColor(state.lastAction.status);
  const actionLine = uiNote
    ? `${ansi.red}[REJECTED]${ansi.reset} input: ${uiNote}`
    : `${lastColor}[${state.lastAction.status.toUpperCase()}]${ansi.reset} ${state.lastAction.action}: ${state.lastAction.message}`;
  const frame = [
    `${ansi.bold}THROWAWAY PROTOTYPE — Proof 01B${ansi.reset}`,
    `${ansi.dim}Base → boundary completeness → source collection → Frontier → admission → atomic publication → next Base${ansi.reset}`,
    actionLine,
    "",
    ...section("RUN CONTROL", [
      `run ${short(state.run.id)} · commitment ${short(state.runCommitment.id)} · ${state.run.status} · branch ${state.run.branchId}`,
      `external authority ${trustAnchor.committedAuthorityHash.slice(0, 16)} · rotates only after accepted publication`,
      `fixture ${short(state.run.fixture.id)} · outcomes ${state.run.fixture.sourceOutcomes.join(" → ")}`,
      `cascade ${short(state.cascadeId)} · successful Receipt depth ${depth}/${state.run.budget.maximumPublishedPhases} · candidate ${candidatePosition ?? "— (requires non-empty Frontier)"}`,
    ]),
    "",
    ...section("COMMITTED BASE", [
      `${short(state.base.id)} · v${state.base.version} · World Time ${state.base.worldTime} · phase ordinal ${state.base.phaseOrdinal}`,
      describeWorld(state.base.world),
      `active inputs: ${state.base.activeInputs.map((input) => `${input.kind}/${short(input.id)}←${short(input.outputId)}`).join(", ") || "none"}`,
      `activated by: ${short(state.baseActivationReceiptId)} · Receipt lineage: ${state.receipts.map((receipt) => short(receipt.id)).join(" → ") || "none"}`,
      `history ${state.base.history.length} event(s); latest: ${state.base.history.at(-1)}`,
    ]),
    "",
    ...section("BOUNDARY + SOURCE ACCOUNTING", [
      `attempt ${short(attempt.id)} · mode ${attempt.mode} · selected ${attempt.boundarySelection?.effectiveWorldTime ?? "—"}`,
      ...boundaryLines,
      ...sourceLines,
    ]),
    "",
    ...section("CURRENT FRONTIER + PUBLICATION", [
      `Frontier ${short(attempt.frontier?.id)} · ${attempt.frontier?.kind ?? "not frozen"} · proposals ${attempt.frontier?.proposalIds.length ?? 0}`,
      `trigger ${attempt.triggerProof?.kind ?? "—"}/${short(attempt.triggerProof?.id)} · Admission ${short(attempt.admission?.id)}${attempt.admission ? ` @${attempt.admission.candidatePosition}` : ""}`,
      `Stage ${short(attempt.stagedResult?.id)} · Plan ${short(attempt.plan?.id)} · Candidate ${short(attempt.candidate?.base.id)} · Bundle ${short(attempt.bundle?.id)}`,
      `Limit ${short(attempt.limitReached?.id)} · Empty closure ${short(attempt.emptyClosure?.id)} · fail-next ${state.failNextBarrier}`,
      `latest Receipt ${short(latestReceipt?.id)} · barrier failures ${state.barrierFailures.length}`,
    ]),
    "",
    ...section("RECORDED MODEL FIXTURE", shownModel
      ? [
          `${currentModel ? "current attempt" : "latest historical"}: ${short(shownModel.id)} · ${shownModel.modelId}`,
          `prompt ${shownModel.promptPolicyVersion} · schema ${shownModel.schemaVersion}`,
          `input ${shownModel.inputFingerprint.slice(0, 12)} · raw ${shownModel.rawFingerprint.slice(0, 12)} · parsed ${shownModel.parsedFingerprint.slice(0, 12)}`,
          `proposal: ${shownModel.parsedOutput.summary}`,
        ]
      : ["No model contribution recorded yet. A model fixture may propose, but cannot publish."]),
    "",
    ...section("VISIBLE INVARIANTS", checks),
    "",
    `${ansi.bold}[b]${ansi.reset} boundary  ${ansi.bold}[g]${ansi.reset} collect frozen source  ${ansi.bold}[a]${ansi.reset} admit  ${ansi.bold}[s]${ansi.reset} stage  ${ansi.bold}[c]${ansi.reset} commit  ${ansi.bold}[f]${ansi.reset} fail-next`,
    `${ansi.bold}[1]${ansi.reset} new limit fixture  ${ansi.bold}[2]${ansi.reset} new zero-after-two fixture  ${ansi.bold}[r]${ansi.reset} reset same fixture  ${ansi.bold}[d]${ansi.reset} demo+quit  ${ansi.bold}[q]${ansi.reset} quit`,
  ];
  process.stdout.write(`${ansi.clear}${ansi.hideCursor}${frame.join("\n")}\n`);
}

function runInteractive(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "Interactive mode needs a TTY. Run with --demo for a non-interactive proof trace.\n",
    );
    process.exitCode = 2;
    return;
  }
  let session = createProof01BSession();
  let state = session.state;
  let closed = false;
  let uiNote: string | null = null;

  const close = (): void => {
    if (closed) return;
    closed = true;
    process.stdin.off("data", onKey);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${ansi.showCursor}\n`);
  };

  const onKey = (input: string): void => {
    if (input === "q" || input === "\u0003") {
      close();
      return;
    }
    if (input === "d") {
      close();
      runDemo();
      return;
    }
    if (input === "r") {
      session = createProof01BSession({
        budget: state.run.budget.maximumPublishedPhases,
        sourceOutcomes: state.run.fixture.sourceOutcomes,
      });
      state = session.state;
      uiNote = null;
      renderInteractive(state, session.trustAnchor, uiNote);
      return;
    }
    if (input === "1" || input === "2") {
      session = createProof01BSession({
        sourceOutcomes: input === "1"
          ? ["non-empty", "non-empty", "non-empty"]
          : ["non-empty", "non-empty", "zero"],
      });
      state = session.state;
      uiNote = null;
      renderInteractive(state, session.trustAnchor, uiNote);
      return;
    }
    const actions: Readonly<Record<string, Proof01BAction>> = {
      b: { type: "complete-boundary" },
      g: { type: "collect-frontier" },
      a: { type: "admit" },
      s: { type: "prepare" },
      c: { type: "publish" },
      f: { type: "arm-barrier-failure" },
    };
    const action = actions[input];
    if (action) {
      session = applyAction(session, action);
      state = session.state;
      uiNote = null;
    } else uiNote = `Unknown key ${JSON.stringify(input)}.`;
    renderInteractive(state, session.trustAnchor, uiNote);
  };

  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onKey);
  process.once("exit", () => process.stdout.write(ansi.showCursor));
  renderInteractive(state, session.trustAnchor, uiNote);
}

function usage(): void {
  process.stdout.write([
    "THROWAWAY Proof 01B causal-phase terminal prototype",
    "",
    "Usage:",
    "  node src/prototypes/proof01b-causal-phase/cli.ts",
    "  node src/prototypes/proof01b-causal-phase/cli.ts --demo",
    "",
    "Controls: b boundary, g collect frozen source, a admit, s stage, c commit,",
    "          f fail-next barrier, 1 new limit fixture, 2 new zero fixture,",
    "          r reset same fixture, d demo+quit, q quit",
    "",
  ].join("\n"));
}

const [option] = process.argv.slice(2);
if (option === "--demo") runDemo();
else if (option === "--help" || option === "-h") usage();
else if (option === undefined) runInteractive();
else {
  usage();
  process.exitCode = 2;
}
