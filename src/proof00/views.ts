import { hash, stableRandom } from "../kernel/stable.ts";
import type {
  ActorDecisionContext,
  ActorProposerContribution,
  RunArtifact,
  TraceNode,
} from "../kernel/types.ts";

export type ExplanationTarget =
  | { readonly kind: "trace-node"; readonly id: string }
  | { readonly kind: "proposal"; readonly id: string }
  | { readonly kind: "transition"; readonly id: string };

export interface AuditEvidenceNode {
  readonly node: TraceNode;
  readonly causalRole: "target" | "causal-parent";
  readonly evidenceStatus: "recorded";
  readonly mechanismVersions: readonly string[];
}

export interface AuditExplanation {
  readonly view: "audit";
  readonly audience: "audit";
  readonly target: ExplanationTarget;
  readonly established: boolean;
  readonly summary: string;
  readonly targetTraceNodeIds: readonly string[];
  /** Ancestors are ordered before the nodes which cite them. */
  readonly evidence: readonly AuditEvidenceNode[];
  readonly missingTraceNodeIds: readonly string[];
  readonly causalCycles: readonly (readonly string[])[];
}

export interface PerspectiveTraceEvidence {
  readonly id: string;
  readonly kind: string;
  readonly instant: TraceNode["instant"];
  readonly causalParents: readonly string[];
  readonly subjects: readonly string[];
  readonly payload: unknown;
  readonly payloadHash: string;
}

export interface PerspectiveContribution {
  readonly requestHash: string;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly schemaVersion: string;
  readonly attemptCount: number;
  readonly context: Omit<ActorDecisionContext, "perceivedState"> & {
    readonly perceivedState: unknown;
  };
  readonly result: ActorProposerContribution["result"];
}

export interface ActorPerspectiveExplanation {
  readonly view: "actor-perspective";
  readonly audience: string;
  readonly actorId: string;
  readonly target?: ExplanationTarget;
  readonly established: boolean;
  readonly summary: string;
  readonly evidence: readonly PerspectiveTraceEvidence[];
  readonly actorContributions: readonly PerspectiveContribution[];
  /** True means some causal evidence exists but is not visible to this actor. */
  readonly withheldEvidence: boolean;
}

export interface WhyNotBlocker {
  readonly kind: "validation" | "coordination" | "staleness" | "incomplete";
  readonly code: string;
  readonly message: string;
  readonly sourceTraceNodeIds: readonly string[];
  readonly evidenceStatus: "recorded";
}

export interface WhyNotExplanation {
  readonly view: "why-not";
  readonly audience: "audit";
  readonly proposalId: string;
  readonly established: boolean;
  readonly disposition?: string;
  readonly summary: string;
  readonly blockers: readonly WhyNotBlocker[];
  readonly grounding?: AuditExplanation;
  readonly suggestedNextStep?: "run-anchored-comparison";
}

export interface ValueDelta {
  readonly path: string;
  readonly leftPresent: boolean;
  readonly rightPresent: boolean;
  readonly leftHash: string;
  readonly rightHash: string;
  readonly leftValue?: unknown;
  readonly rightValue?: unknown;
  readonly material: boolean;
}

export interface TraceDifferencePoint {
  readonly index: number;
  readonly left?: TraceNode;
  readonly right?: TraceNode;
  readonly source: "trace" | "final-state";
}

export interface RunArtifactDifference {
  readonly leftRunId: string;
  readonly rightRunId: string;
  readonly sameMaterialHistory: boolean;
  readonly commonTracePrefixLength: number;
  readonly lastCommonTraceNode?: TraceNode;
  readonly firstMaterialDivergence?: TraceDifferencePoint;
  readonly inputDelta: {
    readonly declaredAnchorDeltaHashes: readonly string[];
    readonly manifest: readonly ValueDelta[];
    readonly initialState: readonly ValueDelta[];
    readonly actorProposerContributions: readonly ValueDelta[];
    readonly firstDivergentTracePayload: readonly ValueDelta[];
  };
  readonly changedOutcomes: readonly ValueDelta[];
  readonly leftDownstreamCausalDescendants: readonly TraceNode[];
  readonly rightDownstreamCausalDescendants: readonly TraceNode[];
}

