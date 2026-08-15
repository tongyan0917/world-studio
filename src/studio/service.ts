import { WorldEngine } from "../world-model/engine.ts";
import { mechanismLibrary, saltMarshBlueprint, saltMarshSources, xuanxiaoBlueprint, xuanxiaoSources } from "../world-model/examples.ts";
import { projectKnowledgeGraph, projectTimeline } from "../world-model/projections.ts";
import { createDefaultMultiScaleSchedule, createDefaultWorldEvolutionPlan } from "../world-model/simulation.ts";
import { SqliteWorldStore } from "../world-model/store.ts";
import type { AutonomousWorldRun, CompiledWorldPackage, GraphWorldAction, WorldSnapshot } from "../world-model/types.ts";
import { compileCreatorWorldDefinition, createCreatorWorldDraft, inspectCreatorWorldDefinition } from "./authoring.ts";
import { exportSettingBook } from "./export.ts";
import { StudioHistoryService } from "./history-service.ts";
import { advanceRunControl, createRunControl, requestRunPause, resumeRunControl, startRunControl } from "./run-control.ts";
import type { CreatorWorldDefinition, StudioBranchRequest, StudioRunControl } from "./types.ts";
import { createWikiPage } from "./wiki.ts";

const auditFactPredicates = new Set(["mechanism-boundary-evaluation", "bounded-model-proposal-selected"]);

function calendarStart(compiled: CompiledWorldPackage): number {
  const hinted = compiled.blueprint.presentationHints?.startYear;
  if (typeof hinted === "number" && Number.isFinite(hinted)) return hinted;
  if (compiled.worldId === "world.salt-marsh") return 230;
  if (compiled.worldId === "world.xuanxiao-nine-realms") return 612;
  return 1;
}

function focusSubjects(snapshot: WorldSnapshot): string[] {
  const focal = Object.values(snapshot.nodes).filter((node) => node.attributes.focal === true).map((node) => node.id);
  if (focal.length > 0) return focal.sort();
  return Object.values(snapshot.nodes).filter((node) => ["person", "cultivator"].includes(node.type)).slice(0, 2).map((node) => node.id).sort();
}

function summarizedControl(control: StudioRunControl) {
  return {
    worldId: control.worldId,
    id: control.id,
    revision: control.revision,
    status: control.status,
    nextBoundaryIndex: control.nextBoundaryIndex,
    boundaryCount: control.plan.boundaries.length,
    finalRunId: control.finalRunId,
    failure: control.failure,
  };
}

export function blankCreatorWorldTemplate(worldId = "world.my-world", title = "Untitled World"): CreatorWorldDefinition {
  return {
    schemaVersion: 1,
    worldId,
    draftId: "draft.main",
    version: "1",
    metadata: { title, summary: "Describe the material, social, and historical premise that makes this World distinct.", tags: [] },
    temporal: { calendarName: "Local Era", startYear: 1, coordinateDescription: "Linear years with nested macro, meso, and micro frames." },
    premises: ["world.change-recorded", "world.creator-parameters-causal"],
    geography: { places: [], routes: [] },
    populations: { settlements: [], groups: [] },
    characters: [], organizations: [], institutions: [], resources: [], relationships: [], information: [], hazards: [], theoryPacks: [], hardRules: [],
    parameters: { environmentalVolatility: 1, routeSensitivity: 1, hazardFrequencyMultiplier: 1, organizationAdaptationRate: 1 },
    initialState: { facts: [] },
  };
}

export class StudioService {
  readonly store: SqliteWorldStore;
  readonly engine: WorldEngine;
  readonly history: StudioHistoryService;

  constructor(store: SqliteWorldStore) {
    this.store = store;
    this.engine = new WorldEngine({ store, mechanismLibrary });
    this.history = new StudioHistoryService(this.engine);
  }

