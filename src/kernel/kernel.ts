import { hash } from "./stable.ts";
import type {
  CommittedTransition,
  LogicalInstant,
  ProposalDisposition,
  RecordedRandomDraw,
  StateChange,
  StatePath,
  TraceNode,
  TransitionProposal,
  ValidatorRef,
  VersionedRead,
} from "./types.ts";

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
}

export interface StateAdapter<State> {
  clone(state: State): State;
  hash(state: State): string;
  read(state: State, path: StatePath): unknown;
  validatePath?(path: StatePath): boolean;
  setKernelMeta(state: State, revision: number, instant: LogicalInstant): void;
  validateInvariants(state: State): readonly ValidationIssue[];
  diffPaths?(before: State, after: State): readonly StatePath[];
}

export interface MechanismRegistration<State, Action = unknown> {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly actionKinds: readonly string[];
  readonly requiredValidators: readonly ValidatorRef[];
  readonly requireCausalPathDimensions?: boolean;
  readonly allowedCausalDimensions?: readonly string[];
  footprint(proposal: TransitionProposal<Action>, state: State): readonly StatePath[];
  apply(
    proposal: TransitionProposal<Action>,
    draft: State,
  ): readonly StateChange[];
}

export interface ProposalValidator<State> {
  readonly id: string;
  readonly version: string;
  validate(proposal: TransitionProposal, state: State): readonly ValidationIssue[];
}

export interface CoordinationResult {
  readonly acceptedProposalIds: readonly string[];
  readonly rejected: Readonly<Record<string, string>>;
  readonly randomDraws: readonly RecordedRandomDraw[];
  readonly summary: string;
}

export interface CoordinationResolver<State> {
  readonly id: string;
  readonly version: string;
  resolve(
    proposals: readonly TransitionProposal[],
    state: State,
  ): CoordinationResult;
}

export interface KernelCheckpoint<State> {
  readonly state: State;
  readonly pathVersions: Readonly<Record<StatePath, number>>;
  readonly pathProducers: Readonly<Record<StatePath, string>>;
  readonly trace: readonly TraceNode[];
  readonly transitions: readonly CommittedTransition[];
  readonly randomDraws: readonly RecordedRandomDraw[];
  readonly lastProcessedInstant?: LogicalInstant;
}

export interface CommitPhaseResult<State> {
  readonly state: State;
  readonly dispositions: readonly ProposalDisposition[];
  readonly transitions: readonly CommittedTransition[];
  readonly traceNodes: readonly TraceNode[];
}

function actionKind(proposal: TransitionProposal): string {
  const action = proposal.action as { readonly kind?: unknown };
  return typeof action?.kind === "string" ? action.kind : "";
}