export interface ReplayVerificationMismatch {
  readonly code: string;
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface ReplayVerification {
  readonly ok: boolean;
  readonly checked: readonly string[];
  readonly mismatches: readonly ReplayVerificationMismatch[];
}

type JsonRecord = Record<string, unknown>;

const ABSENT = Object.freeze({ $artifactValue: "absent" });
const REDACTED = "[redacted: not available in actor perspective]";

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function payloadRecord(node: TraceNode): JsonRecord | undefined {
  return isRecord(node.payload) ? node.payload : undefined;
}

function proposalIdOf(node: TraceNode): string | undefined {
  const payload = payloadRecord(node);
  if (typeof payload?.proposalId === "string") return payload.proposalId;
  const disposition = payload?.disposition;
  if (isRecord(disposition) && typeof disposition.proposalId === "string") {
    return disposition.proposalId;
  }
  return undefined;
}

function transitionIdOf(node: TraceNode): string | undefined {
  const payload = payloadRecord(node);
  const transition = payload?.transition;
  if (isRecord(transition) && typeof transition.id === "string") {
    return transition.id;
  }
  return undefined;
}

function mechanismVersionsOf(node: TraceNode): readonly string[] {
  const payload = payloadRecord(node);
  const result = new Set<string>();
  if (typeof payload?.mechanism === "string") result.add(payload.mechanism);
  const proposal = payload?.proposal;
  if (
    isRecord(proposal) &&
    typeof proposal.source === "string" &&
    typeof proposal.version === "string"
  ) {
    result.add(`${proposal.source}@${proposal.version}`);
  }
  return [...result].sort();
}

function resolveTargetTraceIds(
  artifact: RunArtifact,
  target: ExplanationTarget,
): readonly string[] {
  if (target.kind === "trace-node") {
    return artifact.trace.some((node) => node.id === target.id) ? [target.id] : [];
  }
  if (target.kind === "proposal") {
    return artifact.trace
      .filter((node) => proposalIdOf(node) === target.id)
      .map((node) => node.id);
  }

  const committedNodes = artifact.trace.filter(
    (node) => transitionIdOf(node) === target.id,
  );
  if (committedNodes.length > 0) return committedNodes.map((node) => node.id);

  // A malformed artifact may contain a transition record but no committed
  // transition trace node. Do not fabricate evidence: return no target node.
  return [];
}

interface ClosureResult {
  readonly nodes: readonly TraceNode[];
  readonly missing: readonly string[];
  readonly cycles: readonly (readonly string[])[];
}

function traceClosure(
  artifact: RunArtifact,
  targetIds: readonly string[],
): ClosureResult {
  const byId = new Map(artifact.trace.map((node) => [node.id, node]));
  const state = new Map<string, "visiting" | "visited">();
  const nodes: TraceNode[] = [];
  const missing = new Set<string>();
  const cycles: string[][] = [];

  const visit = (id: string, stack: readonly string[]): void => {
    const visitState = state.get(id);
    if (visitState === "visited") return;
    if (visitState === "visiting") {
      const cycleStart = stack.indexOf(id);
      cycles.push([...(cycleStart >= 0 ? stack.slice(cycleStart) : stack), id]);
      return;
    }

    const node = byId.get(id);
    if (!node) {
      missing.add(id);
      return;
    }

    state.set(id, "visiting");
    for (const parentId of node.causalParents) visit(parentId, [...stack, id]);
    state.set(id, "visited");
    nodes.push(node);
  };

  for (const id of targetIds) visit(id, []);
  return {
    nodes,
    missing: [...missing].sort(),
    cycles: cycles.sort((left, right) => {
      const leftKey = left.join("/");
      const rightKey = right.join("/");
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  };
}

/** Return the complete recorded causal ancestry for an audit target. */
export function explainAudit(
  artifact: RunArtifact,
  target: ExplanationTarget,
): AuditExplanation {
  const targetTraceNodeIds = resolveTargetTraceIds(artifact, target);
  const closure = traceClosure(artifact, targetTraceNodeIds);
  const targetSet = new Set(targetTraceNodeIds);
  const established = targetTraceNodeIds.length > 0 && closure.missing.length === 0;

  return {
    view: "audit",
    audience: "audit",
    target: clone(target),
    established,
    summary: targetTraceNodeIds.length === 0
      ? `No recorded trace evidence resolves ${target.kind} ${target.id}.`
      : closure.missing.length > 0
        ? `Recorded evidence for ${target.kind} ${target.id} has missing causal parents.`
        : `Recorded causal ancestry for ${target.kind} ${target.id}.`,
    targetTraceNodeIds: [...targetTraceNodeIds],
    evidence: closure.nodes.map((node) => ({
      node: clone(node),
      causalRole: targetSet.has(node.id) ? "target" : "causal-parent",
      evidenceStatus: "recorded",
      mechanismVersions: mechanismVersionsOf(node),
    })),
    missingTraceNodeIds: closure.missing,
    causalCycles: closure.cycles,
  };
}

function instantAtOrBefore(
  value: ActorDecisionContext["instant"],
  limit: TraceNode["instant"] | undefined,
): boolean {
  if (!limit) return true;
  if (value.worldTime !== limit.worldTime) return value.worldTime < limit.worldTime;
  return value.causalPhase <= limit.causalPhase;
}

function traceVisibleTo(node: TraceNode, actorId: string): boolean {
  return Array.isArray(node.permittedAudience) && node.permittedAudience.includes(actorId);
}

function claimIdFromRecord(value: JsonRecord): string | undefined {
  if (typeof value.id !== "string") return undefined;
  const looksLikeClaim =
    "proposition" in value ||
    value.kind === "official-report" ||
    value.kind === "rumor" ||
    value.kind === "organization-order";
  return looksLikeClaim ? value.id : undefined;
}

/**
 * Defensively redact claim-shaped objects unless their id appeared in the
 * actor's contemporaneous EpistemicSnapshot. Explicit trace permissions are
 * necessary for a node to be selected but do not override this claim check.
 */
function sanitizeForActor(
  value: unknown,
  accessibleClaimIds: ReadonlySet<string>,
  ancestors = new Set<object>(),
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return REDACTED;
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry) => sanitizeForActor(entry, accessibleClaimIds, ancestors));
    }

