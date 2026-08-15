import type {
  ActorDecisionContext,
  ActorProposerContribution,
  CandidateActionSet,
  Hash,
  Proof00ActorAction,
} from "../kernel/types.ts";
import { hash, stableStringify } from "../kernel/stable.ts";

export const ACTOR_PROPOSER_CONTRACT_VERSION = "proof00.actor-proposer.v1";
export const CANDIDATE_ACTION_SET_SCHEMA_VERSION =
  "proof00.candidate-action-set.v1";

type ActionWithKind = { readonly kind: string };

export interface ActorProposerRequest<PerceivedState = unknown> {
  readonly contractVersion: typeof ACTOR_PROPOSER_CONTRACT_VERSION;
  readonly resultSchemaVersion: string;
  readonly context: ActorDecisionContext<PerceivedState>;
  readonly contextHash: Hash;
  readonly requestHash: Hash;
}

export interface ActorProposerValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ActorProposerValidationRecord {
  readonly accepted: true;
  readonly validatorVersion: "proof00.actor-proposer-validator.v1";
  readonly issueCount: 0;
}

export interface RecordedActorProposerContribution<
  Action extends ActionWithKind = Proof00ActorAction,
  PerceivedState = unknown,
> extends ActorProposerContribution<Action> {
  readonly context: ActorDecisionContext<PerceivedState>;
  readonly contractVersion: typeof ACTOR_PROPOSER_CONTRACT_VERSION;
  readonly contextHash: Hash;
  readonly promptHash: Hash;
  readonly sampling: Readonly<Record<string, unknown>>;
  readonly samplingHash: Hash;
  readonly rawOutput: string;
  readonly rawOutputHash: Hash;
  readonly parsedResultHash: Hash;
  readonly validation: ActorProposerValidationRecord;
  readonly validationHash: Hash;
  readonly disposition: "accepted";
  readonly contributionHash: Hash;
}

export interface ActorProposerSuccess<
  Action extends ActionWithKind = Proof00ActorAction,
  PerceivedState = unknown,
> {
  readonly ok: true;
  readonly status: "success";
  readonly mode: "cassette" | "replay";
  readonly contribution: RecordedActorProposerContribution<
    Action,
    PerceivedState
  >;
  /** Cassette execution and replay are deliberately unable to call a model. */
  readonly externalModelCallCount: 0;
}

export interface ActorProposerTechnicalFailure {
  readonly ok: false;
  readonly status: "technical-failure";
  readonly disposition: "incomplete";
  readonly triggerId: string;
  readonly actorId: string;
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

export type ActorProposerResult<
  Action extends ActionWithKind = Proof00ActorAction,
  PerceivedState = unknown,
> =
  | ActorProposerSuccess<Action, PerceivedState>
  | ActorProposerTechnicalFailure;

export interface ActorProposerBoundary<
  Action extends ActionWithKind = Proof00ActorAction,
  PerceivedState = unknown,
> {
  propose(
    context: ActorDecisionContext<PerceivedState>,
  ): ActorProposerResult<Action, PerceivedState>;
}

/** Scenario-facing name for the synchronous, deterministic boundary. */
export interface ActorProposer<
  Action extends ActionWithKind = Proof00ActorAction,
  PerceivedState = unknown,
> extends ActorProposerBoundary<Action, PerceivedState> {}

export interface RecordedContributionMetadata {
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly schemaVersion?: string;
  readonly attemptCount: number;
  readonly sampling?: Readonly<Record<string, unknown>>;
  readonly rawOutput?: string;
}

export interface TechnicalFailureFixture {
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly schemaVersion?: string;
  readonly attemptCount: number;
  readonly errorCode: string;
  readonly attemptErrors: readonly string[];
}

export class ActorProposerValidationError extends Error {
  readonly issues: readonly ActorProposerValidationIssue[];

