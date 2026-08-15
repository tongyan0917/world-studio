import test from "node:test";
import assert from "node:assert/strict";

import { hash, stableStringify } from "../src/kernel/stable.ts";
import { ids, time } from "../src/proof00/fixture.ts";
import {
  replayProof00Artifact,
  runProof00Pair,
  runProof00Variant,
} from "../src/proof00/scenario.ts";
import {
  compareArtifacts,
  explainActorPerspective,
  verifyReplayArtifact,
} from "../src/proof00/views.ts";
import {
  sealActorDecisionContext,
  recordActorProposerContribution,
  validateActorDecisionContext,
  validateCandidateActionSet,
} from "../src/proof00/proposer.ts";

function assertGrainLedger(state: ReturnType<typeof runProof00Pair>["base"]["artifact"]["finalState"]): void {
  for (const stock of Object.values(state.grainStocks)) {
    const allocated = Object.values(state.grainAllocations)
      .filter((allocation) => allocation.stockId === stock.id)
      .reduce((sum, allocation) => sum + allocation.grantedQuantity, 0);
    const held = Object.values(state.actors)
      .reduce((sum, actor) => sum + actor.grainHolding, 0);
    const activeReservations = Object.values(state.grainReservations)
      .filter((reservation) => reservation.stockId === stock.id && reservation.status === "active")
      .reduce((sum, reservation) => sum + reservation.quantity, 0);

    assert.equal(stock.openingQuantity, stock.physicalQuantity + allocated);
    assert.equal(stock.reservedQuantity, activeReservations);
    assert.equal(allocated, held);
    assert.ok(stock.physicalQuantity >= 0);
    assert.ok(stock.reservedQuantity >= 0);
    assert.ok(stock.reservedQuantity <= stock.physicalQuantity);
  }
}

test("Proof 00 pair produces the intended scarcity fork without violating conservation", () => {
  const pair = runProof00Pair();
  const base = pair.base.artifact.finalState;
  const anchored = pair.anchored.artifact.finalState;
  const baseStock = base.grainStocks[ids.grainStock]!;
  const anchoredStock = anchored.grainStocks[ids.grainStock]!;

  assert.equal(pair.base.artifact.status, "complete");
  assert.equal(pair.anchored.artifact.status, "complete");
  assert.equal(pair.base.reportArrival, time.baseReportArrival);
  assert.equal(pair.anchored.reportArrival, time.anchoredReportArrival);

  assert.deepEqual(
    pair.base.requestDispositions?.map(({ kind }) => kind).sort(),
    ["accepted", "rejected"],
  );
  assert.equal(pair.base.reservationDisposition?.kind, "rejected");
  assert.equal(baseStock.physicalQuantity, 30);
  assert.equal(baseStock.reservedQuantity, 0);
  assert.equal(Object.values(base.grainAllocations).length, 1);
  assert.equal(Object.values(base.grainAllocations)[0]?.grantedQuantity, 70);
  assert.equal(Object.values(base.grainReservations).length, 0);

  assert.deepEqual(
    pair.anchored.requestDispositions?.map(({ kind }) => kind),
    ["rejected", "rejected"],
  );
  assert.equal(pair.anchored.reservationDisposition?.kind, "accepted");
  assert.equal(anchoredStock.physicalQuantity, 100);
  assert.equal(anchoredStock.reservedQuantity, 60);
  assert.equal(Object.values(anchored.grainAllocations).length, 0);
  assert.equal(anchored.grainReservations[ids.reservation]?.quantity, 60);

  const coordinated = pair.anchored.artifact.transitions.find(({ proposalIds }) =>
    proposalIds.includes("proposal:keeper-reserves-emergency-grain")
  );
  assert.ok(coordinated);
  assert.equal(coordinated.instant.worldTime, time.grainRequests);
  assert.deepEqual(
    coordinated.dispositions.map(({ proposalId, kind }) => ({ proposalId, kind })),
    [
      { proposalId: "proposal:allocation:baker-request", kind: "rejected" },
      { proposalId: "proposal:allocation:innkeeper-request", kind: "rejected" },
      { proposalId: "proposal:keeper-reserves-emergency-grain", kind: "accepted" },
    ],
  );

  const coordinatedAuthorities = pair.anchored.artifact.trace
    .filter((node) => coordinated.dispositions.some(({ proposalId }) =>
      (node.payload as { proposalId?: string }).proposalId === proposalId
    ))
    .map((node) => (node.payload as {
      proposal?: { authority?: { kind?: string; principalId?: string } };
    }).proposal?.authority);
  assert.ok(coordinatedAuthorities.some((authority) =>
    authority?.kind === "organization" && authority.principalId === ids.council
  ));
  assert.equal(
    coordinatedAuthorities.filter((authority) => authority?.kind === "actor").length,
    2,
  );

  assertGrainLedger(base);
  assertGrainLedger(anchored);
});