    const record = value as JsonRecord;
    const claimId = claimIdFromRecord(record);
    if (claimId && !accessibleClaimIds.has(claimId)) {
      return { id: claimId, redacted: "claim-not-accessible" };
    }

    const result: JsonRecord = {};
    for (const key of Object.keys(record).sort()) {
      if (/^(?:rawOutput|prompt|systemPrompt|creatorGuidance|hiddenState|worldTruth)$/i.test(key)) {
        result[key] = REDACTED;
      } else if (key === "proposition" && (!claimId || !accessibleClaimIds.has(claimId))) {
        result[key] = REDACTED;
      } else {
        result[key] = sanitizeForActor(record[key], accessibleClaimIds, ancestors);
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function contributionForPerspective(
  contribution: ActorProposerContribution,
): PerspectiveContribution {
  const accessible = new Set(contribution.context.epistemicState.accessibleClaimIds);
  return {
    requestHash: contribution.requestHash,
    provider: contribution.provider,
    model: contribution.model,
    modelVersion: contribution.modelVersion,
    schemaVersion: contribution.schemaVersion,
    attemptCount: contribution.attemptCount,
    context: {
      schemaVersion: contribution.context.schemaVersion,
      triggerId: contribution.context.triggerId,
      actorId: contribution.context.actorId,
      instant: clone(contribution.context.instant),
      epistemicState: clone(contribution.context.epistemicState),
      perceivedState: sanitizeForActor(contribution.context.perceivedState, accessible),
      availableRoles: [...contribution.context.availableRoles],
      allowedActionKinds: [...contribution.context.allowedActionKinds],
      evidenceRefs: [...contribution.context.evidenceRefs],
      contextHash: contribution.context.contextHash,
    },
    result: sanitizeForActor(contribution.result, accessible) as ActorProposerContribution["result"],
  };
}

/**
 * Return only evidence the actor was permitted to see, plus that actor's own
 * recorded ActorProposer context/result. Audit-only nodes are never promoted
 * merely because an ActorProposer context cites their ids.
 */
export function explainActorPerspective(
  artifact: RunArtifact,
  actorId: string,
  target?: ExplanationTarget,
): ActorPerspectiveExplanation {
  const targetIds = target ? resolveTargetTraceIds(artifact, target) : artifact.trace.map((node) => node.id);
  const closure = traceClosure(artifact, targetIds);
  const targetInstant = target
    ? targetIds
        .map((id) => artifact.trace.find((node) => node.id === id)?.instant)
        .find((instant): instant is TraceNode["instant"] => Boolean(instant))
    : undefined;
  const contributions = artifact.actorProposerContributions.filter(
    (contribution) =>
      contribution.context.actorId === actorId &&
      instantAtOrBefore(contribution.context.instant, targetInstant),
  );
  const accessibleClaims = new Set(
    contributions.flatMap((contribution) => [
      ...contribution.context.epistemicState.accessibleClaimIds,
    ]),
  );
  const visibleNodes = closure.nodes.filter((node) => traceVisibleTo(node, actorId));
  const withheldEvidence = closure.nodes.some((node) => !traceVisibleTo(node, actorId));
  const established = target
    ? targetIds.length > 0 && (visibleNodes.length > 0 || contributions.length > 0)
    : visibleNodes.length > 0 || contributions.length > 0;

  return {
    view: "actor-perspective",
    audience: actorId,
    actorId,
    ...(target ? { target: clone(target) } : {}),
    established,
    summary: established
      ? `Perspective-grounded evidence available to actor ${actorId}.`
      : `No perspective-grounded evidence for actor ${actorId}.`,
    evidence: visibleNodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      instant: clone(node.instant),
      causalParents: node.causalParents.filter((parentId) =>
        visibleNodes.some((candidate) => candidate.id === parentId),
      ),
      subjects: [...node.subjects],
      payload: sanitizeForActor(node.payload, accessibleClaims),
      payloadHash: node.payloadHash,
    })),
    actorContributions: contributions.map(contributionForPerspective),
    withheldEvidence,
  };
}