  constructor(message: string, issues: readonly ActorProposerValidationIssue[]) {
    super(message);
    this.name = "ActorProposerValidationError";
    this.issues = issues;
  }
}

function withoutContextHash<PerceivedState>(
  context: ActorDecisionContext<PerceivedState>,
): Omit<ActorDecisionContext<PerceivedState>, "contextHash"> {
  const { contextHash: _ignored, ...material } = context;
  return material;
}

/** Hash exactly what the ActorProposer is allowed to perceive. */
export function computeActorDecisionContextHash<PerceivedState>(
  context: ActorDecisionContext<PerceivedState>,
): Hash {
  return hash(withoutContextHash(context));
}

/**
 * Seal a perspective-limited context. Callers must construct perceivedState
 * from delivered claims before using this helper; no world state is accepted.
 */
export function sealActorDecisionContext<PerceivedState>(
  context: Omit<ActorDecisionContext<PerceivedState>, "contextHash">,
): ActorDecisionContext<PerceivedState> {
  return deepFreeze({ ...context, contextHash: hash(context) });
}

function requestMaterial<PerceivedState>(
  context: ActorDecisionContext<PerceivedState>,
  resultSchemaVersion: string,
): Omit<ActorProposerRequest<PerceivedState>, "requestHash"> {
  return {
    contractVersion: ACTOR_PROPOSER_CONTRACT_VERSION,
    resultSchemaVersion,
    context,
    contextHash: context.contextHash,
  };
}

export function buildActorProposerRequest<PerceivedState>(
  context: ActorDecisionContext<PerceivedState>,
  resultSchemaVersion = CANDIDATE_ACTION_SET_SCHEMA_VERSION,
): ActorProposerRequest<PerceivedState> {
  const issues = validateActorDecisionContext(context);
  if (issues.length > 0) {
    throw new ActorProposerValidationError(
      "Actor decision context failed validation",
      issues,
    );
  }
  if (resultSchemaVersion.length === 0) {
    throw new TypeError("resultSchemaVersion must not be empty");
  }

  const material = requestMaterial(context, resultSchemaVersion);
  return deepFreeze({ ...material, requestHash: hash(material) });
}

function repeatedStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

const CLAIM_REFERENCE_KEYS = new Set([
  "claimid",
  "claimids",
  "knownclaimids",
  "receivedclaimids",
  "accessibleclaimids",
]);

function collectStringLeaves(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, into);
  }
}

/**
 * Find explicit claim-id fields without trying to infer facts from prose. This
 * catches the Proof 00 action contract and common perceived-state envelopes.
 */
function collectExplicitClaimRefs(
  value: unknown,
  path = "$",
): readonly { readonly id: string; readonly path: string }[] {
  const refs: { id: string; path: string }[] = [];
  if (value === null || typeof value !== "object") return refs;

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      refs.push(...collectExplicitClaimRefs(item, `${path}[${index}]`));
    });
    return refs;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const normalized = key.toLowerCase().replaceAll(/[^a-z]/g, "");
    if (CLAIM_REFERENCE_KEYS.has(normalized)) {
      const ids: string[] = [];
      collectStringLeaves(child, ids);
      refs.push(...ids.map((id) => ({ id, path: childPath })));
    } else {
      refs.push(...collectExplicitClaimRefs(child, childPath));
    }
  }
  return refs;
}

function proof00ActionShapeIssues(
  action: ActionWithKind & Readonly<Record<string, unknown>>,
  path: string,
): ActorProposerValidationIssue[] {
  const issues: ActorProposerValidationIssue[] = [];
  const requireId = (key: string): void => {
    if (typeof action[key] !== "string" || action[key].length === 0) {
      issues.push({
        code: "invalid-action-field",
        path: `${path}.${key}`,
        message: `${key} must be a non-empty entity id`,
      });
    }
  };
  let allowedKeys: readonly string[];
  switch (action.kind) {
    case "recommend-grain-reserve":
      allowedKeys = ["kind", "organizationId", "stockId", "quantity"];
      requireId("organizationId");
      requireId("stockId");
      if (!Number.isSafeInteger(action.quantity) || Number(action.quantity) <= 0) {
        issues.push({
          code: "invalid-action-field",
          path: `${path}.quantity`,
          message: "quantity must be a positive safe integer",
        });
      }
      break;
    case "request-verification":
      allowedKeys = ["kind", "organizationId", "claimId"];
      requireId("organizationId");
      requireId("claimId");
      break;
    case "take-no-emergency-action":
      allowedKeys = ["kind", "organizationId"];
      requireId("organizationId");
      break;
    default:
      return [{
        code: "unknown-action-schema",
        path: `${path}.kind`,
        message: `No Proof 00 payload schema exists for ${action.kind}`,
      }];
  }
  const unexpected = Object.keys(action).filter((key) => !allowedKeys.includes(key)).sort();
  for (const key of unexpected) {
    issues.push({
      code: "unexpected-action-field",
      path: `${path}.${key}`,
      message: `Field ${key} is not part of the ${action.kind} schema`,
    });
  }
  return issues;
}

