import type {
  CommittedTransition,
  LogicalInstant,
  TraceNode,
} from "../kernel/types.ts";

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type WorldId = string;

export interface WorldScoped {
  readonly worldId: WorldId;
}

export type FieldValueType = "string" | "number" | "boolean" | "reference" | "json";

export interface SchemaField {
  readonly id: string;
  readonly valueType: FieldValueType;
  readonly required: boolean;
  readonly causal: boolean;
  readonly unit?: string;
}

export interface NodeTypeDefinition {
  readonly id: string;
  readonly description: string;
  readonly fields: readonly SchemaField[];
  readonly worldSpecific?: boolean;
}

export interface EdgeTypeDefinition {
  readonly id: string;
  readonly description: string;
  readonly fromTypes: readonly string[];
  readonly toTypes: readonly string[];
  readonly fields: readonly SchemaField[];
  readonly worldSpecific?: boolean;
}

export interface TemporalModelSpec {
  readonly id: string;
  readonly version: string;
  readonly kind: "linear" | "cyclic" | "branching" | "custom";
  readonly coordinateDescription: string;
  readonly runtimeProfile?: "linear-discrete-v1";
}

export interface IdentityModelSpec {
  readonly id: string;
  readonly version: string;
  readonly principles: readonly string[];
}

export interface CausalityModelSpec {
  readonly id: string;
  readonly version: string;
  readonly principles: readonly string[];
}

export interface WorldRuleDefinition {
  readonly id: string;
  readonly description: string;
  readonly invariant: boolean;
  readonly provenance: readonly string[];
  readonly enforcement?: readonly ExecutableRuleConstraint[];
}

export type ExecutableRuleConstraint =
  | {
      readonly kind: "numeric-range";
      readonly nodeTypes: readonly string[];
      readonly fieldId: string;
      readonly minimum?: number;
      readonly maximum?: number;
      readonly maximumFieldId?: string;
    }
  | {
      readonly kind: "field-write-authority";
      readonly nodeTypes: readonly string[];
      readonly fieldId: string;
      readonly mechanismIds: readonly string[];
    }
  | {
      readonly kind: "action-requires-edge";
      readonly mechanismId: string;
      readonly targetNodeTypes: readonly string[];
      readonly edgeType: string;
      readonly direction: "from-target" | "to-target" | "either";
    };