  async seedDemoWorlds(): Promise<void> {
    for (const fixture of [
      { blueprint: saltMarshBlueprint, sources: saltMarshSources },
      { blueprint: xuanxiaoBlueprint, sources: xuanxiaoSources },
    ]) {
      if (!this.store.loadCompiledWorld(fixture.blueprint.worldId)) {
        const built = await this.engine.build(fixture.blueprint, fixture.sources);
        this.engine.accept(built.compilation.base);
      }
      if (this.store.listWikiPages(fixture.blueprint.worldId).length === 0) {
        const page = createWikiPage(fixture.blueprint.worldId, {
          slug: "world-overview",
          title: "World Overview",
          markdown: `# ${fixture.blueprint.title}\n\n${fixture.blueprint.summary}\n\nThis page is creator-editable. Engine state remains in the immutable Contract and Run ledger. #overview`,
        }, 1);
        this.store.saveWikiPage(page, 0);
      }
    }
  }

  listWorlds() {
    return this.store.listWorlds().filter((world) => Boolean(this.store.loadCompiledWorld(world.worldId))).map((world) => {
      const compiled = this.store.loadCompiledWorld(world.worldId)!;
      const latest = this.store.loadLatestAutonomousRun(world.worldId);
      return {
        ...world,
        summary: compiled.blueprint.summary,
        contractHash: compiled.contract.hash,
        instanceId: compiled.instance.id,
        latestRunId: latest?.run.manifest.runId,
        runCount: this.store.listAutonomousRuns(world.worldId).length,
      };
    });
  }

  inspectDefinition(definition: CreatorWorldDefinition) {
    return inspectCreatorWorldDefinition(definition);
  }

  saveDefinition(definition: CreatorWorldDefinition, expectedRevision: number) {
    const draft = createCreatorWorldDraft(definition, expectedRevision + 1);
    this.store.saveWorldDraft(draft, expectedRevision);
    return draft;
  }

  async compileSavedDefinition(worldId: string, draftId: string): Promise<CompiledWorldPackage> {
    const draft = this.store.loadWorldDraft(worldId, draftId);
    if (!draft) throw new Error(`No saved creator draft ${draftId} exists in ${worldId}`);
    if (draft.status !== "ready") throw new Error(`Creator draft ${draftId} is ${draft.status}; resolve its questions and issues first`);
    const input = compileCreatorWorldDefinition(draft.definition);
    const built = await this.engine.build(input.blueprint, input.sources);
    if (built.compilation.base.findings.some((finding) => finding.severity === "error")) throw new Error(`Compilation failed: ${built.compilation.base.findings.map((finding) => finding.message).join("; ")}`);
    const compiled = this.engine.accept(built.compilation.base);
    if (this.store.listWikiPages(worldId).length === 0) {
      const overview = createWikiPage(worldId, {
        slug: "world-overview",
        title: "World Overview",
        markdown: `# ${compiled.blueprint.title}\n\n${compiled.blueprint.summary}\n\n#overview`,
      }, 1);
      this.store.saveWikiPage(overview, 0);
    }
    return compiled;
  }

  compiled(worldId: string): CompiledWorldPackage {
    const compiled = this.store.loadCompiledWorld(worldId);
    if (!compiled) throw new Error(`No accepted World ${worldId} exists`);
    return compiled;
  }

