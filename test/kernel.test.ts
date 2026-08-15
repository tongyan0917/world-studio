import test from "node:test";
import assert from "node:assert/strict";

import { Kernel } from "../src/kernel/kernel.ts";
import { hash, stableRandom, stableRandomInt } from "../src/kernel/stable.ts";
import type { Proof00Action, Proof00WorldState, TransitionProposal } from "../src/kernel/types.ts";
import {
  ACTION_VALIDATOR,
  PRECONDITION_VALIDATOR,
  nextInstant,
  paths,
  proof00StateAdapter,
  registerProof00Domain,
} from "../src/proof00/domain.ts";
import { createInitialState, ids, time } from "../src/proof00/fixture.ts";
import { makeProposal, runProof00Pair } from "../src/proof00/scenario.ts";

function createKernel(reverseRegistration = false): Kernel<Proof00WorldState> {
  return registerProof00Domain(
    new Kernel(createInitialState(), proof00StateAdapter),
    "kernel-test-seed",
    reverseRegistration,
  );
}

function routeProposal(
  kernel: Kernel<Proof00WorldState>,
  id: string,
  routeId: string,
  segmentId: string,
  instant: ReturnType<typeof nextInstant>,
  causalParents: readonly string[] = [],
): TransitionProposal<Proof00Action> {
  return makeProposal(kernel, {
    id,
    source: "weather",
    instant,
    subjects: [routeId],
    causalParents,
    readPaths: [paths.route(routeId)],
    effectPaths: [paths.route(routeId)],
    action: {
      kind: "set-route-state",
      routeId,
      segmentId,
      status: "delayed",
      delayMinutes: routeId === ids.supplyRoute ? 10 : 20,
    },
  });
}

test("proposal enumeration and registration order are semantically irrelevant", () => {
  const instant = nextInstant(1, 0);
  const left = createKernel(false);
  const leftA = routeProposal(left, "proposal:a", ids.supplyRoute, ids.supplySegment, instant);
  const leftB = routeProposal(left, "proposal:b", ids.reportRoute, ids.reportSegment, instant);
  const leftResult = left.commitPhase(instant, [leftB, leftA]);

  const right = createKernel(true);
  const rightA = routeProposal(right, "proposal:a", ids.supplyRoute, ids.supplySegment, instant);
  const rightB = routeProposal(right, "proposal:b", ids.reportRoute, ids.reportSegment, instant);
  const rightResult = right.commitPhase(instant, [rightA, rightB]);

  assert.deepEqual(leftResult.dispositions, rightResult.dispositions);
  assert.deepEqual(left.state(), right.state());
  assert.deepEqual(left.transitions(), right.transitions());
  assert.deepEqual(left.trace(), right.trace());
  assert.equal(left.stateHash(), right.stateHash());
});

test("stable random draws are key-derived, recorded, and independent of registration order", () => {
  const key = {
    seed: "proof00-seed-v1",
    mechanismId: "proof00-grain-allocation",
    mechanismVersion: "1",
    causalInstanceId: `grain-requests:${ids.grainStock}:t${time.grainRequests}`,
    purpose: "fair-request-order",
    drawIndex: 0,
  } as const;
  const first = stableRandom(key);
  const second = stableRandom(structuredClone(key));

  assert.deepEqual(first, second);
  assert.equal(first.keyHash, hash(key));
  assert.ok(first.unitInterval >= 0 && first.unitInterval < 1);
  assert.equal(stableRandomInt(key, 17), Math.floor(first.unitInterval * 17));
  assert.notEqual(stableRandom({ ...key, seed: "another-seed" }).unitInterval, first.unitInterval);

  const normal = runProof00Pair();
  const reversed = runProof00Pair({ reverseRegistration: true });
  assert.deepEqual(normal.base.artifact.randomDraws, reversed.base.artifact.randomDraws);
  assert.deepEqual(normal.base.artifact.randomDraws, normal.anchored.artifact.randomDraws);
  assert.equal(normal.base.artifact.randomDraws.length, 1);
});