function dispositionOf(node: TraceNode): JsonRecord | undefined {
  const disposition = payloadRecord(node)?.disposition;
  return isRecord(disposition) ? disposition : undefined;
}

function issueRecords(node: TraceNode): readonly JsonRecord[] {
  const details = payloadRecord(node)?.details;
  if (!isRecord(details) || !Array.isArray(details.issues)) return [];
  return details.issues.filter(isRecord);
}

/** Explain only recorded rejection/staleness/incompleteness blockers. */
export function explainWhyNot(
  artifact: RunArtifact,
  proposalId: string,
): WhyNotExplanation {
  const node = artifact.trace.find(
    (candidate) =>
      candidate.kind === "proposal-disposition" && proposalIdOf(candidate) === proposalId,
  );
  if (!node) {
    return {
      view: "why-not",
      audience: "audit",
      proposalId,
      established: false,
      summary: `No recorded disposition exists for proposal ${proposalId}.`,
      blockers: [],
      suggestedNextStep: "run-anchored-comparison",
    };
  }

  const disposition = dispositionOf(node);
  const kind = typeof disposition?.kind === "string" ? disposition.kind : undefined;
  const rejected = kind === "rejected" || kind === "stale" || kind === "incomplete";
  if (!rejected) {
    return {
      view: "why-not",
      audience: "audit",
      proposalId,
      established: false,
      disposition: kind,
      summary: `Proposal ${proposalId} was not recorded as rejected, stale, or incomplete.`,
      blockers: [],
      grounding: explainAudit(artifact, { kind: "proposal", id: proposalId }),
      suggestedNextStep: "run-anchored-comparison",
    };
  }

  const blockers: WhyNotBlocker[] = issueRecords(node).map((validationIssue) => ({
    kind: kind === "stale" ? "staleness" : kind === "incomplete" ? "incomplete" : "validation",
    code: typeof validationIssue.code === "string" ? validationIssue.code : "validation-failed",
    message: typeof validationIssue.message === "string"
      ? validationIssue.message
      : "A recorded validator rejected the proposal.",
    sourceTraceNodeIds: [node.id],
    evidenceStatus: "recorded",
  }));

  const reasonCode = typeof disposition?.reasonCode === "string"
    ? disposition.reasonCode
    : undefined;
  if (blockers.length === 0 && reasonCode) {
    const details = payloadRecord(node)?.details;
    const coordination = isRecord(details) && typeof details.coordination === "string"
      ? details.coordination
      : undefined;
    blockers.push({
      kind: kind === "stale" ? "staleness" : kind === "incomplete" ? "incomplete" : "coordination",
      code: reasonCode,
      message: coordination
        ? `Recorded coordination result: ${coordination}.`
        : `Recorded proposal disposition: ${reasonCode}.`,
      sourceTraceNodeIds: [node.id],
      evidenceStatus: "recorded",
    });
  }

  return {
    view: "why-not",
    audience: "audit",
    proposalId,
    established: blockers.length > 0,
    disposition: kind,
    summary: blockers.length > 0
      ? `Proposal ${proposalId} did not commit because of recorded blocker(s).`
      : `Proposal ${proposalId} did not commit, but no recorded blocker was recoverable.`,
    blockers,
    grounding: explainAudit(artifact, { kind: "proposal", id: proposalId }),
    ...(blockers.length === 0 ? { suggestedNextStep: "run-anchored-comparison" as const } : {}),
  };
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function presentationPath(path: string): boolean {
  return path
    .split("/")
    .some((segment) => /^(?:name|title|label|description|displayName|notes?|presentation)$/i.test(segment));
}

function diffValues(
  left: unknown,
  right: unknown,
  path = "",
  leftPresent = true,
  rightPresent = true,
): ValueDelta[] {
  const leftComparable = leftPresent ? left : ABSENT;
  const rightComparable = rightPresent ? right : ABSENT;
  if (hash(leftComparable) === hash(rightComparable)) return [];

  if (Array.isArray(left) && Array.isArray(right)) {
    const result: ValueDelta[] = [];
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      result.push(
        ...diffValues(
          left[index],
          right[index],
          `${path}/${index}`,
          index < left.length,
          index < right.length,
        ),
      );
    }
    return result;
  }

  if (isRecord(left) && isRecord(right)) {
    const result: ValueDelta[] = [];
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      result.push(
        ...diffValues(
          left[key],
          right[key],
          `${path}/${pointerSegment(key)}`,
          Object.hasOwn(left, key),
          Object.hasOwn(right, key),
        ),
      );
    }
    return result;
  }

  return [{
    path: path || "/",
    leftPresent,
    rightPresent,
    leftHash: hash(leftComparable),
    rightHash: hash(rightComparable),
    ...(leftPresent ? { leftValue: clone(left) } : {}),
    ...(rightPresent ? { rightValue: clone(right) } : {}),
    material: !presentationPath(path),
  }];
}