test("anchored run shares an immutable prefix and diverges first at the declared route-delay input", () => {
  const pair = runProof00Pair();
  const difference = compareArtifacts(pair.base.artifact, pair.anchored.artifact);
  const anchor = pair.anchored.artifact.manifest.anchor;

  assert.ok(anchor);
  assert.ok(difference.commonTracePrefixLength > 0);
  assert.equal(
    hash(pair.base.artifact.trace.slice(0, difference.commonTracePrefixLength)),
    anchor.prefixTraceHash,
  );
  assert.deepEqual(
    pair.base.artifact.trace.slice(0, difference.commonTracePrefixLength),
    pair.anchored.artifact.trace.slice(0, difference.commonTracePrefixLength),
  );
  assert.equal(
    (difference.lastCommonTraceNode?.payload as { transition?: { id?: string } }).transition?.id,
    anchor.anchorTransitionId,
  );

  const leftAction = (
    difference.firstMaterialDivergence?.left?.payload as {
      proposal?: { action?: { kind?: string; delayMinutes?: number } };
    }
  ).proposal?.action;
  const rightAction = (
    difference.firstMaterialDivergence?.right?.payload as {
      proposal?: { action?: { kind?: string; delayMinutes?: number } };
    }
  ).proposal?.action;
  assert.deepEqual(leftAction, {
    kind: "set-route-state",
    routeId: ids.reportRoute,
    segmentId: ids.reportSegment,
    status: "delayed",
    delayMinutes: time.baseReportArrival - time.anchoredReportArrival,
  });
  assert.deepEqual(rightAction, {
    kind: "set-route-state",
    routeId: ids.reportRoute,
    segmentId: ids.reportSegment,
    status: "open",
    delayMinutes: 0,
  });
  assert.ok(difference.leftDownstreamCausalDescendants.length > 0);
  assert.ok(difference.rightDownstreamCausalDescendants.length > 0);
  assert.ok(
    difference.changedOutcomes.some((delta) =>
      delta.path.includes(`grainReservations/${ids.reservation}`) && delta.material
    ),
  );

  const baseContribution = pair.base.artifact.actorProposerContributions[0]!;
  const anchoredContribution = pair.anchored.artifact.actorProposerContributions[0]!;
  assert.deepEqual(baseContribution.result, anchoredContribution.result);
  assert.equal(baseContribution.rawOutput, anchoredContribution.rawOutput);
  assert.deepEqual(baseContribution.sampling, anchoredContribution.sampling);
});

test("mechanism registration order does not alter either history", () => {
  const normal = runProof00Pair();
  const reversed = runProof00Pair({ reverseRegistration: true });

  for (const variant of ["base", "anchored"] as const) {
    assert.equal(
      normal[variant].artifact.finalStateHash,
      reversed[variant].artifact.finalStateHash,
    );
    assert.equal(normal[variant].artifact.traceHash, reversed[variant].artifact.traceHash);
    assert.deepEqual(normal[variant].artifact, reversed[variant].artifact);
  }
});

test("completed artifacts replay exactly from recorded contributions without model calls", () => {
  for (const variant of ["base", "anchored"] as const) {
    const original = runProof00Variant({ variant });
    const verification = verifyReplayArtifact(original.artifact);
    const replayed = replayProof00Artifact(original.artifact);

    assert.equal(verification.ok, true, JSON.stringify(verification.mismatches));
    assert.equal(original.externalModelCallCount, 0);
    assert.equal(replayed.externalModelCallCount, 0);
    assert.deepEqual(replayed.artifact, original.artifact);
  }
});

test("completed Run artifacts are deeply immutable in memory", () => {
  const artifact = runProof00Variant({ variant: "base" }).artifact;
  assert.equal(Object.isFrozen(artifact), true);
  assert.equal(Object.isFrozen(artifact.finalState), true);
  assert.equal(Object.isFrozen(artifact.trace[0]), true);
  assert.throws(() => {
    artifact.finalState.grainStocks[ids.grainStock]!.physicalQuantity = 999;
  }, TypeError);
});

test("artifact verification fails closed when recorded state is tampered", () => {
  const original = runProof00Variant({ variant: "base" }).artifact;
  const tampered = structuredClone(original);
  tampered.finalState.grainStocks[ids.grainStock]!.physicalQuantity += 1;

  const verification = verifyReplayArtifact(tampered);
  assert.equal(verification.ok, false);
  assert.ok(verification.mismatches.some(({ code }) => code === "final-state-hash"));
});