test("premature movement completion is rejected while arrival at the bound commits", () => {
  const runCase = (arrival: number) => {
    const kernel = createKernel();
    const startInstant = nextInstant(0, 1);
    const start = makeProposal(kernel, {
      id: `proposal:start-report:${arrival}`,
      source: "movement",
      instant: startInstant,
      subjects: [ids.clerk, ids.reportMovement],
      causalParents: [],
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
          cargoIds: [],
          routeId: ids.reportRoute,
          origin: ids.northGate,
          destination: ids.councilHall,
          startedAt: startInstant,
          earliestArrival: nextInstant(time.anchoredReportArrival, 0),
          currentSegmentIndex: 0,
          status: "in-progress",
        },
      },
    });
    const started = kernel.commitPhase(startInstant, [start]);
    assert.equal(started.dispositions[0]?.kind, "accepted");
    const parent = started.traceNodes.find(({ kind }) => kind === "committed-transition")!.id;

    const completeInstant = nextInstant(arrival, 0);
    const complete = makeProposal(kernel, {
      id: `proposal:complete-report:${arrival}`,
      source: "movement",
      instant: completeInstant,
      subjects: [ids.clerk, ids.reportMovement],
      causalParents: [parent],
      readPaths: [
        paths.movement(ids.reportMovement),
        paths.actorLocation(ids.clerk),
        paths.route(ids.reportRoute),
      ],
      effectPaths: [paths.movement(ids.reportMovement), paths.actorLocation(ids.clerk)],
      action: { kind: "complete-movement", movementId: ids.reportMovement },
    });
    return { kernel, result: kernel.commitPhase(completeInstant, [complete]) };
  };

  const early = runCase(time.anchoredReportArrival - 1);
  assert.equal(early.result.dispositions[0]?.kind, "rejected");
  assert.match(early.result.dispositions[0]?.reasonCode ?? "", /premature-arrival/);
  assert.equal(early.kernel.state().movements[ids.reportMovement]?.status, "in-progress");
  assert.deepEqual(early.kernel.state().actors[ids.clerk]?.location, {
    kind: "in-transit",
    movementId: ids.reportMovement,
  });

  const onTime = runCase(time.anchoredReportArrival);
  assert.equal(onTime.result.dispositions[0]?.kind, "accepted");
  assert.equal(onTime.kernel.state().movements[ids.reportMovement]?.status, "arrived");
  assert.deepEqual(onTime.kernel.state().actors[ids.clerk]?.location, {
    kind: "at-place",
    placeId: ids.councilHall,
  });
});

test("a route blocked after departure prevents completion and remains causally bound", () => {
  const kernel = createKernel();
  const startInstant = nextInstant(0, 1);
  const start = makeProposal(kernel, {
    id: "proposal:start-before-midroute-block",
    source: "movement",
    instant: startInstant,
    subjects: [ids.clerk, ids.reportMovement],
    causalParents: [],
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
        cargoIds: [],
        routeId: ids.reportRoute,
        origin: ids.northGate,
        destination: ids.councilHall,
        startedAt: startInstant,
        earliestArrival: nextInstant(time.anchoredReportArrival, 0),
        currentSegmentIndex: 0,
        status: "in-progress",
      },
    },
  });
  const started = kernel.commitPhase(startInstant, [start]);
  const startParent = started.traceNodes.find(({ kind }) => kind === "committed-transition")!.id;

  const blockInstant = nextInstant(1, 0);
  const block = makeProposal(kernel, {
    id: "proposal:block-report-route-midjourney",
    source: "weather",
    instant: blockInstant,
    subjects: [ids.reportRoute],
    causalParents: [],
    readPaths: [paths.route(ids.reportRoute)],
    effectPaths: [paths.route(ids.reportRoute)],
    action: {
      kind: "set-route-state",
      routeId: ids.reportRoute,
      segmentId: ids.reportSegment,
      status: "blocked",
      delayMinutes: 0,
    },
  });
  assert.equal(kernel.commitPhase(blockInstant, [block]).dispositions[0]?.kind, "accepted");

  const completeInstant = nextInstant(time.anchoredReportArrival, 0);
  const complete = makeProposal(kernel, {
    id: "proposal:cannot-complete-through-new-block",
    source: "movement",
    instant: completeInstant,
    subjects: [ids.clerk, ids.reportMovement],
    causalParents: [startParent],
    readPaths: [
      paths.movement(ids.reportMovement),
      paths.actorLocation(ids.clerk),
      paths.route(ids.reportRoute),
    ],
    effectPaths: [paths.movement(ids.reportMovement), paths.actorLocation(ids.clerk)],
    action: { kind: "complete-movement", movementId: ids.reportMovement },
  });
  const result = kernel.commitPhase(completeInstant, [complete]);
  assert.equal(result.dispositions[0]?.kind, "rejected");
  assert.match(result.dispositions[0]?.reasonCode ?? "", /arrival-route-blocked/);
  assert.ok(complete.readSet.find(({ path }) => path === paths.route(ids.reportRoute))?.producerTraceId);
  assert.equal(kernel.state().movements[ids.reportMovement]?.status, "in-progress");
});