function materialTraceHash(node: TraceNode): string {
  // payloadHash is derived integrity metadata and is checked separately.
  const { payloadHash: _payloadHash, ...material } = node;
  return hash(material);
}

function descendantsOf(
  trace: readonly TraceNode[],
  rootId: string | undefined,
): readonly TraceNode[] {
  if (!rootId) return [];
  const reached = new Set([rootId]);
  const descendants: TraceNode[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of trace) {
      if (reached.has(node.id)) continue;
      if (node.causalParents.some((parentId) => reached.has(parentId))) {
        reached.add(node.id);
        descendants.push(clone(node));
        progressed = true;
      }
    }
  }
  return descendants;
}

function causalManifest(manifest: RunArtifact["manifest"]): unknown {
  return {
    contractId: manifest.contractId,
    contractVersion: manifest.contractVersion,
    contractHash: manifest.contractHash,
    initialStateHash: manifest.initialStateHash,
    mechanismVersions: manifest.mechanismVersions,
    schemaVersions: manifest.schemaVersions,
    seed: manifest.seed,
    horizon: manifest.horizon,
    actorProposerContract: manifest.actorProposerContract,
    externalInputs: manifest.externalInputs,
    externalInputsHash: manifest.externalInputsHash,
    recordedContributionSetHash: manifest.recordedContributionSetHash,
  };
}