export function validateActorDecisionContext<PerceivedState>(
  context: ActorDecisionContext<PerceivedState>,
): readonly ActorProposerValidationIssue[] {
  const issues: ActorProposerValidationIssue[] = [];
  const expectedContextHash = computeActorDecisionContextHash(context);
  if (context.contextHash !== expectedContextHash) {
    issues.push({
      code: "context-hash-mismatch",
      path: "$.contextHash",
      message: `Expected ${expectedContextHash}, received ${context.contextHash}`,
    });
  }
  if (context.actorId.length === 0) {
    issues.push({
      code: "missing-actor-id",
      path: "$.actorId",
      message: "actorId must not be empty",
    });
  }
  if (context.triggerId.length === 0) {
    issues.push({
      code: "missing-trigger-id",
      path: "$.triggerId",
      message: "triggerId must not be empty",
    });
  }
  if (context.allowedActionKinds.length === 0) {
    issues.push({
      code: "no-allowed-action-kinds",
      path: "$.allowedActionKinds",
      message: "At least one action kind must be allowed",
    });
  }

  for (const [values, path, code] of [
    [context.allowedActionKinds, "$.allowedActionKinds", "duplicate-action-kind"],
    [context.evidenceRefs, "$.evidenceRefs", "duplicate-evidence-ref"],
    [
      context.epistemicState.accessibleClaimIds,
      "$.epistemicState.accessibleClaimIds",
      "duplicate-accessible-claim",
    ],
  ] as const) {
    for (const repeated of repeatedStrings(values)) {
      issues.push({
        code,
        path,
        message: `Duplicate value ${repeated}`,
      });
    }
  }

  const accessibleClaims = new Set(context.epistemicState.accessibleClaimIds);
  for (const evidenceRef of context.evidenceRefs) {
    if (!accessibleClaims.has(evidenceRef)) {
      issues.push({
        code: "inaccessible-context-evidence",
        path: "$.evidenceRefs",
        message: `Evidence ${evidenceRef} is not accessible to actor ${context.actorId}`,
      });
    }
  }
  for (const ref of collectExplicitClaimRefs(context.perceivedState)) {
    if (!accessibleClaims.has(ref.id)) {
      issues.push({
        code: "inaccessible-claim-in-perceived-state",
        path: ref.path,
        message: `Claim ${ref.id} is not accessible to actor ${context.actorId}`,
      });
    }
  }

  return issues;
}