test("duplicate proposal ids are rejected atomically", () => {
  const kernel = createKernel();
  const instant = nextInstant(1, 0);
  const proposal = routeProposal(
    kernel,
    "proposal:duplicate",
    ids.supplyRoute,
    ids.supplySegment,
    instant,
  );
  const before = kernel.stateHash();
  const result = kernel.commitPhase(instant, [proposal, structuredClone(proposal)]);

  assert.equal(result.transitions.length, 0);
  assert.equal(kernel.stateHash(), before);
  assert.equal(result.dispositions.length, 2);
  assert.ok(result.dispositions.every(({ kind }) => kind === "rejected"));
  assert.ok(result.dispositions.every(({ reasonCode }) =>
    reasonCode?.includes("duplicate-proposal-id")
  ));
  assert.equal(new Set(result.traceNodes.map(({ id }) => id)).size, result.traceNodes.length);
});

test("colon-qualified entity ids round-trip through versioned State Paths", () => {
  const kernel = createKernel();
  const state = kernel.state();

  assert.equal(kernel.read(paths.actor(ids.chair)).valueHash, hash(state.actors[ids.chair]));
  assert.equal(kernel.read(paths.route(ids.reportRoute)).valueHash, hash(state.routes[ids.reportRoute]));
  assert.equal(kernel.read(paths.grain(ids.grainStock)).valueHash, hash(state.grainStocks[ids.grainStock]));
  assert.equal(
    kernel.read(paths.organizationRecords(ids.council, "clerk")).valueHash,
    hash(state.organizations[ids.council]!.recordsByRole.clerk),
  );
});

test("read-only extensions receive clones and hidden apply effects fail closed", () => {
  type TinyState = { revision: number; instant: ReturnType<typeof nextInstant>; x: number; y: number };
  const adapter = {
    clone: (state: TinyState) => structuredClone(state),
    hash,
    read: (state: TinyState, path: string) => state[path as "x" | "y"],
    setKernelMeta: (state: TinyState, revision: number, instant: ReturnType<typeof nextInstant>) => {
      state.revision = revision;
      state.instant = instant;
    },
    validateInvariants: () => [],
    diffPaths: (before: TinyState, after: TinyState) =>
      (["x", "y"] as const).filter((path) => before[path] !== after[path]),
  };
  const initial = { revision: 0, instant: nextInstant(0, 0), x: 0, y: 0 };

  const build = (hiddenApply: boolean) => {
    const kernel = new Kernel(initial, adapter);
    kernel.registerMechanism({
      id: "tiny",
      version: "1",
      capabilities: ["set-x"],
      actionKinds: ["set-x"],
      requiredValidators: [],
      footprint: (_proposal, snapshot) => {
        snapshot.y = 99;
        return ["x"];
      },
      apply: (_proposal, draft) => {
        draft.x = 1;
        if (hiddenApply) draft.y = 5;
        return [{ operation: "set", path: "x", value: 1 }];
      },
    });
    const instant = nextInstant(1, 0);
    const proposal: TransitionProposal = {
      id: `proposal:tiny:${hiddenApply}`,
      source: "tiny",
      version: "1",
      authority: { kind: "mechanism", principalId: "tiny", capability: "set-x" },
      subjects: ["x"],
      instant,
      causalParents: [],
      readSet: [kernel.read("x")],
      preconditions: [],
      effectScope: { paths: ["x"], entityIds: ["x"] },
      resourceClaims: [],
      permissionClaims: [{ capability: "set-x", subjectId: "tiny", objectId: "x" }],
      validators: [],
      action: { kind: "set-x" },
    };
    return { kernel, result: kernel.commitPhase(instant, [proposal]) };
  };

  const clean = build(false);
  assert.equal(clean.result.dispositions[0]?.kind, "accepted");
  assert.equal(clean.kernel.state().x, 1);
  assert.equal(clean.kernel.state().y, 0);

  const hidden = build(true);
  assert.equal(hidden.result.dispositions[0]?.kind, "rejected");
  assert.match(hidden.result.dispositions[0]?.reasonCode ?? "", /hidden-effect-scope/);
  assert.deepEqual(hidden.kernel.state(), initial);
});

