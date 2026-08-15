import type {
  EdgeTypeDefinition,
  ExecutableRuleConstraint,
  JsonValue,
  NodeTypeDefinition,
  TheoryPackSelection,
  WorldEdge,
  WorldFact,
  WorldNode,
  AutonomousWorldRun,
  SimulationSchedule,
  WorldEvolutionPlan,
  GraphWorldAction,
  GuidanceSpecification,
} from "../world-model/types.ts";
import type {
  AutonomousHistoryComparison,
  CausalImpactTrace,
  CausalStateExplanation,
  WorldStateTarget,
} from "../world-model/causal-query.ts";

export interface CreatorWorldMetadata {
  readonly title: string;
  readonly summary: string;
  readonly language?: string;
  readonly tags?: readonly string[];
}

export interface CreatorTemporalProfile {
  readonly calendarName: string;
  readonly startYear: number;
  readonly coordinateDescription: string;
}

export interface CreatorPlaceDefinition {
  readonly id: string;
  readonly name: string;
  readonly terrain?: string;
  readonly climate?: string;
  readonly environmentalStress: number;
  readonly carryingCapacity: number;
  readonly accessibility: number;
  readonly coordinates?: { readonly x: number; readonly y: number };
  readonly image?: { readonly path: string; readonly caption: string };
}

export interface CreatorRouteDefinition {
  readonly id: string;
  readonly name: string;
  readonly originPlaceId: string;
  readonly destinationPlaceId: string;
  readonly capacity: number;
  readonly reliability: number;
  readonly travelTimeDays: number;
  readonly maintenance: number;
  readonly status: string;
}

export interface CreatorSettlementDefinition {
  readonly id: string;
  readonly name: string;
  readonly placeId: string;
  readonly population: number;
  readonly foundedYear: number;
  readonly role: string;
  readonly infrastructureState?: string;
  readonly foodSecurity?: number;
  readonly migrationPressure?: number;
}

export interface CreatorPopulationDefinition {
  readonly id: string;
  readonly name: string;
  readonly placeId: string;
  readonly population: number;
  readonly livelihood: string;
  readonly mobility: number;
  readonly cohesion: number;
  readonly settlementReadiness: number;
  readonly settlementName?: string;
}

export interface CreatorCharacterDefinition {
  readonly id: string;
  readonly name: string;
  readonly placeId: string;
  readonly age?: number;
  readonly focal?: boolean;
  readonly traits?: JsonValue;
  readonly wants?: readonly string[];
  readonly fears?: readonly string[];
  readonly needs?: readonly string[];
  readonly beliefs?: readonly string[];
  readonly narrative?: string;
  readonly memories?: readonly string[];
  readonly stress?: number;
  readonly agency?: number;
  readonly currentPlan?: string;
}

export interface CreatorOrganizationDefinition {
  readonly id: string;
  readonly name: string;
  readonly placeId: string;
  readonly declaredGoal: string;
  readonly actualPractice: string;
  readonly resources?: JsonValue;
  readonly culture?: JsonValue;
  readonly coalitions?: JsonValue;
  readonly legitimacy?: number;
  readonly cohesion?: number;
  readonly capacity?: number;
  readonly status?: string;
}

export interface CreatorInstitutionDefinition {
  readonly id: string;
  readonly name: string;
  readonly placeId: string;
  readonly formalRule: string;
  readonly ruleInUse: string;
  readonly enforcementCapacity?: number;
}

export interface CreatorResourceDefinition {
  readonly id: string;
  readonly name: string;
  readonly placeId: string;
  readonly quantity: number;
  readonly capacity: number;
  readonly renewalRate: number;
  readonly baselineDemand: number;
  readonly accessRegime: string;
  readonly priceIndex?: number;
}

export type CreatorRelationshipDefinition =
  | { readonly id: string; readonly kind: "membership"; readonly fromId: string; readonly toId: string; readonly role: string }
  | { readonly id: string; readonly kind: "social"; readonly fromId: string; readonly toId: string; readonly relation: string; readonly trust?: number }
  | { readonly id: string; readonly kind: "governance"; readonly fromId: string; readonly toId: string; readonly basis: string }
  | { readonly id: string; readonly kind: "trade"; readonly fromId: string; readonly toId: string; readonly capacity: number; readonly reliability: number; readonly priceSpread: number };

export interface CreatorInformationDefinition {
  readonly id: string;
  readonly subjectId: string;
  readonly predicate: string;
  readonly value: JsonValue;
  readonly scope: "world" | readonly string[];
  readonly uncertainty?: string;
}

export interface CreatorHazardDefinition {
  readonly id: string;
  readonly name: string;
  readonly placeId: string;
  readonly kind: string;
  readonly baselineFrequencyPerCentury: number;
  readonly triggerCondition: string;
  readonly severityBasis: string;
  readonly exposures: readonly { readonly targetId: string; readonly vulnerability: number }[];
}

export interface CreatorHardRuleDefinition {
  readonly id: string;
  readonly description: string;
  readonly constraint: ExecutableRuleConstraint;
}

export interface CreatorWorldParameters {
  readonly environmentalVolatility: number;
  readonly routeSensitivity: number;
  readonly hazardFrequencyMultiplier: number;
  readonly organizationAdaptationRate: number;
  readonly custom?: Readonly<Record<string, JsonValue>>;
}