export function validateCandidateActionSet<Action extends ActionWithKind>(
  context: ActorDecisionContext,
  result: CandidateActionSet<Action>,
  expectedSchemaVersion = CANDIDATE_ACTION_SET_SCHEMA_VERSION,
): readonly ActorProposerValidationIssue[] {
  const issues: ActorProposerValidationIssue[] = [];
  if (result.schemaVersion !== expectedSchemaVersion) {
    issues.push({
      code: "result-schema-mismatch",
      path: "$.schemaVersion",
      message: `Expected ${expectedSchemaVersion}, received ${result.schemaVersion}`,
    });
  }
  if (result.triggerId !== context.triggerId) {
    issues.push({
      code: "trigger-mismatch",
      path: "$.triggerId",
      message: "Candidate set trigger does not match its decision context",
    });
  }
  if (result.actorId !== context.actorId) {
    issues.push({
      code: "actor-mismatch",
      path: "$.actorId",
      message: "Candidate set actor does not match its decision context",
    });
  }
  if (result.candidates.length === 0) {
    issues.push({
      code: "empty-candidate-set",
      path: "$.candidates",
      message: "At least one candidate is required",
    });
  }

  const candidateIds = result.candidates.map((candidate) => candidate.id);
  for (const repeated of repeatedStrings(candidateIds)) {
    issues.push({
      code: "duplicate-candidate-id",
      path: "$.candidates",
      message: `Duplicate candidate id ${repeated}`,
    });
  }
  if (!candidateIds.includes(result.preferredCandidateId)) {
    issues.push({
      code: "preferred-candidate-missing",
      path: "$.preferredCandidateId",
      message: "Preferred candidate must name a candidate in this set",
    });
  }

  const allowedKinds = new Set(context.allowedActionKinds);
  const allowedEvidence = new Set(context.evidenceRefs);
  const accessibleClaims = new Set(context.epistemicState.accessibleClaimIds);

  result.candidates.forEach((candidate, index) => {
    const candidatePath = `$.candidates[${index}]`;
    if (
      candidate.action === null ||
      typeof candidate.action !== "object" ||
      typeof candidate.action.kind !== "string"
    ) {
      issues.push({
        code: "invalid-action-shape",
        path: `${candidatePath}.action`,
        message: "Candidate action must contain a string kind",
      });
      return;
    }
    issues.push(...proof00ActionShapeIssues(
      candidate.action as ActionWithKind & Readonly<Record<string, unknown>>,
      `${candidatePath}.action`,
    ));
    if (!allowedKinds.has(candidate.action.kind)) {
      issues.push({
        code: "action-kind-not-allowed",
        path: `${candidatePath}.action.kind`,
        message: `Action kind ${candidate.action.kind} is not allowed by the trigger`,
      });
    }
    for (const evidenceRef of candidate.informationBasis) {
      if (!allowedEvidence.has(evidenceRef)) {
        issues.push({
          code: "inaccessible-evidence",
          path: `${candidatePath}.informationBasis`,
          message: `Evidence ${evidenceRef} is absent from the Actor Decision Context`,
        });
      }
    }
    for (const claimRef of collectExplicitClaimRefs(candidate.action)) {
      if (!accessibleClaims.has(claimRef.id)) {
        issues.push({
          code: "inaccessible-claim-in-action",
          path: `${candidatePath}.action${claimRef.path.slice(1)}`,
          message: `Claim ${claimRef.id} is not accessible to actor ${context.actorId}`,
        });
      }
    }
  });

  return issues;
}

function promptEnvelope<PerceivedState>(
  request: ActorProposerRequest<PerceivedState>,
): Readonly<Record<string, unknown>> {
  return {
    policy: "Use only the supplied Actor Decision Context. Return candidates; do not mutate world state.",
    contractVersion: request.contractVersion,
    resultSchemaVersion: request.resultSchemaVersion,
    context: request.context,
  };
}

function contributionHashMaterial<
  Action extends ActionWithKind,
  PerceivedState,
>(
  contribution: Omit<
    RecordedActorProposerContribution<Action, PerceivedState>,
    "contributionHash"
  >,
): unknown {
  return contribution;
}

export function recordActorProposerContribution<
  Action extends ActionWithKind,
  PerceivedState = unknown,