  workspace(worldId: string, runId?: string) {
    const compiled = this.compiled(worldId);
    const autonomous = runId ? this.store.loadAutonomousRun(worldId, runId) : this.store.loadLatestAutonomousRun(worldId);
    if (runId && !autonomous) throw new Error(`No autonomous Run ${runId} exists in ${worldId}`);
    const run = autonomous?.run;
    const snapshot = run?.finalSnapshot ?? compiled.instance.initialSnapshot;
    const graph = run ? projectKnowledgeGraph(run) : {
      worldId,
      kind: "knowledge-graph" as const,
      sourceRunId: "initial-state",
      sourceStateHash: compiled.instance.initialStateHash,
      nodes: Object.values(snapshot.nodes), edges: Object.values(snapshot.edges), facts: Object.values(snapshot.facts),
    };
    const visibleFacts = graph.facts.filter((fact) => !auditFactPredicates.has(fact.predicate));
    const nodes = graph.nodes;
    const places = nodes.filter((node) => node.type === "place").map((node, index) => ({
      id: node.id,
      name: typeof node.attributes.name === "string" ? node.attributes.name : node.id,
      x: typeof node.attributes["map-x"] === "number" ? node.attributes["map-x"] : 20 + (index * 31) % 70,
      y: typeof node.attributes["map-y"] === "number" ? node.attributes["map-y"] : 25 + (index * 43) % 60,
      coordinates: typeof node.attributes["map-x"] === "number" && typeof node.attributes["map-y"] === "number" ? "creator" : "layout-only",
      imagePath: typeof node.attributes["image-path"] === "string" ? node.attributes["image-path"] : undefined,
      imageCaption: typeof node.attributes["image-caption"] === "string" ? node.attributes["image-caption"] : undefined,
      attributes: node.attributes,
    }));
    const nodeTypes = [...new Set(nodes.map((node) => node.type))].sort();
    return {
      world: { worldId, title: compiled.blueprint.title, summary: compiled.blueprint.summary },
      contract: { id: compiled.contract.id, version: compiled.contract.version, hash: compiled.contract.hash, authority: compiled.contract.authority },
      instance: { id: compiled.instance.id, initialStateHash: compiled.instance.initialStateHash },
      run: autonomous ? {
        id: autonomous.run.manifest.runId,
        stateHash: autonomous.run.finalStateHash,
        seed: autonomous.run.manifest.seed,
        quiescent: autonomous.quiescent,
        closure: autonomous.closureAudit,
        guidanceIds: autonomous.run.manifest.guidanceIds,
        parentRunId: autonomous.run.manifest.parentRunId,
        branchId: autonomous.run.manifest.branchId,
      } : undefined,
      graph: { ...graph, facts: visibleFacts },
      timeline: run ? projectTimeline(run) : { worldId, kind: "timeline", sourceRunId: "initial-state", sourceStateHash: compiled.instance.initialStateHash, entries: [] },
      boundaries: autonomous?.boundaries ?? [],
      map: { places, routes: nodes.filter((node) => node.type === "route") },
      entityGroups: Object.fromEntries(nodeTypes.map((type) => [type, nodes.filter((node) => node.type === type)])),
      wiki: this.store.listWikiPages(worldId),
      controls: this.store.listRunControls(worldId).map(summarizedControl),
      runs: this.store.listAutonomousRuns(worldId),
      branches: this.store.listBranches(worldId),
      historyEvidence: this.store.listHistoryEvidence(worldId),
    };
  }

  startRun(worldId: string, options: { readonly seed: string; readonly calendarStartYear?: number; readonly focusSubjectIds?: readonly string[]; readonly controlId?: string }): StudioRunControl {
    const compiled = this.compiled(worldId);
    const schedule = createDefaultMultiScaleSchedule(worldId, compiled.contract.hash, options.focusSubjectIds ?? focusSubjects(compiled.instance.initialSnapshot));
    const plan = createDefaultWorldEvolutionPlan(worldId, compiled.contract.hash, schedule, options.calendarStartYear ?? calendarStart(compiled));
    let control = createRunControl(compiled, plan, schedule, { seed: options.seed, ...(options.controlId ? { controlId: options.controlId } : {}) });
    this.store.saveRunControl(control, 0);
    control = startRunControl(control);
    this.store.saveRunControl(control, 1);
    return control;
  }