/** Compare two immutable artifacts without replaying either history. */
export function compareArtifacts(
  left: RunArtifact,
  right: RunArtifact,
): RunArtifactDifference {
  const limit = Math.min(left.trace.length, right.trace.length);
  let commonTracePrefixLength = 0;
  while (
    commonTracePrefixLength < limit &&
    materialTraceHash(left.trace[commonTracePrefixLength]!) ===
      materialTraceHash(right.trace[commonTracePrefixLength]!)
  ) {
    commonTracePrefixLength += 1;
  }

  const leftFirst = left.trace[commonTracePrefixLength];
  const rightFirst = right.trace[commonTracePrefixLength];
  const changedOutcomes = diffValues(left.finalState, right.finalState);
  const materialOutcomeChange = changedOutcomes.some((delta) => delta.material);
  const traceDiverged = commonTracePrefixLength < left.trace.length || commonTracePrefixLength < right.trace.length;
  const firstMaterialDivergence: TraceDifferencePoint | undefined = traceDiverged
    ? {
        index: commonTracePrefixLength,
        ...(leftFirst ? { left: clone(leftFirst) } : {}),
        ...(rightFirst ? { right: clone(rightFirst) } : {}),
        source: "trace",
      }
    : materialOutcomeChange
      ? { index: commonTracePrefixLength, source: "final-state" }
      : undefined;

  const manifestDelta = diffValues(causalManifest(left.manifest), causalManifest(right.manifest), "/manifest");
  const initialStateDelta = diffValues(left.initialState, right.initialState, "/initialState");
  const contributionDelta = diffValues(
    left.actorProposerContributions,
    right.actorProposerContributions,
    "/actorProposerContributions",
  );
  const divergentPayloadDelta = leftFirst || rightFirst
    ? diffValues(
        leftFirst?.payload,
        rightFirst?.payload,
        "/firstDivergentTracePayload",
        Boolean(leftFirst),
        Boolean(rightFirst),
      )
    : [];
  const declaredAnchorDeltaHashes = [...new Set(
    [left.manifest.anchor?.inputDeltaHash, right.manifest.anchor?.inputDeltaHash]
      .filter((value): value is string => Boolean(value)),
  )].sort();

  return {
    leftRunId: left.manifest.runId,
    rightRunId: right.manifest.runId,
    sameMaterialHistory: firstMaterialDivergence === undefined,
    commonTracePrefixLength,
    ...(commonTracePrefixLength > 0
      ? { lastCommonTraceNode: clone(left.trace[commonTracePrefixLength - 1]!) }
      : {}),
    ...(firstMaterialDivergence ? { firstMaterialDivergence } : {}),
    inputDelta: {
      declaredAnchorDeltaHashes,
      manifest: manifestDelta,
      initialState: initialStateDelta,
      actorProposerContributions: contributionDelta,
      firstDivergentTracePayload: divergentPayloadDelta,
    },
    changedOutcomes,
    leftDownstreamCausalDescendants: descendantsOf(left.trace, leftFirst?.id),
    rightDownstreamCausalDescendants: descendantsOf(right.trace, rightFirst?.id),
  };
}

function mismatch(
  mismatches: ReplayVerificationMismatch[],
  code: string,
  path: string,
  expected: unknown,
  actual: unknown,
): void {
  if (expected !== actual) mismatches.push({ code, path, expected, actual });
}

function expectedTraceId(node: TraceNode): string | undefined {
  const payload = payloadRecord(node);
  if (node.kind === "proposal-disposition") {
    const proposalId = proposalIdOf(node);
    const disposition = payload?.disposition;
    const proposal = payload?.proposal;
    if (proposalId && disposition !== undefined && proposal !== undefined) {
      return `trace:${hash({
        kind: node.kind,
        instant: node.instant,
        stableIdentity: { proposalId, proposalHash: hash(proposal), disposition },
      }).slice(0, 24)}`;
    }
  }
  if (node.kind === "committed-transition") {
    const transitionId = transitionIdOf(node);
    if (transitionId) {
      return `trace:${hash({
        kind: node.kind,
        instant: node.instant,
        stableIdentity: transitionId,
      }).slice(0, 24)}`;
    }
  }
  return undefined;
}

function contextMaterial(context: ActorDecisionContext): unknown {
  const { contextHash: _contextHash, ...material } = context;
  return material;
}

/**
 * Recompute every hash derivable from a RunArtifact alone. This verifies
 * artifact integrity and continuity; it does not execute mechanisms or prove
 * that recorded state changes obey a domain model.
 */