>(
  context: ActorDecisionContext<PerceivedState>,
  result: CandidateActionSet<Action>,
  metadata: RecordedContributionMetadata,
): RecordedActorProposerContribution<Action, PerceivedState> {
  if (!Number.isSafeInteger(metadata.attemptCount) || metadata.attemptCount <= 0) {
    throw new RangeError("attemptCount must be a positive safe integer");
  }
  for (const [name, value] of [
    ["provider", metadata.provider],
    ["model", metadata.model],
    ["modelVersion", metadata.modelVersion],
  ] as const) {
    if (value.length === 0) throw new TypeError(`${name} must not be empty`);
  }

  const schemaVersion =
    metadata.schemaVersion ?? CANDIDATE_ACTION_SET_SCHEMA_VERSION;
  const request = buildActorProposerRequest(context, schemaVersion);
  const issues = validateCandidateActionSet(context, result, schemaVersion);
  if (issues.length > 0) {
    throw new ActorProposerValidationError(
      "Recorded Candidate Action Set failed validation",
      issues,
    );
  }

  const sampling = metadata.sampling ?? { temperature: 0 };
  const rawOutput = metadata.rawOutput ?? stableStringify(result);
  let parsedRawOutput: unknown;
  try {
    parsedRawOutput = JSON.parse(rawOutput);
  } catch {
    throw new ActorProposerValidationError(
      "Recorded raw output is not valid JSON",
      [{ code: "raw-output-json", path: "$.rawOutput", message: "Raw output must be valid JSON" }],
    );
  }
  if (hash(parsedRawOutput) !== hash(result)) {
    throw new ActorProposerValidationError(
      "Recorded raw output does not match the parsed Candidate Action Set",
      [{
        code: "raw-output-result-mismatch",
        path: "$.rawOutput",
        message: "Parsed raw output must equal the validated Candidate Action Set",
      }],
    );
  }
  const validation: ActorProposerValidationRecord = {
    accepted: true,
    validatorVersion: "proof00.actor-proposer-validator.v1",
    issueCount: 0,
  };
  const base = {
    requestHash: request.requestHash,
    context,
    result,
    provider: metadata.provider,
    model: metadata.model,
    modelVersion: metadata.modelVersion,
    schemaVersion,
    attemptCount: metadata.attemptCount,
    contractVersion: ACTOR_PROPOSER_CONTRACT_VERSION,
    contextHash: request.contextHash,
    promptHash: hash(promptEnvelope(request)),
    sampling,
    samplingHash: hash(sampling),
    rawOutput,
    rawOutputHash: hash(rawOutput),
    parsedResultHash: hash(result),
    validation,
    validationHash: hash(validation),
    disposition: "accepted" as const,
  };
  return deepFreeze({
    ...base,
    contributionHash: hash(contributionHashMaterial(base)),
  });
}

function validateRecordedContribution<
  Action extends ActionWithKind,
  PerceivedState,
>(
  context: ActorDecisionContext<PerceivedState>,
  contribution: RecordedActorProposerContribution<Action, PerceivedState>,
): readonly ActorProposerValidationIssue[] {
  const issues = [
    ...validateActorDecisionContext(context),
    ...validateCandidateActionSet(
      context,
      contribution.result,
      contribution.schemaVersion,
    ),
  ];

  let request: ActorProposerRequest<PerceivedState> | undefined;
  try {
    request = buildActorProposerRequest(context, contribution.schemaVersion);
  } catch (error) {
    if (error instanceof ActorProposerValidationError) {
      issues.push(...error.issues);
    } else {
      throw error;
    }
  }
  if (contribution.contextHash !== context.contextHash) {
    issues.push({
      code: "recorded-context-fingerprint-mismatch",
      path: "$.contextHash",
      message: "Recorded context hash does not match the replay context",
    });
  }
  if (hash(contribution.context) !== hash(context)) {
    issues.push({
      code: "recorded-context-mismatch",
      path: "$.context",
      message: "Recorded context is not byte-semantically equal to replay context",
    });
  }
  if (request && contribution.requestHash !== request.requestHash) {
    issues.push({
      code: "recorded-request-fingerprint-mismatch",
      path: "$.requestHash",
      message: "Recorded request hash does not match the replay request",
    });
  }
  if (request && contribution.promptHash !== hash(promptEnvelope(request))) {
    issues.push({
      code: "recorded-prompt-fingerprint-mismatch",
      path: "$.promptHash",
      message: "Recorded prompt hash does not match the reconstructed prompt",
    });
  }
  for (const [actual, expected, path, code] of [
    [contribution.samplingHash, hash(contribution.sampling), "$.samplingHash", "sampling-hash-mismatch"],
    [contribution.rawOutputHash, hash(contribution.rawOutput), "$.rawOutputHash", "raw-output-hash-mismatch"],
    [contribution.parsedResultHash, hash(contribution.result), "$.parsedResultHash", "parsed-result-hash-mismatch"],
    [contribution.validationHash, hash(contribution.validation), "$.validationHash", "validation-hash-mismatch"],
  ] as const) {
    if (actual !== expected) issues.push({ code, path, message: `Expected ${expected}, received ${actual}` });
  }
  try {
    if (hash(JSON.parse(contribution.rawOutput)) !== hash(contribution.result)) {
      issues.push({
        code: "raw-output-result-mismatch",
        path: "$.rawOutput",
        message: "Recorded raw output no longer matches the parsed Candidate Action Set",
      });
    }
  } catch {
    issues.push({
      code: "raw-output-json",
      path: "$.rawOutput",
      message: "Recorded raw output is not valid JSON",
    });
  }
  const { contributionHash: _ignored, ...hashMaterial } = contribution;
  const expectedContributionHash = hash(contributionHashMaterial(hashMaterial));
  if (contribution.contributionHash !== expectedContributionHash) {
    issues.push({
      code: "contribution-hash-mismatch",
      path: "$.contributionHash",
      message: `Expected ${expectedContributionHash}, received ${contribution.contributionHash}`,
    });
  }
  return issues;
}