function sameRef(left: ValidatorRef, right: ValidatorRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function pathsOverlap(left: StatePath, right: StatePath): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

const ABSENT_STATE_PATH_VALUE = Object.freeze({ kernelAbsentStatePath: true });

function intersectPaths(left: readonly StatePath[], right: readonly StatePath[]): boolean {
  return left.some((leftPath) => right.some((rightPath) => pathsOverlap(leftPath, rightPath)));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resourceConflict(
  left: TransitionProposal,
  right: TransitionProposal,
): boolean {
  return left.resourceClaims.some((leftClaim) =>
    right.resourceClaims.some(
      (rightClaim) =>
        leftClaim.resourceType === rightClaim.resourceType &&
        leftClaim.resourceId === rightClaim.resourceId &&
        (leftClaim.mode !== "read" || rightClaim.mode !== "read"),
    ),
  );
}

function proposalsConflict(
  left: TransitionProposal,
  right: TransitionProposal,
): boolean {
  const leftWrites = left.effectScope.paths;
  const rightWrites = right.effectScope.paths;
  const leftReads = left.readSet.map((entry) => entry.path);
  const rightReads = right.readSet.map((entry) => entry.path);

  return (
    intersectPaths(leftWrites, rightWrites) ||
    intersectPaths(leftWrites, rightReads) ||
    intersectPaths(rightWrites, leftReads) ||
    resourceConflict(left, right)
  );
}

function connectedComponents(
  proposals: readonly TransitionProposal[],
): readonly TransitionProposal[][] {
  const remaining = new Set(proposals.map((proposal) => proposal.id));
  const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  const components: TransitionProposal[][] = [];

  for (const start of [...remaining].sort()) {
    if (!remaining.has(start)) continue;
    const queue = [start];
    const component: TransitionProposal[] = [];
    remaining.delete(start);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const current = byId.get(currentId)!;
      component.push(current);

      for (const candidateId of [...remaining].sort()) {
        const candidate = byId.get(candidateId)!;
        if (proposalsConflict(current, candidate)) {
          remaining.delete(candidateId);
          queue.push(candidateId);
        }
      }
    }

    components.push(component.sort((a, b) => compareText(a.id, b.id)));
  }

  return components.sort((a, b) => compareText(a[0]!.id, b[0]!.id));
}

function compareProposals(left: TransitionProposal, right: TransitionProposal): number {
  return compareText(left.id, right.id) || compareText(hash(left), hash(right));
}

function instantEqual(left: LogicalInstant, right: LogicalInstant): boolean {
  return (
    left.worldTime === right.worldTime &&
    left.causalPhase === right.causalPhase
  );
}

function traceNodeId(
  kind: string,
  instant: LogicalInstant,
  stableIdentity: unknown,
): string {
  return `trace:${hash({ kind, instant, stableIdentity }).slice(0, 24)}`;
}

function transitionId(
  instant: LogicalInstant,
  proposals: readonly TransitionProposal[],
  beforeStateHash: string,
  afterStateHash: string,
): string {
  return `transition:${hash({
    instant,
    proposalHashes: proposals.map((proposal) => hash(proposal)).sort(),
    beforeStateHash,
    afterStateHash,
  }).slice(0, 24)}`;
}

export class Kernel<State> {
  readonly #adapter: StateAdapter<State>;
  readonly #mechanisms = new Map<string, MechanismRegistration<State>>();
  readonly #validators = new Map<string, ProposalValidator<State>>();
  readonly #resolvers = new Map<string, CoordinationResolver<State>>();
  #state: State;
  #pathVersions: Record<StatePath, number>;
  #pathProducers: Record<StatePath, string>;
  #trace: TraceNode[];
  #transitions: CommittedTransition[];
  #randomDraws: RecordedRandomDraw[];
  #lastProcessedInstant?: LogicalInstant;

  constructor(
    initialState: State,
    adapter: StateAdapter<State>,
    initialPathVersions: Readonly<Record<StatePath, number>> = {},
    initialPathProducers: Readonly<Record<StatePath, string>> = {},
    checkpoint?: Omit<KernelCheckpoint<State>, "state" | "pathVersions" | "pathProducers">,
  ) {
    this.#adapter = adapter;
    this.#state = adapter.clone(initialState);
    this.#pathVersions = { ...initialPathVersions };
    this.#pathProducers = { ...initialPathProducers };
    this.#trace = checkpoint ? [...checkpoint.trace] : [];
    this.#transitions = checkpoint ? [...checkpoint.transitions] : [];
    this.#randomDraws = checkpoint ? [...checkpoint.randomDraws] : [];
    this.#lastProcessedInstant = checkpoint?.lastProcessedInstant
      ? { ...checkpoint.lastProcessedInstant }
      : undefined;
  }

  registerMechanism(registration: MechanismRegistration<State>): this {
    const key = `${registration.id}@${registration.version}`;
    if (this.#mechanisms.has(key)) {
      throw new Error(`Mechanism already registered: ${key}`);
    }
    this.#mechanisms.set(key, registration);
    return this;
  }

  registerValidator(validator: ProposalValidator<State>): this {
    const key = `${validator.id}@${validator.version}`;
    if (this.#validators.has(key)) {
      throw new Error(`Validator already registered: ${key}`);
    }
    this.#validators.set(key, validator);
    return this;
  }

  registerResolver(resolver: CoordinationResolver<State>): this {
    const key = `${resolver.id}@${resolver.version}`;
    if (this.#resolvers.has(key)) {
      throw new Error(`Resolver already registered: ${key}`);
    }
    this.#resolvers.set(key, resolver);
    return this;
  }

  state(): State {
    return this.#adapter.clone(this.#state);
  }

  stateHash(): string {
    return this.#adapter.hash(this.#state);
  }

  pathVersion(path: StatePath): number {
    let revision = 0;
    for (const [writtenPath, writtenRevision] of Object.entries(this.#pathVersions)) {
      if (pathsOverlap(path, writtenPath)) revision = Math.max(revision, writtenRevision);
    }
    return revision;
  }

  read(path: StatePath): VersionedRead {
    const producerPath = Object.keys(this.#pathProducers)
      .filter((writtenPath) => pathsOverlap(path, writtenPath))
      .sort((left, right) => (this.#pathVersions[right] ?? 0) - (this.#pathVersions[left] ?? 0) || compareText(left, right))[0];
    const producerTraceId = producerPath ? this.#pathProducers[producerPath] : undefined;
    const value = this.#adapter.read(this.#state, path);
    return {
      path,
      revision: this.pathVersion(path),
      valueHash: hash(value === undefined ? ABSENT_STATE_PATH_VALUE : value),
      ...(producerTraceId ? { producerTraceId } : {}),
    };
  }

  trace(): readonly TraceNode[] {
    return structuredClone(this.#trace);
  }

  transitions(): readonly CommittedTransition[] {
    return structuredClone(this.#transitions);
  }

  randomDraws(): readonly RecordedRandomDraw[] {
    return structuredClone(this.#randomDraws);
  }

  checkpoint(): KernelCheckpoint<State> {
    return {
      state: this.state(),
      pathVersions: { ...this.#pathVersions },
      pathProducers: { ...this.#pathProducers },
      trace: this.trace(),
      transitions: this.transitions(),
      randomDraws: this.randomDraws(),
      ...(this.#lastProcessedInstant
        ? { lastProcessedInstant: { ...this.#lastProcessedInstant } }
        : {}),
    };
  }

  static fromCheckpoint<State>(
    checkpoint: KernelCheckpoint<State>,
    adapter: StateAdapter<State>,
  ): Kernel<State> {
    return new Kernel(
      checkpoint.state,
      adapter,
      checkpoint.pathVersions,
      checkpoint.pathProducers,
      {
        trace: checkpoint.trace,
        transitions: checkpoint.transitions,
        randomDraws: checkpoint.randomDraws,
        ...(checkpoint.lastProcessedInstant
          ? { lastProcessedInstant: checkpoint.lastProcessedInstant }
          : {}),
      },
    );
  }

  commitPhase(
    instant: LogicalInstant,
    inputProposals: readonly TransitionProposal[],
  ): CommitPhaseResult<State> {
    if (
      !Number.isSafeInteger(instant.worldTime) ||
      instant.worldTime < 0 ||
      !Number.isSafeInteger(instant.causalPhase) ||
      instant.causalPhase < 0
    ) {
      throw new RangeError("Causal phase instant must contain non-negative safe integers");
    }
    if (
      this.#lastProcessedInstant &&
      (instant.worldTime < this.#lastProcessedInstant.worldTime ||
        (instant.worldTime === this.#lastProcessedInstant.worldTime &&
          instant.causalPhase <= this.#lastProcessedInstant.causalPhase))
    ) {
      throw new Error(
        `Causal phase must increase strictly after ${this.#lastProcessedInstant.worldTime}:${this.#lastProcessedInstant.causalPhase}`,
      );
    }
    this.#lastProcessedInstant = { ...instant };
    const proposals = [...inputProposals].sort(compareProposals);
    const proposalIdCounts = new Map<string, number>();
    for (const proposal of proposals) {
      proposalIdCounts.set(proposal.id, (proposalIdCounts.get(proposal.id) ?? 0) + 1);
    }
    const phaseStartTraceIds = new Set(this.#trace.map((node) => node.id));
    const dispositions: ProposalDisposition[] = [];
    const newTransitions: CommittedTransition[] = [];
    const newTraceNodes: TraceNode[] = [];
    const valid: TransitionProposal[] = [];

    for (const proposal of proposals) {
      const issues = [
        ...(proposalIdCounts.get(proposal.id)! > 1
          ? [{ code: "duplicate-proposal-id", message: `Duplicate proposal id: ${proposal.id}` }]
          : []),
        ...this.#safeValidateProposal(proposal, instant, phaseStartTraceIds),
      ];
      if (issues.length > 0) {
        const stale = issues.length > 0 && issues.every((issue) => issue.code === "stale-read");
        const disposition: ProposalDisposition = {
          proposalId: proposal.id,
          kind: stale ? "stale" : "rejected",
          reasonCode: issues.map((issue) => issue.code).sort().join(","),
          evidence: proposal.causalParents,
        };
        dispositions.push(disposition);
        const node = this.#proposalTrace(proposal, disposition, { issues });
        if (!this.#trace.some((existing) => existing.id === node.id)) {
          this.#trace.push(node);
          newTraceNodes.push(node);
        }
      } else {
        valid.push(proposal);
      }
    }

    for (const component of connectedComponents(valid)) {
      let result: CoordinationResult;
      try {
        result = this.#coordinate(component);
      } catch (error) {
        result = {
          acceptedProposalIds: [],
          rejected: Object.fromEntries(component.map((proposal) => [
            proposal.id,
            `resolution-failed:${error instanceof Error ? error.message : String(error)}`,
          ])),
          randomDraws: [],
          summary: "resolution-extension-failed",
        };
      }
      this.#randomDraws.push(...result.randomDraws);
      const accepted = component.filter((proposal) =>
        result.acceptedProposalIds.includes(proposal.id),
      );
      const componentDispositions: ProposalDisposition[] = component.map((proposal) => {
        const accepted = result.acceptedProposalIds.includes(proposal.id);
        return {
          proposalId: proposal.id,
          kind: accepted ? "accepted" : "rejected",
          ...(accepted ? {} : { reasonCode: result.rejected[proposal.id] ?? "not-selected" }),
          evidence: proposal.causalParents,
        };
      });

      const invalidAtCommit = accepted
        .map((proposal) => ({
          proposal,
          issues: this.#safeValidateProposal(proposal, instant, phaseStartTraceIds),
        }))
        .filter((entry) => entry.issues.length > 0);
      if (invalidAtCommit.length > 0) {
        const invalidById = new Map(
          invalidAtCommit.map((entry) => [entry.proposal.id, entry.issues]),
        );
        for (const disposition of componentDispositions) {
          if (result.acceptedProposalIds.includes(disposition.proposalId)) {
            const invalidIssues = invalidById.get(disposition.proposalId) ?? [
              {
                code: "coordination-set-invalidated",
                message: "Another accepted member became invalid before atomic commit",
              },
            ];
            const index = componentDispositions.indexOf(disposition);
            componentDispositions[index] = {
              ...disposition,
              kind: invalidIssues.length > 0 && invalidIssues.every((issue) => issue.code === "stale-read")
                ? "stale"
                : "rejected",
              reasonCode: invalidIssues.map((issue) => issue.code).sort().join(","),
            };
          }
        }
      }

      const finalAccepted = invalidAtCommit.length > 0 ? [] : accepted;

      let transition: CommittedTransition | undefined;
      if (finalAccepted.length > 0) {
        const beforeStateHash = this.stateHash();
        const draft = this.#adapter.clone(this.#state);
        const changes: StateChange[] = [];
        let applyIssue: ValidationIssue | undefined;

        try {
          for (const proposal of finalAccepted.sort(compareProposals)) {
            const registration = this.#mechanismFor(proposal)!;
            changes.push(...registration.apply(proposal, draft));
          }
        } catch (error) {
          applyIssue = {
            code: "apply-failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }

        const allowedPaths = new Set(finalAccepted.flatMap((proposal) => proposal.effectScope.paths));
        const reportedEffectIssues = changes
          .filter((change) => !allowedPaths.has(change.path))
          .map((change) => ({
            code: "unreported-effect-scope",
            message: `Applied change exceeds Effect Scope: ${change.path}`,
          }));
        const actualEffectIssues = this.#adapter.diffPaths
          ? this.#adapter.diffPaths(this.#state, draft)
              .filter((path) => !allowedPaths.has(path))
              .map((path) => ({
                code: "hidden-effect-scope",
                message: `Actual state change exceeds Effect Scope: ${path}`,
              }))
          : [];
        const dimensionIssues = changes.flatMap((change) => {
          const expected = [...new Set(finalAccepted.flatMap((proposal) =>
            proposal.causalPathDimensions?.writes
              .filter((binding) => binding.path === change.path)
              .flatMap((binding) => binding.dimensions) ?? [],
          ))].sort();
          const actual = [...new Set(change.causalDimensions ?? [])].sort();
          const required = finalAccepted.some((proposal) =>
            this.#mechanismFor(proposal)?.requireCausalPathDimensions && proposal.effectScope.paths.includes(change.path),
          );
          return required && hash(expected) !== hash(actual)
            ? [{ code: "change-causal-dimension-mismatch", message: `Applied change ${change.path} does not retain its proposal dimensions` }]
            : [];
        });
        const invariantIssues = applyIssue
          ? [applyIssue]
          : [
              ...reportedEffectIssues,
              ...actualEffectIssues,
              ...dimensionIssues,
              ...this.#adapter.validateInvariants(this.#adapter.clone(draft)),
            ];

        if (invariantIssues.length === 0) {
          const nextRevision = this.#transitions.length + 1;
          this.#adapter.setKernelMeta(draft, nextRevision, instant);
          const afterStateHash = this.#adapter.hash(draft);
          const ids = finalAccepted.map((proposal) => proposal.id).sort();
          const acceptedSet = new Set(ids);
          const finalDispositions = componentDispositions.map((disposition) =>
            acceptedSet.has(disposition.proposalId)
              ? { ...disposition, kind: "accepted" as const }
              : disposition,
          );
          transition = {
            id: transitionId(instant, finalAccepted, beforeStateHash, afterStateHash),
            instant,
            proposalIds: ids,
            causalParents: [...new Set(finalAccepted.flatMap((p) => p.causalParents))].sort(),
            resolvedAction: finalAccepted.map((proposal) => proposal.action),
            changes,
            causalPathDimensions: {
              reads: finalAccepted.flatMap((proposal) => proposal.causalPathDimensions?.reads ?? []),
              writes: finalAccepted.flatMap((proposal) => proposal.causalPathDimensions?.writes ?? []),
            },
            dispositions: finalDispositions,
            beforeStateHash,
            afterStateHash,
          };
          this.#state = draft;
          this.#bumpPaths(finalAccepted);
          this.#transitions.push(transition);
          newTransitions.push(transition);
        } else {
          for (let index = 0; index < componentDispositions.length; index += 1) {
            const current = componentDispositions[index]!;
            if (finalAccepted.some((proposal) => proposal.id === current.proposalId)) {
              componentDispositions[index] = {
                ...current,
                kind: "rejected",
                reasonCode: invariantIssues.map((issue) => issue.code).join(","),
              };
            }
          }
        }
      }

      for (const proposal of component) {
        const disposition = componentDispositions.find(
          (candidate) => candidate.proposalId === proposal.id,
        )!;
        dispositions.push(disposition);
        const node = this.#proposalTrace(proposal, disposition, {
          coordination: result.summary,
          ...(transition ? { transitionId: transition.id } : {}),
        });
        this.#trace.push(node);
        newTraceNodes.push(node);
      }

      if (transition) {
        const payload = { transition };
        const node: TraceNode = {
          id: traceNodeId("committed-transition", instant, transition.id),
          kind: "committed-transition",
          instant,
          causalParents: component
            .map((proposal) =>
              newTraceNodes.find(
                (node) =>
                  node.kind === "proposal-disposition" &&
                  (node.payload as { proposalId?: string }).proposalId === proposal.id,
              )?.id,
            )
            .filter((id): id is string => Boolean(id))
            .sort(),
          subjects: [...new Set(component.flatMap((proposal) => proposal.subjects))].sort(),
          permittedAudience: "audit",
          payload,
          payloadHash: hash(payload),
        };
        this.#trace.push(node);
        newTraceNodes.push(node);
        this.#recordPathProducers(finalAccepted, node.id);
      }
    }

    return {
      state: this.state(),
      dispositions,
      transitions: newTransitions,
      traceNodes: newTraceNodes,
    };
  }

  #validateProposal(
    proposal: TransitionProposal,
    instant: LogicalInstant,
    phaseStartTraceIds: ReadonlySet<string>,
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!proposal.id) issues.push({ code: "missing-id", message: "Proposal id is required" });
    if (
      !Number.isSafeInteger(proposal.instant.worldTime) ||
      proposal.instant.worldTime < 0 ||
      !Number.isSafeInteger(proposal.instant.causalPhase) ||
      proposal.instant.causalPhase < 0
    ) {
      issues.push({ code: "invalid-instant", message: "Logical instant must contain non-negative safe integers" });
    }
    if (!instantEqual(proposal.instant, instant)) {
      issues.push({ code: "wrong-instant", message: "Proposal instant does not match phase" });
    }
    if (proposal.causalParents.some((id) => !phaseStartTraceIds.has(id))) {
      issues.push({
        code: "same-phase-or-missing-parent",
        message: "Causal parents must exist before the current phase",
      });
    }
    if (!proposal.authority.principalId || !proposal.authority.capability) {
      issues.push({ code: "invalid-authority", message: "Authority principal and capability are required" });
    }
    if (new Set(proposal.subjects).size !== proposal.subjects.length) {
      issues.push({ code: "duplicate-subject", message: "Proposal subjects must be unique" });
    }
    if (new Set(proposal.readSet.map((read) => read.path)).size !== proposal.readSet.length) {
      issues.push({ code: "duplicate-read", message: "Causal Read Set paths must be unique" });
    }
    if (proposal.readSet.some((read) => !Number.isSafeInteger(read.revision) || read.revision < 0 || !read.valueHash)) {
      issues.push({ code: "invalid-read", message: "Causal reads require a non-negative revision and value hash" });
    }
    if (proposal.readSet.some(
      (read) => read.producerTraceId && !proposal.causalParents.includes(read.producerTraceId),
    )) {
      issues.push({
        code: "missing-read-provenance-parent",
        message: "Every recorded path producer must be a causal parent",
      });
    }
    if (new Set(proposal.effectScope.paths).size !== proposal.effectScope.paths.length) {
      issues.push({ code: "duplicate-effect-path", message: "Effect Scope paths must be unique" });
    }
    if (proposal.subjects.some((subject) => !proposal.effectScope.entityIds.includes(subject))) {
      issues.push({ code: "effect-scope-entity", message: "Every subject must be inside Effect Scope" });
    }
    const readPaths = new Set(proposal.readSet.map((read) => read.path));
    const allDeclaredPaths = [
      ...proposal.readSet.map((read) => read.path),
      ...proposal.effectScope.paths,
      ...proposal.preconditions.flatMap((precondition) => precondition.paths),
    ];
    if (this.#adapter.validatePath && allDeclaredPaths.some((path) => !this.#adapter.validatePath!(path))) {
      issues.push({ code: "invalid-state-path", message: "Proposal contains a non-canonical or unsupported State Path" });
    }
    if (proposal.preconditions.some((precondition) => precondition.paths.some((path) => !readPaths.has(path)))) {
      issues.push({ code: "unbound-precondition", message: "Precondition paths must be in Causal Read Set" });
    }
    if (proposal.permissionClaims.some(
      (claim) =>
        claim.capability !== proposal.authority.capability ||
        claim.subjectId !== proposal.authority.principalId,
    )) {
      issues.push({ code: "permission-claim", message: "Permission claims must bind the declared authority" });
    }
    if (proposal.permissionClaims.length === 0) {
      issues.push({ code: "missing-permission-claim", message: "Permission claim is required" });
    }
    if (proposal.resourceClaims.some(
      (claim) => !Number.isFinite(claim.quantity) || claim.quantity <= 0 || !claim.unit,
    )) {
      issues.push({ code: "resource-claim", message: "Resource claims require positive finite quantities and units" });
    }

    const registration = this.#mechanismFor(proposal);
    if (!registration) {
      issues.push({ code: "unknown-mechanism", message: "Mechanism/version is not registered" });
      return issues;
    }
    if (!registration.actionKinds.includes(actionKind(proposal))) {
      issues.push({ code: "unsupported-action", message: "Mechanism cannot apply this action" });
    }
    if (!registration.capabilities.includes(proposal.authority.capability)) {
      issues.push({ code: "unauthorized-capability", message: "Authority capability is not declared" });
    }

    const dimensions = proposal.causalPathDimensions;
    if (registration.requireCausalPathDimensions && !dimensions) {
      issues.push({ code: "missing-causal-path-dimension", message: "Mechanism requires concrete read/write dimension bindings" });
    }
    if (dimensions) {
      const bindings = [
        ...dimensions.reads.map((binding) => ({ ...binding, role: "read" as const })),
        ...dimensions.writes.map((binding) => ({ ...binding, role: "write" as const })),
      ];
      const bindingKeys = bindings.map((binding) => `${binding.role}:${binding.path}`);
      if (new Set(bindingKeys).size !== bindingKeys.length) issues.push({ code: "duplicate-causal-path-dimension", message: "Causal path dimension bindings must be unique per role and path" });
      const boundReadPaths = new Set(dimensions.reads.map((binding) => binding.path));
      const boundWritePaths = new Set(dimensions.writes.map((binding) => binding.path));
      if (proposal.readSet.some((read) => !boundReadPaths.has(read.path)) || dimensions.reads.some((binding) => !readPaths.has(binding.path))) issues.push({ code: "missing-causal-path-dimension", message: "Every and only causal read path must have a dimension binding" });
      if (proposal.effectScope.paths.some((path) => !boundWritePaths.has(path)) || dimensions.writes.some((binding) => !proposal.effectScope.paths.includes(binding.path))) issues.push({ code: "missing-causal-path-dimension", message: "Every and only effect path must have a dimension binding" });
      const allowed = registration.allowedCausalDimensions ? new Set(registration.allowedCausalDimensions) : undefined;
      for (const binding of bindings) {
        if (binding.dimensions.length === 0 || new Set(binding.dimensions).size !== binding.dimensions.length) issues.push({ code: "invalid-causal-dimension", message: `State Path ${binding.path} requires unique non-empty causal dimensions` });
        if (allowed && binding.dimensions.some((dimension) => !allowed.has(dimension))) issues.push({ code: "unknown-causal-dimension", message: `State Path ${binding.path} uses a dimension outside the Mechanism registry` });
      }
    }

    const footprint = registration.footprint(proposal, this.#adapter.clone(this.#state));
    if (footprint.some((path) => !proposal.effectScope.paths.includes(path))) {
      issues.push({ code: "effect-scope", message: "Action footprint exceeds Effect Scope" });
    }

    issues.push(...this.#readSetIssues(proposal));
    for (const required of registration.requiredValidators) {
      if (!proposal.validators.some((candidate) => sameRef(candidate, required))) {
        issues.push({ code: "missing-validator", message: `Missing ${required.id}@${required.version}` });
      }
    }
    for (const validatorRef of proposal.validators) {
      const validator = this.#validators.get(`${validatorRef.id}@${validatorRef.version}`);
      if (!validator) {
        issues.push({ code: "unknown-validator", message: `Unknown ${validatorRef.id}@${validatorRef.version}` });
      } else {
        issues.push(...validator.validate(proposal, this.#adapter.clone(this.#state)));
      }
    }
    return issues;
  }

  #safeValidateProposal(
    proposal: TransitionProposal,
    instant: LogicalInstant,
    phaseStartTraceIds: ReadonlySet<string>,
  ): ValidationIssue[] {
    try {
      return this.#validateProposal(proposal, instant, phaseStartTraceIds);
    } catch (error) {
      return [{
        code: "validation-extension-failed",
        message: error instanceof Error ? error.message : String(error),
      }];
    }
  }

  #readSetIssues(proposal: TransitionProposal): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const read of proposal.readSet) {
      const current = this.read(read.path);
      if (
        current.revision !== read.revision ||
        current.valueHash !== read.valueHash ||
        current.producerTraceId !== read.producerTraceId
      ) {
        issues.push({ code: "stale-read", message: `Stale read: ${read.path}` });
      }
    }
    return issues;
  }

  #mechanismFor(proposal: TransitionProposal): MechanismRegistration<State> | undefined {
    return this.#mechanisms.get(`${proposal.source}@${proposal.version}`);
  }

  #coordinate(component: readonly TransitionProposal[]): CoordinationResult {
    if (component.length === 1) {
      return {
        acceptedProposalIds: [component[0]!.id],
        rejected: {},
        randomDraws: [],
        summary: "independent-proposal",
      };
    }

    const refs = component.map((proposal) => proposal.resolution);
    const first = refs[0];
    if (
      !first ||
      refs.some((ref) => !ref || !sameRef(ref, first))
    ) {
      return {
        acceptedProposalIds: [],
        rejected: Object.fromEntries(component.map((proposal) => [proposal.id, "missing-explicit-resolver"])),
        randomDraws: [],
        summary: "unresolved-causal-coordination-set",
      };
    }

    const resolver = this.#resolvers.get(`${first.id}@${first.version}`);
    if (!resolver) {
      return {
        acceptedProposalIds: [],
        rejected: Object.fromEntries(component.map((proposal) => [proposal.id, "unknown-resolver"])),
        randomDraws: [],
        summary: "unknown-resolution-mechanism",
      };
    }
    return resolver.resolve(component, this.#adapter.clone(this.#state));
  }

  #bumpPaths(proposals: readonly TransitionProposal[]): void {
    const paths = new Set(proposals.flatMap((proposal) => proposal.effectScope.paths));
    const revision = this.#transitions.length + 1;
    for (const path of paths) {
      this.#pathVersions[path] = revision;
    }
  }

  #recordPathProducers(
    proposals: readonly TransitionProposal[],
    producerTraceId: string,
  ): void {
    const paths = new Set(proposals.flatMap((proposal) => proposal.effectScope.paths));
    for (const path of paths) this.#pathProducers[path] = producerTraceId;
  }

  #proposalTrace(
    proposal: TransitionProposal,
    disposition: ProposalDisposition,
    details: unknown,
  ): TraceNode {
    const recordedTraceIds = new Set(this.#trace.map((node) => node.id));
    const payload = {
      proposalId: proposal.id,
      mechanism: `${proposal.source}@${proposal.version}`,
      actionKind: actionKind(proposal),
      disposition,
      details,
      proposal,
    };
    return {
      id: traceNodeId("proposal-disposition", proposal.instant, {
        proposalId: proposal.id,
        proposalHash: hash(proposal),
        disposition,
      }),
      kind: "proposal-disposition",
      instant: proposal.instant,
      causalParents: proposal.causalParents
        .filter((parentId) => recordedTraceIds.has(parentId))
        .sort(),
      subjects: [...proposal.subjects].sort(),
      permittedAudience: "audit",
      payload,
      payloadHash: hash(payload),
    };
  }
}