export function verifyReplayArtifact(artifact: RunArtifact): ReplayVerification {
  const mismatches: ReplayVerificationMismatch[] = [];
  const checked: string[] = [];

  checked.push("manifest.initialStateHash");
  mismatch(
    mismatches,
    "initial-state-hash",
    "/manifest/initialStateHash",
    hash(artifact.initialState),
    artifact.manifest.initialStateHash,
  );

  checked.push("finalStateHash");
  mismatch(
    mismatches,
    "final-state-hash",
    "/finalStateHash",
    hash(artifact.finalState),
    artifact.finalStateHash,
  );

  for (let index = 0; index < artifact.trace.length; index += 1) {
    const node = artifact.trace[index]!;
    checked.push(`trace[${index}].payloadHash`);
    mismatch(
      mismatches,
      "trace-payload-hash",
      `/trace/${index}/payloadHash`,
      hash(node.payload),
      node.payloadHash,
    );
    const expectedId = expectedTraceId(node);
    if (expectedId) {
      checked.push(`trace[${index}].id`);
      mismatch(mismatches, "trace-id", `/trace/${index}/id`, expectedId, node.id);
    }
  }

  checked.push("traceHash");
  mismatch(
    mismatches,
    "trace-hash",
    "/traceHash",
    hash(artifact.trace),
    artifact.traceHash,
  );

  const traceIndex = new Map<string, number>();
  for (let index = 0; index < artifact.trace.length; index += 1) {
    const node = artifact.trace[index]!;
    checked.push(`trace[${index}].causalParents`);
    if (traceIndex.has(node.id)) {
      mismatches.push({
        code: "duplicate-trace-id",
        path: `/trace/${index}/id`,
        expected: "unique trace id",
        actual: node.id,
      });
    }
    for (const parentId of node.causalParents) {
      if (!traceIndex.has(parentId)) {
        mismatches.push({
          code: "missing-or-forward-causal-parent",
          path: `/trace/${index}/causalParents`,
          expected: "a trace id recorded at an earlier index",
          actual: parentId,
        });
      }
    }
    traceIndex.set(node.id, index);
  }

  let expectedBeforeHash = artifact.manifest.initialStateHash;
  for (let index = 0; index < artifact.transitions.length; index += 1) {
    const transition = artifact.transitions[index]!;
    checked.push(`transitions[${index}].beforeStateHash`);
    mismatch(
      mismatches,
      "transition-hash-chain",
      `/transitions/${index}/beforeStateHash`,
      expectedBeforeHash,
      transition.beforeStateHash,
    );
    const proposalHashes = transition.proposalIds.map((proposalId) => {
      const proposalNode = artifact.trace.find((node) => {
        const payload = payloadRecord(node);
        const details = payload?.details;
        return proposalIdOf(node) === proposalId &&
          isRecord(details) &&
          details.transitionId === transition.id;
      });
      const proposal = proposalNode ? payloadRecord(proposalNode)?.proposal : undefined;
      return proposal === undefined ? `missing:${proposalId}` : hash(proposal);
    }).sort();
    const expectedId = `transition:${hash({
      instant: transition.instant,
      proposalHashes,
      beforeStateHash: transition.beforeStateHash,
      afterStateHash: transition.afterStateHash,
    }).slice(0, 24)}`;
    checked.push(`transitions[${index}].id`);
    mismatch(
      mismatches,
      "transition-id",
      `/transitions/${index}/id`,
      expectedId,
      transition.id,
    );
    expectedBeforeHash = transition.afterStateHash;
  }
  checked.push("transitions.finalStateHash");
  mismatch(
    mismatches,
    "transition-final-hash",
    "/transitions",
    artifact.finalStateHash,
    expectedBeforeHash,
  );

  for (let index = 0; index < artifact.randomDraws.length; index += 1) {
    const draw = artifact.randomDraws[index]!;
    const recomputed = stableRandom(draw.key);
    checked.push(`randomDraws[${index}]`);
    mismatch(
      mismatches,
      "random-key-hash",
      `/randomDraws/${index}/keyHash`,
      recomputed.keyHash,
      draw.keyHash,
    );
    mismatch(
      mismatches,
      "random-value",
      `/randomDraws/${index}/unitInterval`,
      recomputed.unitInterval,
      draw.unitInterval,
    );
  }

  for (let index = 0; index < artifact.actorProposerContributions.length; index += 1) {
    const contribution = artifact.actorProposerContributions[index]!;
    checked.push(`actorProposerContributions[${index}].context.contextHash`);
    mismatch(
      mismatches,
      "actor-context-hash",
      `/actorProposerContributions/${index}/context/contextHash`,
      hash(contextMaterial(contribution.context)),
      contribution.context.contextHash,
    );
  }

  return {
    ok: mismatches.length === 0,
    checked,
    mismatches,
  };
}

export const auditExplanation = explainAudit;
export const perspectiveExplanation = explainActorPerspective;
export const whyNotExplanation = explainWhyNot;
export const compareRunArtifacts = compareArtifacts;
export const verifyReplay = verifyReplayArtifact;
