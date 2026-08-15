import test from "node:test";
import assert from "node:assert/strict";

import { hash, stableStringify } from "../src/kernel/stable.ts";
import { ids } from "../src/proof00/fixture.ts";
import { runProof00Pair, runProof00Variant } from "../src/proof00/scenario.ts";
import {
  compareArtifacts,
  explainActorPerspective,
  explainAudit,
  explainWhyNot,
} from "../src/proof00/views.ts";

test("an organization decision is causally separate from implementation", () => {
  const pair = runProof00Pair();
  const base = pair.base.artifact;
  const anchored = pair.anchored.artifact;
  const baseDecision = base.finalState.organizations[ids.council]?.decisions[ids.councilDecision];

  // The base run proves that adoption alone does not mutate the grain ledger.
  assert.equal(baseDecision?.status, "adopted");
  assert.equal(base.finalState.grainReservations[ids.reservation], undefined);
  assert.equal(pair.base.reservationDisposition?.kind, "rejected");

  const decisionTransition = anchored.transitions.find(({ proposalIds }) =>
    proposalIds.includes("proposal:council-adopts-reservation-order")
  );
  const implementationTransition = anchored.transitions.find(({ proposalIds }) =>
    proposalIds.includes("proposal:keeper-reserves-emergency-grain")
  );
  assert.ok(decisionTransition);
  assert.ok(implementationTransition);
  assert.notEqual(decisionTransition.id, implementationTransition.id);
  assert.ok(
    implementationTransition.instant.worldTime > decisionTransition.instant.worldTime ||
      implementationTransition.instant.causalPhase > decisionTransition.instant.causalPhase,
  );

  const implementationAudit = explainAudit(anchored, {
    kind: "proposal",
    id: "proposal:keeper-reserves-emergency-grain",
  });
  const ancestralProposalIds = implementationAudit.evidence
    .map(({ node }) => (node.payload as { proposalId?: string }).proposalId)
    .filter((id): id is string => Boolean(id));
  assert.ok(ancestralProposalIds.includes("proposal:council-adopts-reservation-order"));
  assert.ok(ancestralProposalIds.includes("proposal:council-order-is-issued"));
  assert.ok(ancestralProposalIds.includes("proposal:reservation-order-reaches-keeper"));
});

test("why-not is grounded in the recorded late-reservation rejection", () => {
  const artifact = runProof00Variant({ variant: "base" }).artifact;
  const explanation = explainWhyNot(
    artifact,
    "proposal:keeper-reserves-emergency-grain",
  );

  assert.equal(explanation.established, true);
  assert.equal(explanation.disposition, "rejected");
  assert.deepEqual(
    explanation.blockers.map(({ code }) => code).sort(),
    ["insufficient-unreserved-grain", "precondition-grain"],
  );
  assert.ok(explanation.blockers.every(({ evidenceStatus }) => evidenceStatus === "recorded"));
  assert.equal(explanation.grounding?.established, true);
  assert.equal(explanation.grounding?.missingTraceNodeIds.length, 0);
  assert.equal(explanation.grounding?.causalCycles.length, 0);
  const acceptedAllocation = artifact.transitions
    .flatMap(({ dispositions }) => dispositions)
    .find(({ proposalId, kind }) => proposalId.startsWith("proposal:allocation:") && kind === "accepted")
    ?.proposalId;
  assert.ok(acceptedAllocation);
  const groundedProposalIds = explanation.grounding!.evidence
    .map(({ node }) => (node.payload as { proposalId?: string }).proposalId)
    .filter((value): value is string => Boolean(value));
  assert.ok(groundedProposalIds.includes(acceptedAllocation));

  const missing = explainWhyNot(artifact, "proposal:never-existed");
  assert.equal(missing.established, false);
  assert.deepEqual(missing.blockers, []);
  assert.equal(missing.suggestedNextStep, "run-anchored-comparison");
});

test("audit, perspective, why-not, and comparison views are noninterfering pure projections", () => {
  const pair = runProof00Pair();
  const artifact = pair.base.artifact;
  const beforeHash = hash(artifact);
  const beforeSerialization = stableStringify(artifact);

  const firstAudit = explainAudit(artifact, {
    kind: "proposal",
    id: "proposal:keeper-reserves-emergency-grain",
  });
  const firstPerspective = explainActorPerspective(artifact, ids.chair);
  const firstWhyNot = explainWhyNot(
    artifact,
    "proposal:keeper-reserves-emergency-grain",
  );
  const firstComparison = compareArtifacts(artifact, pair.anchored.artifact);

  assert.equal(hash(artifact), beforeHash);
  assert.equal(stableStringify(artifact), beforeSerialization);
  assert.deepEqual(
    explainAudit(artifact, firstAudit.target),
    firstAudit,
  );
  assert.deepEqual(explainActorPerspective(artifact, ids.chair), firstPerspective);
  assert.deepEqual(
    explainWhyNot(artifact, "proposal:keeper-reserves-emergency-grain"),
    firstWhyNot,
  );
  assert.deepEqual(compareArtifacts(artifact, pair.anchored.artifact), firstComparison);
  assert.equal(hash(artifact), beforeHash);
});