function failureFromIssues<PerceivedState>(
  context: ActorDecisionContext<PerceivedState>,
  contribution: Pick<
    RecordedActorProposerContribution<ActionWithKind, PerceivedState>,
    "provider" | "model" | "modelVersion" | "schemaVersion" | "attemptCount" | "requestHash"
  >,
  issues: readonly ActorProposerValidationIssue[],
  errorCode: string,
): ActorProposerTechnicalFailure {
  return deepFreeze({
    ok: false,
    status: "technical-failure",
    disposition: "incomplete",
    triggerId: context.triggerId,
    actorId: context.actorId,
    contextHash: context.contextHash,
    requestHash: contribution.requestHash,
    provider: contribution.provider,
    model: contribution.model,
    modelVersion: contribution.modelVersion,
    schemaVersion: contribution.schemaVersion,
    attemptCount: contribution.attemptCount,
    errorCode,
    attemptErrors: issues.map(
      (issue) => `${issue.code} at ${issue.path}: ${issue.message}`,
    ),
    fallbackUsed: false,
    externalModelCallCount: 0,
  });
}

/**
 * Pure execution replay. It checks the complete context/request fingerprints
 * and recorded hashes, and has no adapter argument with which to call a model.
 */
export function replayActorProposerContribution<
  Action extends ActionWithKind,
  PerceivedState = unknown,
>(
  context: ActorDecisionContext<PerceivedState>,
  contribution: RecordedActorProposerContribution<Action, PerceivedState>,
): ActorProposerResult<Action, PerceivedState> {
  const issues = validateRecordedContribution(context, contribution);
  if (issues.length > 0) {
    return failureFromIssues(
      context,
      contribution,
      issues,
      "replay-fingerprint-mismatch",
    );
  }
  return deepFreeze({
    ok: true,
    status: "success",
    mode: "replay",
    contribution,
    externalModelCallCount: 0,
  });
}

/** A model-free boundary backed only by immutable recorded contributions. */
export class CassetteActorProposer<
  Action extends ActionWithKind = Proof00ActorAction,
  PerceivedState = unknown,