test("ActorProposer context is perspective-local and cannot request direct world mutation", () => {
  const artifact = runProof00Variant({ variant: "base" }).artifact;
  const contribution = artifact.actorProposerContributions[0]!;
  const chair = artifact.finalState.actors[ids.chair]!;
  const baker = artifact.finalState.actors[ids.baker]!;
  const official = artifact.finalState.claims[ids.officialClaim]!;

  assert.deepEqual(contribution.context.epistemicState.accessibleClaimIds, [ids.officialClaim]);
  assert.deepEqual(contribution.context.evidenceRefs, [ids.officialClaim]);
  assert.deepEqual(chair.epistemicState.accessibleClaimIds, [ids.officialClaim]);
  assert.deepEqual(baker.epistemicState.accessibleClaimIds, [ids.rumorClaim]);
  assert.deepEqual(official.receivedBy[ids.chair], {
    worldTime: time.baseReportArrival,
    causalPhase: 1,
  });
  assert.ok(contribution.context.instant.worldTime >= official.receivedBy[ids.chair]!.worldTime);
  assert.equal(stableStringify(contribution.context).includes(ids.rumorClaim), false);
  assert.equal(stableStringify(contribution.context).includes("weeks"), false);

  const forbiddenKinds = [
    "reserve-grain",
    "request-grain",
    "complete-movement",
    "record-organization-decision",
  ];
  for (const kind of forbiddenKinds) {
    assert.equal(contribution.context.allowedActionKinds.includes(kind), false);
  }

  const malicious = structuredClone(contribution.result);
  malicious.candidates[0]!.action = { kind: "reserve-grain" } as never;
  const issues = validateCandidateActionSet(
    contribution.context,
    malicious,
    contribution.schemaVersion,
  );
  assert.ok(issues.some(({ code }) => code === "action-kind-not-allowed"));

  const missingPayload = structuredClone(contribution.result);
  missingPayload.candidates[0]!.action = { kind: "recommend-grain-reserve" } as never;
  const payloadIssues = validateCandidateActionSet(
    contribution.context,
    missingPayload,
    contribution.schemaVersion,
  );
  assert.ok(payloadIssues.some(({ code, path }) =>
    code === "invalid-action-field" && path.endsWith(".quantity")
  ));

  const { contextHash: _ignored, ...contextMaterial } = structuredClone(contribution.context);
  const hiddenEvidenceContext = sealActorDecisionContext({
    ...contextMaterial,
    evidenceRefs: [ids.rumorClaim],
  });
  assert.ok(validateActorDecisionContext(hiddenEvidenceContext).some(({ code }) =>
    code === "inaccessible-context-evidence"
  ));
  assert.throws(() => recordActorProposerContribution(
    contribution.context,
    contribution.result,
    {
      provider: "tampered-fixture",
      model: "tampered",
      modelVersion: "1",
      attemptCount: 1,
      rawOutput: "{}",
    },
  ), /does not match/);

  const perspective = explainActorPerspective(artifact, ids.chair);
  assert.equal(stableStringify(perspective).includes(ids.rumorClaim), false);
  assert.equal(stableStringify(perspective).includes("weeks"), false);
  assert.equal(stableStringify(perspective).includes("rawOutput"), false);
  assert.equal(perspective.withheldEvidence, true);
});

test("technical ActorProposer failure marks the run incomplete and stops downstream effects", () => {
  const result = runProof00Variant({
    variant: "base",
    simulateActorProposerFailure: true,
  });
  const state = result.artifact.finalState;

  assert.equal(result.artifact.status, "incomplete");
  assert.equal(result.artifact.incompleteAtTriggerId, ids.chairTrigger);
  assert.equal(result.externalModelCallCount, 0);
  assert.equal(result.artifact.actorProposerContributions.length, 0);
  assert.equal(result.artifact.actorProposerFailures.length, 1);
  assert.equal(result.artifact.actorProposerFailures[0]?.attemptCount, 2);
  assert.equal(result.artifact.actorProposerFailures[0]?.fallbackUsed, false);
  assert.ok(state.decisionTriggers[ids.chairTrigger]);
  assert.equal(state.actorPositions[ids.chairPosition], undefined);
  assert.equal(state.organizations[ids.council]?.decisions[ids.councilDecision], undefined);
  assert.equal(state.claims[ids.orderClaim], undefined);
  assert.equal(state.movements[ids.orderMovement], undefined);
  assert.equal(state.grainReservations[ids.reservation], undefined);
});

test("presentation-only edits are a non-material comparison control", () => {
  const original = runProof00Variant({ variant: "base" }).artifact;
  const relabeled = structuredClone(original);
  relabeled.finalState.actors[ids.chair]!.name = "Display Name Only";

  const difference = compareArtifacts(original, relabeled);
  assert.equal(difference.sameMaterialHistory, true);
  assert.equal(difference.firstMaterialDivergence, undefined);
  assert.deepEqual(
    difference.changedOutcomes.map(({ path, material }) => ({ path, material })),
    [{ path: `/actors/${ids.chair}/name`, material: false }],
  );
});