export interface TheoryPackSelection {
  readonly id: string;
  readonly version: string;
  readonly mode: "enabled" | "parameterized" | "disabled";
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

export interface TheoryPackDefinition {
  readonly id: string;
  readonly version: string;
  readonly domain:
    | "psychology"
    | "social-psychology"
    | "organization"
    | "institution"
    | "economy"
    | "politics"
    | "ecology"
    | "history"
    | "custom";
  readonly title: string;
  readonly summary: string;
  readonly constructs: readonly string[];
  readonly requiredAssumptions: readonly string[];
  readonly prohibitedAssumptions: readonly string[];
  readonly promptGuidance: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly evidenceMaturity:
    | "author-defined"
    | "exploratory"
    | "evidence-supported"
    | "scenario-calibrated";
}

export interface MechanismSelection {
  readonly id: string;
  readonly version: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

export interface MechanismGrant {
  readonly id: string;
  readonly version: string;
  readonly actionKinds: readonly GraphWorldAction["kind"][];
}

export interface MechanismDefinition {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly requiredNodeTypes: readonly string[];
  readonly requiredAssumptions: readonly string[];
  readonly prohibitedAssumptions?: readonly string[];
  readonly theoryPackRefs?: readonly string[];
  readonly actionKinds: readonly GraphWorldAction["kind"][];
  readonly evidenceMaturity:
    | "author-defined"
    | "exploratory"
    | "evidence-supported"
    | "scenario-calibrated";
}

export interface WorldNode {
  readonly id: string;
  readonly type: string;
  readonly attributes: Readonly<Record<string, JsonValue>>;
}

export interface WorldEdge {
  readonly id: string;
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly attributes: Readonly<Record<string, JsonValue>>;
}

export type FactAuthority = "creator-confirmed" | "inferred" | "world-transition";

export interface WorldFact {
  readonly id: string;
  readonly subjectId: string;
  readonly predicate: string;
  readonly value: JsonValue;
  readonly validFrom?: Readonly<Record<string, JsonValue>>;
  readonly validTo?: Readonly<Record<string, JsonValue>>;
  readonly authority: FactAuthority;
  readonly provenance: readonly string[];
  readonly epistemicScope: "world" | readonly string[];
  readonly uncertainty?: string;
}

export interface InitialWorldGraph {
  readonly nodes: readonly WorldNode[];
  readonly edges: readonly WorldEdge[];
  readonly facts: readonly WorldFact[];
}

export interface WorldSourceRecord extends WorldScoped {
  readonly id: string;
  readonly revision: string;
  readonly kind: "markdown" | "wiki" | "structured-data" | "image-note" | "creator-note";
  readonly title: string;
  readonly content: string;
  readonly contentHash: string;
  readonly provenance: readonly string[];
}

export interface WorldBlueprint extends WorldScoped {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly summary: string;
  readonly sourceRefs: readonly string[];
  readonly temporalModel: TemporalModelSpec;
  readonly identityModel: IdentityModelSpec;
  readonly causalityModel: CausalityModelSpec;
  readonly assumptions: readonly string[];
  readonly theoryPacks: readonly TheoryPackSelection[];
  readonly nodeTypes: readonly NodeTypeDefinition[];
  readonly edgeTypes: readonly EdgeTypeDefinition[];
  readonly rules: readonly WorldRuleDefinition[];
  readonly mechanisms: readonly MechanismSelection[];
  readonly initialGraph: InitialWorldGraph;
  readonly presentationHints?: Readonly<Record<string, JsonValue>>;
}

export interface WorldBlueprintPatch {
  readonly addAssumptions?: readonly string[];
  readonly addTheoryPacks?: readonly TheoryPackSelection[];
  readonly addNodeTypes?: readonly NodeTypeDefinition[];
  readonly addEdgeTypes?: readonly EdgeTypeDefinition[];
  readonly addRules?: readonly WorldRuleDefinition[];
  readonly addMechanisms?: readonly MechanismSelection[];
  readonly addNodes?: readonly WorldNode[];
  readonly addEdges?: readonly WorldEdge[];
  readonly addFacts?: readonly WorldFact[];
  readonly presentationHints?: Readonly<Record<string, JsonValue>>;
}

export interface WorldContextPackage extends WorldScoped {
  readonly id: string;
  readonly blueprintId: string;
  readonly blueprintVersion: string;
  readonly blueprintHash: string;
  readonly contractHash?: string;
  readonly instanceId?: string;
  readonly runId?: string;
  readonly sourceRefs: readonly string[];
  readonly theoryPackRefs: readonly string[];
  readonly payload: JsonValue;
  readonly payloadHash: string;
}

export interface ModelInvocationRecord extends WorldScoped {
  readonly id: string;
  readonly contextPackageId: string;
  readonly contextPackageHash: string;
  readonly provider: "external" | "deterministic";
  readonly model: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly promptHash?: string;
  readonly theoryContextHash?: string;
  readonly sessionId: string;
  readonly status: "complete" | "technical-failure" | "invalid-output";
  readonly rawOutputHash?: string;
  readonly parsedOutputHash?: string;
  readonly error?: string;
}

export interface SemanticContribution extends WorldScoped {
  readonly id: string;
  readonly contextPackageId: string;
  readonly contextPackageHash: string;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly sourceRefs: readonly string[];
  readonly impact: "low" | "high";
  readonly causal: boolean;
  readonly classification: "inference" | "alternative" | "contradiction";
  readonly rationale: string;
  readonly assumptions: readonly string[];
  readonly patch: WorldBlueprintPatch;
  readonly rawOutputHash: string;
}

export interface CreatorQuery extends WorldScoped {
  readonly id: string;
  readonly contextPackageId: string;
  readonly gap: string;
  readonly blockedMechanisms: readonly string[];
  readonly divergentAnswers: readonly string[];
  readonly smallestSufficientQuestion: string;
  readonly earliestCausalImpact?: Readonly<Record<string, JsonValue>>;
  readonly sourceRefs: readonly string[];
  readonly status: "open" | "resolved" | "superseded";
}

export interface CompilationFinding {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly refs: readonly string[];
}

export interface WorldContract extends WorldScoped {
  readonly id: string;
  readonly version: string;
  readonly hash: string;
  readonly authority: "working-candidate" | "accepted";
  readonly blueprintId: string;
  readonly blueprintVersion: string;
  readonly blueprintHash: string;
  readonly compilerVersion: string;
  readonly temporalModel: TemporalModelSpec;
  readonly identityModel: IdentityModelSpec;
  readonly causalityModel: CausalityModelSpec;
  readonly assumptions: readonly string[];
  readonly theoryPacks: readonly TheoryPackSelection[];
  readonly nodeTypes: readonly NodeTypeDefinition[];
  readonly edgeTypes: readonly EdgeTypeDefinition[];
  readonly rules: readonly WorldRuleDefinition[];
  readonly mechanisms: readonly MechanismSelection[];
  readonly mechanismGrants: readonly MechanismGrant[];
  readonly includedContributionIds: readonly string[];
  readonly inferenceProvenance: readonly SemanticContribution[];
}

export interface WorldSnapshot extends WorldScoped {
  readonly contractHash: string;
  readonly revision: number;
  readonly instant: LogicalInstant;
  readonly nodes: Readonly<Record<string, WorldNode>>;
  readonly edges: Readonly<Record<string, WorldEdge>>;
  readonly facts: Readonly<Record<string, WorldFact>>;
}

export interface WorldInstance extends WorldScoped {
  readonly id: string;
  readonly lineageId: string;
  readonly contractId: string;
  readonly contractVersion: string;
  readonly contractHash: string;
  readonly contractAuthority: WorldContract["authority"];
  readonly initialStateHash: string;
  readonly initialSnapshot: WorldSnapshot;
}

export interface CompiledWorldPackage extends WorldScoped {
  readonly blueprint: WorldBlueprint;
  readonly contract: WorldContract;
  readonly instance: WorldInstance;
  readonly findings: readonly CompilationFinding[];
}

export interface CompilationCandidate extends WorldScoped {
  readonly id: string;
  readonly sourceContributionIds: readonly string[];
  readonly blueprint: WorldBlueprint;
  readonly findings: readonly CompilationFinding[];
  readonly package?: CompiledWorldPackage;
}

export interface WorldCompilationResult extends WorldScoped {
  readonly base: CompilationCandidate;
  readonly alternatives: readonly CompilationCandidate[];
  readonly deferredContributionIds: readonly string[];
}

export type GraphWorldAction =
  | {
      readonly kind: "adjust-node-number";
      readonly nodeId: string;
      readonly fieldId: string;
      readonly delta: number;
      readonly unit?: string;
    }
  | {
      readonly kind: "set-node-attribute";
      readonly nodeId: string;
      readonly fieldId: string;
      readonly value: JsonValue;
    }
  | {
      readonly kind: "adjust-edge-number";
      readonly edgeId: string;
      readonly fieldId: string;
      readonly delta: number;
      readonly unit?: string;
    }
  | {
      readonly kind: "set-edge-attribute";
      readonly edgeId: string;
      readonly fieldId: string;
      readonly value: JsonValue;
    }
  | {
      readonly kind: "assert-fact";
      readonly fact: WorldFact;
    }
  | {
      readonly kind: "create-node";
      readonly node: WorldNode;
    }
  | {
      readonly kind: "create-edge";
      readonly edge: WorldEdge;
    };

export type SimulationScale = "macro" | "meso" | "micro";

export interface SimulationFrame extends WorldScoped {
  readonly id: string;
  readonly scale: SimulationScale;
  readonly resolution: "century" | "decade" | "year" | "month" | "day" | "scene" | "custom";
  readonly startWorldTime: number;
  readonly endWorldTime: number;
  readonly subjectIds: readonly string[];
  readonly parentFrameId?: string;
  readonly purpose: string;
}

export interface SimulationSchedule extends WorldScoped {
  readonly id: string;
  readonly contractHash: string;
  readonly frames: readonly SimulationFrame[];
  readonly scheduleHash: string;
}

export type CausalDimension =
  | "environment"
  | "space"
  | "resource"
  | "economy"
  | "population"
  | "organization"
  | "institution"
  | "information"
  | "psychology"
  | "relationship"
  | "conflict"
  | "hazard"
  | "world-specific"
  | "cross-scale";

export const CAUSAL_DIMENSIONS: readonly CausalDimension[] = [
  "environment", "space", "resource", "economy", "population", "organization", "institution",
  "information", "psychology", "relationship", "conflict", "hazard", "world-specific", "cross-scale",
];

export interface WorldCausalPathDimensionBinding {
  readonly path: string;
  readonly dimensions: readonly CausalDimension[];
}

/**
 * One causally selected boundary. A boundary is not a pre-authored event: it
 * only declares when and at what resolution all applicable Mechanisms must be
 * offered the current World State.
 */
export interface EvolutionBoundary extends WorldScoped {
  readonly id: string;
  readonly worldTime: number;
  readonly scale: SimulationScale;
  readonly frameId: string;
  readonly durationYears: number;
  readonly calendarYear?: number;
  readonly activeDimensions?: readonly CausalDimension[];
  readonly reason: string;
}

export interface WorldEvolutionPlan extends WorldScoped {
  readonly id: string;
  readonly contractHash: string;
  readonly scheduleHash: string;
  readonly boundaries: readonly EvolutionBoundary[];
  readonly maximumCausalPassesPerBoundary: number;
  readonly planHash: string;
}

export interface MechanismEmissionRecord extends WorldScoped {
  readonly id: string;
  readonly boundaryId: string;
  readonly pass: number;
  readonly stage: number;
  readonly mechanismId: string;
  readonly mechanismVersion: string;
  readonly dimensions: readonly CausalDimension[];
  readonly readDimensions: readonly CausalDimension[];
  readonly writeDimensions: readonly CausalDimension[];
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly readPathDimensions: readonly WorldCausalPathDimensionBinding[];
  readonly writePathDimensions: readonly WorldCausalPathDimensionBinding[];
  readonly causalPredecessorEmissionIds: readonly string[];
  readonly causalPredecessorInputIds: readonly string[];
  readonly readStateHash: string;
  readonly committedStateHash: string;
  readonly proposalIds: readonly string[];
  readonly substantiveProposalIds: readonly string[];
  readonly markerProposalIds: readonly string[];
  readonly triggerSummary: string;
  readonly modelInvocationId?: string;
  readonly modelProposalSetId?: string;
}

export interface CausalInteractionRecord {
  readonly from: CausalDimension;
  readonly to: CausalDimension;
  readonly mechanismIds: readonly string[];
  readonly boundaryIds: readonly string[];
  readonly occurrences: number;
}

export interface CausalLoopEvidence {
  readonly id: string;
  readonly dimensionPath: readonly CausalDimension[];
  readonly minimumScales: number;
  readonly scales: readonly SimulationScale[];
  readonly mechanismIds: readonly string[];
  readonly boundaryIds: readonly string[];
  readonly missingLinks: readonly string[];
  readonly closed: boolean;
}

/** Machine-verifiable proof that execution formed interacting feedback loops, not a vertical event chain. */
export interface CausalClosureAudit extends WorldScoped {
  readonly status: "closed" | "incomplete";
  readonly requiredDimensions: readonly CausalDimension[];
  readonly activatedDimensions: readonly CausalDimension[];
  readonly missingDimensions: readonly CausalDimension[];
  readonly scalesActivated: readonly SimulationScale[];
  readonly missingScales: readonly SimulationScale[];
  readonly interactions: readonly CausalInteractionRecord[];
  readonly loops: readonly CausalLoopEvidence[];
  readonly causalDependencyCount: number;
  readonly causallyLinkedEmissionCount: number;
  readonly crossBoundaryFeedbackCount: number;
  readonly auditHash: string;
}

export interface CausalBoundaryRecord extends WorldScoped {
  readonly boundary: EvolutionBoundary;
  readonly startStateHash: string;
  readonly endStateHash: string;
  readonly passes: number;
  readonly quiescent: boolean;
  readonly emissionIds: readonly string[];
  readonly proposalIds: readonly string[];
  readonly dimensionsActivated: readonly CausalDimension[];
}

export interface GuidanceSpecification extends WorldScoped {
  readonly id: string;
  readonly mode: "simulation-focus" | "selection-criterion" | "guided-search" | "author-intervention";
  readonly targetSubjectIds: readonly string[];
  readonly startWorldTime: number;
  readonly endWorldTime: number;
  readonly desiredPattern?: string;
  readonly permittedLevers: readonly string[];
  readonly protectedFacts: readonly string[];
  readonly forbiddenEffects: readonly string[];
  readonly provenance: readonly string[];
}

/** Input contract for an optional, server-side transition proposal adapter. */
export interface BuildDecisionContextOptions {
  readonly subjectId: string;
  readonly purpose: "actor-deliberation" | "organization-deliberation" | "world-mechanism";
  readonly trigger: string;
  readonly worldTime: number;
  readonly causalPhase?: number;
  readonly frameId?: string;
  readonly allowedMechanismIds: readonly string[];
}

export interface WorldDecisionContext extends WorldScoped {
  readonly id: string;
  readonly subjectId: string;
  readonly purpose: "actor-deliberation" | "organization-deliberation" | "world-mechanism";
  readonly trigger: string;
  readonly instant: LogicalInstant;
  readonly frameId?: string;
  readonly contractHash: string;
  readonly accessibleNodes: readonly WorldNode[];
  readonly accessibleEdges: readonly WorldEdge[];
  readonly accessibleFacts: readonly WorldFact[];
  readonly allowedMechanisms: readonly MechanismGrant[];
  readonly theoryGuidance: readonly string[];
  readonly contextHash: string;
}

export interface ProposedTransitionCandidate extends WorldScoped {
  readonly id: string;
  readonly contextId: string;
  readonly input: GraphTransitionInput;
  readonly subjectiveReason: string;
  readonly expectedConsequence: string;
  readonly perceivedRisk: string;
  readonly informationBasis: readonly string[];
}

export interface TransitionProposalSet extends WorldScoped {
  readonly id: string;
  readonly context: WorldDecisionContext;
  readonly contextPackage: WorldContextPackage;
  readonly invocation: ModelInvocationRecord;
  readonly attemptedInvocations?: readonly ModelInvocationRecord[];
  readonly candidates: readonly ProposedTransitionCandidate[];
  readonly preferredCandidateId: string;
  readonly modelProvenance?: {
    readonly promptHash: string;
    readonly theoryContextHash: string;
    readonly proposalHash: string;
    readonly fallbackUsed: boolean;
    readonly fallbackPolicyId?: string;
    readonly fallbackReason?: string;
  };
}

export interface GraphTransitionInput extends WorldScoped {
  readonly id: string;
  readonly mechanismId: string;
  readonly worldTime: number;
  readonly causalPhase?: number;
  readonly action: GraphWorldAction;
  readonly causalReadPaths?: readonly string[];
  readonly readDimensions?: readonly CausalDimension[];
  readonly writeDimensions?: readonly CausalDimension[];
  readonly causalParents?: readonly string[];
  readonly frameId?: string;
  readonly origin?: "mechanism-generated" | "creator-input" | "author-intervention";
  readonly provenance?: readonly string[];
}

export interface WorldRunManifest extends WorldScoped {
  readonly runId: string;
  readonly possibleHistoryId: string;
  readonly lineageId: string;
  readonly instanceId: string;
  readonly contractId: string;
  readonly contractVersion: string;
  readonly contractHash: string;
  readonly initialStateHash: string;
  readonly mechanismVersions: Readonly<Record<string, string>>;
  readonly seed: string;
  readonly inputHash: string;
  readonly scheduleHash?: string;
  readonly guidanceIds: readonly string[];
  readonly branchId?: string;
  readonly parentRunId?: string;
  readonly anchorInputCount?: number;
}

export interface WorldRunRecord extends WorldScoped {
  readonly manifest: WorldRunManifest;
  readonly status: "complete" | "incomplete" | "invalid";
  readonly inputs: readonly GraphTransitionInput[];
  readonly initialSnapshot: WorldSnapshot;
  readonly finalSnapshot: WorldSnapshot;
  readonly transitions: readonly CommittedTransition<GraphWorldAction[]>[];
  readonly trace: readonly TraceNode[];
  readonly finalStateHash: string;
  readonly traceHash: string;
}

/** A World Run whose Transition Inputs were generated from state, not supplied as outcomes. */
export interface AutonomousWorldRun extends WorldScoped {
  readonly plan: WorldEvolutionPlan;
  /** Full schedule is retained for product restart/branch operations; old schema-v3 artifacts may omit it. */
  readonly schedule?: SimulationSchedule;
  /** Recorded creator guidance constrains search and focus but never commits state directly. */
  readonly guidance?: readonly GuidanceSpecification[];
  readonly run: WorldRunRecord;
  readonly generatedInputs: readonly GraphTransitionInput[];
  readonly externalInputs: readonly GraphTransitionInput[];
  readonly generatedInputHash: string;
  readonly emissions: readonly MechanismEmissionRecord[];
  readonly boundaries: readonly CausalBoundaryRecord[];
  readonly dimensionsClosed: readonly CausalDimension[];
  readonly closureAudit: CausalClosureAudit;
  readonly quiescent: boolean;
}

export interface AutonomousBranchResult extends WorldScoped {
  readonly branch: WorldBranch;
  readonly parentRunId: string;
  readonly anchorBoundaryId: string;
  readonly interventionInputIds: readonly string[];
  readonly autonomous: AutonomousWorldRun;
}

export interface WorldBranch extends WorldScoped {
  readonly id: string;
  readonly lineageId: string;
  readonly parentRunId: string;
  readonly anchorInputCount: number;
  readonly anchorStateHash: string;
  readonly inputDeltaHash: string;
  readonly reason: string;
  readonly runId: string;
}

export interface GraphProjection extends WorldScoped {
  readonly kind: "knowledge-graph";
  readonly sourceRunId: string;
  readonly sourceStateHash: string;
  readonly nodes: readonly WorldNode[];
  readonly edges: readonly WorldEdge[];
  readonly facts: readonly WorldFact[];
}

export interface TimelineProjection extends WorldScoped {
  readonly kind: "timeline";
  readonly sourceRunId: string;
  readonly sourceStateHash: string;
  readonly entries: readonly {
    readonly transitionId: string;
    readonly instant: LogicalInstant;
    readonly subjects: readonly string[];
    readonly summary: string;
    readonly causalParents: readonly string[];
  }[];
}

export interface SettingBookProjection extends WorldScoped {
  readonly kind: "setting-book";
  readonly sourceRunId: string;
  readonly sourceStateHash: string;
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly {
    readonly heading: string;
    readonly paragraphs: readonly string[];
    readonly sourceRefs: readonly string[];
  }[];
}

export interface AuditProjection extends WorldScoped {
  readonly kind: "audit";
  readonly sourceRunId: string;
  readonly sourceStateHash: string;
  readonly contractHash: string;
  readonly inputHash: string;
  readonly traceHash: string;
  readonly transitionCount: number;
  readonly contributionIds: readonly string[];
  readonly replayStatus: "unverified" | "verified" | "mismatch";
}

export type WorldProjection = GraphProjection | TimelineProjection | SettingBookProjection | AuditProjection;

export interface ProjectionReviewProposal extends WorldScoped {
  readonly id: string;
  readonly projectionId: string;
  readonly sourceRunId: string;
  readonly sourceStateHash: string;
  readonly requestedChange: string;
  readonly impact: "low" | "high";
  readonly patch: WorldBlueprintPatch;
  readonly provenance: readonly string[];
  readonly status: "proposed" | "accepted-for-compilation" | "rejected";
}

export interface ContractChangeSet extends WorldScoped {
  readonly id: string;
  readonly fromContractHash: string;
  readonly kind: "content" | "law" | "ontology";
  readonly patch: WorldBlueprintPatch;
  readonly rationale: string;
  readonly earliestCausalImpactInput?: number;
  readonly status: "proposed" | "accepted" | "rejected";
}