> implements ActorProposer<Action, PerceivedState> {
  readonly #byRequestHash: ReadonlyMap<
    Hash,
    RecordedActorProposerContribution<Action, PerceivedState>
  >;

  constructor(
    contributions: readonly RecordedActorProposerContribution<
      Action,
      PerceivedState
    >[],
  ) {
    const byRequestHash = new Map<
      Hash,
      RecordedActorProposerContribution<Action, PerceivedState>
    >();
    for (const contribution of contributions) {
      const existing = byRequestHash.get(contribution.requestHash);
      if (
        existing &&
        existing.contributionHash !== contribution.contributionHash
      ) {
        throw new Error(
          `Divergent cassettes share request hash ${contribution.requestHash}`,
        );
      }
      byRequestHash.set(contribution.requestHash, contribution);
    }
    this.#byRequestHash = byRequestHash;
  }

  propose(
    context: ActorDecisionContext<PerceivedState>,
  ): ActorProposerResult<Action, PerceivedState> {
    let request: ActorProposerRequest<PerceivedState>;
    try {
      request = buildActorProposerRequest(context);
    } catch (error) {
      const issues =
        error instanceof ActorProposerValidationError
          ? error.issues
          : [{ code: "invalid-context", path: "$", message: String(error) }];
      return failureFromIssues(
        context,
        {
          requestHash: hash({ invalidContext: context }),
          provider: "cassette",
          model: "none",
          modelVersion: "none",
          schemaVersion: CANDIDATE_ACTION_SET_SCHEMA_VERSION,
          attemptCount: 0,
        },
        issues,
        "invalid-actor-decision-context",
      );
    }

    const contribution = this.#byRequestHash.get(request.requestHash);
    if (!contribution) {
      return deepFreeze({
        ok: false,
        status: "technical-failure",
        disposition: "incomplete",
        triggerId: context.triggerId,
        actorId: context.actorId,
        contextHash: context.contextHash,
        requestHash: request.requestHash,
        provider: "cassette",
        model: "none",
        modelVersion: "none",
        schemaVersion: request.resultSchemaVersion,
        attemptCount: 0,
        errorCode: "cassette-miss",
        attemptErrors: ["No recorded contribution matches this request fingerprint"],
        fallbackUsed: false,
        externalModelCallCount: 0,
      });
    }

    const replayed = replayActorProposerContribution(context, contribution);
    if (replayed.status === "technical-failure") return replayed;
    return deepFreeze({ ...replayed, mode: "cassette" });
  }
}

/**
 * Deterministic fixture for bounded technical failure. The caller must stop
 * the Run at this trigger as Incomplete; this object exposes no fallback path.
 */
export class TechnicalFailureActorProposer<
  Action extends ActionWithKind = Proof00ActorAction,
  PerceivedState = unknown,
> implements ActorProposer<Action, PerceivedState> {
  readonly #fixture: TechnicalFailureFixture;

  constructor(fixture: TechnicalFailureFixture) {
    if (!Number.isSafeInteger(fixture.attemptCount) || fixture.attemptCount <= 0) {
      throw new RangeError("attemptCount must be a positive safe integer");
    }
    if (fixture.attemptErrors.length !== fixture.attemptCount) {
      throw new RangeError("attemptErrors must contain one entry per attempt");
    }
    this.#fixture = deepFreeze({ ...fixture });
  }

  propose(
    context: ActorDecisionContext<PerceivedState>,
  ): ActorProposerTechnicalFailure {
    let requestHash: Hash;
    try {
      requestHash = buildActorProposerRequest(
        context,
        this.#fixture.schemaVersion ?? CANDIDATE_ACTION_SET_SCHEMA_VERSION,
      ).requestHash;
    } catch {
      requestHash = hash({ invalidContext: context });
    }
    return deepFreeze({
      ok: false,
      status: "technical-failure",
      disposition: "incomplete",
      triggerId: context.triggerId,
      actorId: context.actorId,
      contextHash: context.contextHash,
      requestHash,
      provider: this.#fixture.provider,
      model: this.#fixture.model,
      modelVersion: this.#fixture.modelVersion,
      schemaVersion:
        this.#fixture.schemaVersion ?? CANDIDATE_ACTION_SET_SCHEMA_VERSION,
      attemptCount: this.#fixture.attemptCount,
      errorCode: this.#fixture.errorCode,
      attemptErrors: this.#fixture.attemptErrors,
      fallbackUsed: false,
      externalModelCallCount: 0,
    });
  }
}

/** Preferred integration names; legacy descriptive names remain exported. */
export {
  CassetteActorProposer as RecordedActorProposer,
  TechnicalFailureActorProposer as FailingActorProposer,
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