  async actOnRun(worldId: string, controlId: string, action: "advance" | "pause" | "resume" | "run-to-complete"): Promise<StudioRunControl> {
    const compiled = this.compiled(worldId);
    let control = this.store.loadRunControl(worldId, controlId);
    if (!control) throw new Error(`No Run control ${controlId} exists in ${worldId}`);
    if (action === "pause") {
      const requested = requestRunPause(control);
      this.store.saveRunControl(requested, control.revision);
      control = await advanceRunControl(compiled, requested);
      this.store.saveRunControl(control, requested.revision);
      return control;
    }
    if (action === "resume") {
      const resumed = resumeRunControl(control);
      this.store.saveRunControl(resumed, control.revision);
      return resumed;
    }
    const advanceOnce = async () => {
      const previous = control;
      control = await advanceRunControl(compiled, previous, {
        onModelProposalSet: (proposalSet) => this.store.saveTransitionProposalSet(worldId, proposalSet),
      });
      this.store.saveRunControl(control, previous.revision);
      if (control.status === "complete" && control.checkpoint) {
        this.store.saveRun(worldId, control.checkpoint.run);
        this.store.saveAutonomousRun(worldId, control.checkpoint);
      }
    };
    if (action === "advance") await advanceOnce();
    else while (control.status === "running") await advanceOnce();
    return control;
  }

  async branch(worldId: string, request: StudioBranchRequest) {
    const compiled = this.compiled(worldId);
    const parent = this.store.loadAutonomousRun(worldId, request.parentRunId);
    if (!parent) throw new Error(`No parent autonomous Run ${request.parentRunId} exists in ${worldId}`);
    if (!parent.schedule) throw new Error("Parent Run predates retained Schedule support and cannot be branched through the product API");
    return this.history.branchAtSelection(compiled, parent, parent.schedule, request);
  }

  explain(worldId: string, runId: string, target: { readonly kind: "node" | "edge" | "fact"; readonly id: string; readonly fieldId?: string }) {
    const run = this.store.loadAutonomousRun(worldId, runId);
    if (!run) throw new Error(`No autonomous Run ${runId} exists in ${worldId}`);
    return this.engine.explain(run, target);
  }

  impact(worldId: string, runId: string, inputIds: readonly string[]) {
    const run = this.store.loadAutonomousRun(worldId, runId);
    if (!run) throw new Error(`No autonomous Run ${runId} exists in ${worldId}`);
    return this.engine.traceImpact(run, inputIds);
  }

  compare(worldId: string, parentRunId: string, candidateRunId: string) {
    const parent = this.store.loadAutonomousRun(worldId, parentRunId);
    const candidate = this.store.loadAutonomousRun(worldId, candidateRunId);
    if (!parent || !candidate) throw new Error("Both parent and candidate autonomous Runs must exist in the selected World");
    return this.engine.compare(parent, candidate);
  }

  saveWiki(worldId: string, input: { readonly slug: string; readonly title: string; readonly markdown: string; readonly tags?: readonly string[] }, expectedRevision: number) {
    this.compiled(worldId);
    const page = createWikiPage(worldId, input, expectedRevision + 1);
    this.store.saveWikiPage(page, expectedRevision);
    return this.store.loadWikiPage(worldId, page.slug)!;
  }

  export(worldId: string, runId?: string) {
    const compiled = this.compiled(worldId);
    const autonomous = runId ? this.store.loadAutonomousRun(worldId, runId) : this.store.loadLatestAutonomousRun(worldId);
    if (!autonomous) throw new Error(`No completed autonomous Run exists in ${worldId}`);
    const value = exportSettingBook(compiled, autonomous, this.store.listHistoryEvidence(worldId));
    this.store.saveSettingBookExport(value);
    return value;
  }

  defaultInterventionAction(snapshot: WorldSnapshot, target: { readonly kind: "node" | "edge"; readonly id: string; readonly fieldId: string }, value: unknown): GraphWorldAction {
    const object = target.kind === "node" ? snapshot.nodes[target.id] : snapshot.edges[target.id];
    if (!object) throw new Error(`Unknown ${target.kind} ${target.id}`);
    if (!Object.hasOwn(object.attributes, target.fieldId)) throw new Error(`Unknown attribute ${target.fieldId}`);
    return target.kind === "node"
      ? { kind: "set-node-attribute", nodeId: target.id, fieldId: target.fieldId, value: value as never }
      : { kind: "set-edge-attribute", edgeId: target.id, fieldId: target.fieldId, value: value as never };
  }
}