test("a proposal cannot cite a disposition created later in its own causal phase", () => {
  const instant = nextInstant(1, 0);
  const dry = createKernel();
  const dryFirst = routeProposal(
    dry,
    "proposal:first",
    ids.supplyRoute,
    ids.supplySegment,
    instant,
  );
  const predictedFirstTraceId = dry.commitPhase(instant, [dryFirst]).traceNodes
    .find(({ kind }) => kind === "proposal-disposition")!.id;

  const kernel = createKernel();
  const first = routeProposal(
    kernel,
    "proposal:first",
    ids.supplyRoute,
    ids.supplySegment,
    instant,
  );
  const feedback = routeProposal(
    kernel,
    "proposal:feedback",
    ids.reportRoute,
    ids.reportSegment,
    instant,
    [predictedFirstTraceId],
  );
  const result = kernel.commitPhase(instant, [feedback, first]);
  const firstDisposition = result.dispositions.find(({ proposalId }) => proposalId === first.id)!;
  const feedbackDisposition = result.dispositions.find(({ proposalId }) => proposalId === feedback.id)!;
  const actualFirstTraceId = result.traceNodes.find((node) =>
    node.kind === "proposal-disposition" &&
    (node.payload as { proposalId?: string }).proposalId === first.id
  )!.id;

  assert.equal(actualFirstTraceId, predictedFirstTraceId);
  assert.equal(firstDisposition.kind, "accepted");
  assert.equal(feedbackDisposition.kind, "rejected");
  assert.match(feedbackDisposition.reasonCode ?? "", /same-phase-or-missing-parent/);
  assert.equal(kernel.state().routes[ids.reportRoute]?.revision, 0);
  const feedbackTrace = result.traceNodes.find((node) =>
    (node.payload as { proposalId?: string }).proposalId === feedback.id
  )!;
  assert.deepEqual(feedbackTrace.causalParents, []);
  assert.deepEqual(
    (feedbackTrace.payload as { proposal: { causalParents: readonly string[] } }).proposal.causalParents,
    [predictedFirstTraceId],
  );
});

test("a causal phase cannot be committed twice, even after a rejection", () => {
  const kernel = createKernel();
  const instant = nextInstant(1, 0);
  const invalid = routeProposal(kernel, "proposal:bad-first", ids.supplyRoute, "missing-segment", instant);
  assert.equal(kernel.commitPhase(instant, [invalid]).dispositions[0]?.kind, "rejected");
  const later = routeProposal(kernel, "proposal:same-phase", ids.reportRoute, ids.reportSegment, instant);
  assert.throws(() => kernel.commitPhase(instant, [later]), /Causal phase must increase strictly/);
});

test("stale reads, under-declared Effect Scope, and missing validators fail closed", async (t) => {
  await t.test("stale read", () => {
    const kernel = createKernel();
    const stale = routeProposal(
      kernel,
      "proposal:stale",
      ids.supplyRoute,
      ids.supplySegment,
      nextInstant(2, 0),
    );
    const fresh = routeProposal(
      kernel,
      "proposal:fresh",
      ids.supplyRoute,
      ids.supplySegment,
      nextInstant(1, 0),
    );
    assert.equal(kernel.commitPhase(nextInstant(1, 0), [fresh]).dispositions[0]?.kind, "accepted");

    const result = kernel.commitPhase(nextInstant(2, 0), [stale]);
    assert.equal(result.dispositions[0]?.kind, "stale");
    assert.match(result.dispositions[0]?.reasonCode ?? "", /stale-read/);
    assert.equal(result.transitions.length, 0);
  });

  await t.test("under-declared Effect Scope", () => {
    const kernel = createKernel();
    const instant = nextInstant(1, 0);
    const proposal = makeProposal(kernel, {
      id: "proposal:under-scoped",
      source: "weather",
      instant,
      subjects: [ids.supplyRoute],
      causalParents: [],
      readPaths: [paths.route(ids.supplyRoute)],
      effectPaths: [],
      action: {
        kind: "set-route-state",
        routeId: ids.supplyRoute,
        segmentId: ids.supplySegment,
        status: "delayed",
        delayMinutes: 10,
      },
    });
    const result = kernel.commitPhase(instant, [proposal]);
    assert.equal(result.dispositions[0]?.kind, "rejected");
    assert.match(result.dispositions[0]?.reasonCode ?? "", /effect-scope/);
    assert.equal(result.transitions.length, 0);
  });

  await t.test("missing mandatory validators", () => {
    const kernel = createKernel();
    const instant = nextInstant(1, 0);
    const proposal = routeProposal(
      kernel,
      "proposal:no-validators",
      ids.supplyRoute,
      ids.supplySegment,
      instant,
    );
    const invalid = {
      ...proposal,
      validators: [],
    } satisfies TransitionProposal<Proof00Action>;
    const result = kernel.commitPhase(instant, [invalid]);

    assert.equal(result.dispositions[0]?.kind, "rejected");
    assert.match(result.dispositions[0]?.reasonCode ?? "", /missing-validator/);
    assert.equal(result.transitions.length, 0);
    assert.deepEqual(proposal.validators, [ACTION_VALIDATOR, PRECONDITION_VALIDATOR]);
  });
});