export interface CreatorWorldDefinition {
  readonly schemaVersion: 1;
  readonly worldId: string;
  readonly draftId: string;
  readonly version: string;
  readonly metadata: CreatorWorldMetadata;
  readonly temporal: CreatorTemporalProfile;
  readonly premises: readonly string[];
  readonly geography: {
    readonly places: readonly CreatorPlaceDefinition[];
    readonly routes: readonly CreatorRouteDefinition[];
  };
  readonly populations: {
    readonly settlements: readonly CreatorSettlementDefinition[];
    readonly groups: readonly CreatorPopulationDefinition[];
  };
  readonly characters: readonly CreatorCharacterDefinition[];
  readonly organizations: readonly CreatorOrganizationDefinition[];
  readonly institutions: readonly CreatorInstitutionDefinition[];
  readonly resources: readonly CreatorResourceDefinition[];
  readonly relationships: readonly CreatorRelationshipDefinition[];
  readonly information: readonly CreatorInformationDefinition[];
  readonly hazards: readonly CreatorHazardDefinition[];
  readonly theoryPacks: readonly TheoryPackSelection[];
  readonly hardRules: readonly CreatorHardRuleDefinition[];
  readonly parameters: CreatorWorldParameters;
  readonly initialState: {
    readonly facts: readonly Omit<CreatorInformationDefinition, "uncertainty">[] | readonly CreatorInformationDefinition[];
  };
  readonly extensions?: {
    readonly nodeTypes?: readonly NodeTypeDefinition[];
    readonly edgeTypes?: readonly EdgeTypeDefinition[];
    readonly nodes?: readonly WorldNode[];
    readonly edges?: readonly WorldEdge[];
    readonly facts?: readonly WorldFact[];
  };
}

export interface CreatorWorldQuestion {
  readonly id: string;
  readonly code: string;
  readonly section: string;
  readonly prompt: string;
  readonly whyConsequential: string;
  readonly blockedCapabilities: readonly string[];
  readonly suggestedAnswers: readonly string[];
}

export interface CreatorWorldIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface CreatorWorldInspection {
  readonly ready: boolean;
  readonly questions: readonly CreatorWorldQuestion[];
  readonly issues: readonly CreatorWorldIssue[];
}

export interface CreatorWorldDraft {
  readonly worldId: string;
  readonly draftId: string;
  readonly revision: number;
  readonly status: "needs-input" | "invalid" | "ready";
  readonly definitionHash: string;
  readonly definition: CreatorWorldDefinition;
  readonly questions: readonly CreatorWorldQuestion[];
  readonly issues: readonly CreatorWorldIssue[];
}

export interface StudioRunControl {
  readonly worldId: string;
  readonly id: string;
  readonly revision: number;
  readonly status: "ready" | "running" | "pause-requested" | "paused" | "complete" | "failed";
  readonly contractHash: string;
  readonly instanceId: string;
  readonly plan: WorldEvolutionPlan;
  readonly schedule: SimulationSchedule;
  readonly seed: string;
  readonly nextBoundaryIndex: number;
  readonly checkpoint?: AutonomousWorldRun;
  readonly checkpointHash?: string;
  readonly finalRunId?: string;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly controlHash: string;
}

export interface StudioBranchTarget extends WorldStateTarget {
  /** Creator-selected coordinate; the service resolves it to the first causal boundary at or after this value. */
  readonly worldTime: number;
}

interface StudioBranchRequestBase {
  readonly worldId: string;
  readonly id: string;
  readonly parentRunId: string;
  readonly target: StudioBranchTarget;
  readonly reason: string;
}

export interface StudioInterventionBranchRequest extends StudioBranchRequestBase {
  readonly mode: "intervention";
  readonly action: GraphWorldAction;
  readonly mechanismId?: string;
}

export interface StudioGuidanceBranchRequest extends StudioBranchRequestBase {
  readonly mode: "soft-guidance";
  readonly prompt: string;
  readonly permittedLevers: readonly string[];
  readonly protectedFacts: readonly string[];
  readonly forbiddenEffects: readonly string[];
}

export type StudioBranchRequest = StudioInterventionBranchRequest | StudioGuidanceBranchRequest;

export interface StudioHistoryEvidence {
  readonly worldId: string;
  readonly id: string;
  readonly request: StudioBranchRequest;
  readonly anchorBoundaryId: string;
  readonly anchorWorldTime: number;
  readonly anchorStateHash: string;
  readonly branchId: string;
  readonly candidateRunId: string;
  readonly interventionInputIds: readonly string[];
  readonly guidance: readonly GuidanceSpecification[];
  readonly targetBefore: CausalStateExplanation;
  readonly targetAfter: CausalStateExplanation;
  readonly comparison: AutonomousHistoryComparison;
  readonly impact: CausalImpactTrace;
  readonly initialConditionRoots: readonly string[];
  readonly modelProvenance: readonly {
    readonly emissionId: string;
    readonly invocationId?: string;
    readonly proposalSetId?: string;
  }[];
  readonly unresolvedUncertainty: readonly string[];
  readonly evidenceHash: string;
}

export interface StudioWikiPage {
  readonly worldId: string;
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly markdown: string;
  readonly tags: readonly string[];
  /** Wiki titles referenced through [[Title]] syntax. */
  readonly links: readonly string[];
  readonly revision: number;
  readonly contentHash: string;
}

export interface StudioWikiPageWithBacklinks extends StudioWikiPage {
  readonly backlinks: readonly { readonly id: string; readonly slug: string; readonly title: string }[];
}

export interface StudioSettingBookExport {
  readonly worldId: string;
  readonly id: string;
  readonly runId: string;
  readonly contractHash: string;
  readonly filename: string;
  readonly markdown: string;
  readonly contentHash: string;
  readonly manifest: {
    readonly sourceStateHash: string;
    readonly branchId?: string;
    readonly guidanceIds: readonly string[];
    readonly unresolvedUncertainty: readonly string[];
    readonly projectionHash: string;
  };
}
