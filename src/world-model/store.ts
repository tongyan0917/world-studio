import { DatabaseSync } from "node:sqlite";
import { hash } from "../kernel/stable.ts";
import { graphActionWritePath, isCanonicalWorldStatePath, writerForWorldReadPath, writePathCanProduceReadPath } from "./causal-path.ts";
import { auditCausalClosure } from "./evolution.ts";
import { assertCompiledWorldIsolation, assertWorldScope, WorldIsolationError } from "./isolation.ts";
import type {
  AutonomousWorldRun,
  ModelInvocationRecord,
  CompiledWorldPackage,
  ContractChangeSet,
  CreatorQuery,
  ProjectionReviewProposal,
  SemanticContribution,
  TransitionProposalSet,
  WorldBlueprint,
  WorldBranch,
  WorldContextPackage,
  WorldContract,
  WorldEdge,
  WorldFact,
  WorldNode,
  WorldProjection,
  WorldRunRecord,
  WorldSourceRecord,
} from "./types.ts";
import { CAUSAL_DIMENSIONS } from "./types.ts";
import type { CreatorWorldDraft, StudioHistoryEvidence, StudioRunControl, StudioSettingBookExport, StudioWikiPage, StudioWikiPageWithBacklinks } from "../studio/types.ts";
import { runControlContentHash } from "../studio/run-control.ts";
import { wikiPageContentHash } from "../studio/wiki.ts";
import type { WorldInstance } from "./types.ts";

export const WORLD_STUDIO_SCHEMA_VERSION = 5;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parse<T>(value: unknown): T {
  if (typeof value !== "string") throw new TypeError("Expected stored JSON text");
  return JSON.parse(value) as T;
}

function deepFreezeArtifact<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeArtifact(child);
    Object.freeze(value);
  }
  return value;
}

function assertExpectedWorld(expected: string, actual: string, label: string): void {
  if (actual !== expected) throw new WorldIsolationError(`${label} belongs to ${actual}, not ${expected}`);
}

function assertAutonomousArtifactConsistency(autonomous: AutonomousWorldRun): void {
  const planCore = {
    worldId: autonomous.plan.worldId,
    id: autonomous.plan.id,
    contractHash: autonomous.plan.contractHash,
    scheduleHash: autonomous.plan.scheduleHash,
    boundaries: autonomous.plan.boundaries,
    maximumCausalPassesPerBoundary: autonomous.plan.maximumCausalPassesPerBoundary,
  };
  if (autonomous.plan.planHash !== hash(planCore)) throw new Error("Autonomous Run Evolution Plan hash is invalid");
  if (autonomous.run.manifest.scheduleHash !== autonomous.plan.scheduleHash) throw new Error("Autonomous Run Plan and committed Run have different Schedules");
  if (autonomous.schedule && autonomous.schedule.scheduleHash !== autonomous.plan.scheduleHash) throw new Error("Autonomous Run retained Schedule does not match its Plan");
  if (hash(autonomous.run.manifest.guidanceIds) !== hash((autonomous.guidance ?? []).map((value) => value.id).sort())) throw new Error("Autonomous Run guidance does not match its committed manifest");

  const generatedIds = autonomous.generatedInputs.map((input) => input.id);
  const externalIds = autonomous.externalInputs.map((input) => input.id);
  const declaredIds = [...generatedIds, ...externalIds];
  const runIds = autonomous.run.inputs.map((input) => input.id);
  if (new Set(declaredIds).size !== declaredIds.length) throw new Error("Autonomous Run generated and external input ids must be globally unique");
  if (hash([...declaredIds].sort()) !== hash([...runIds].sort())) throw new Error("Autonomous Run generated/external inputs do not exactly partition the committed Run inputs");
  if (autonomous.generatedInputs.some((input) => input.origin !== "mechanism-generated")) throw new Error("Autonomous Run generated input lacks mechanism-generated authority provenance");
  if (autonomous.externalInputs.some((input) => input.origin === "mechanism-generated")) throw new Error("Autonomous Run external input claims mechanism-generated authority");

  const emissionIds = autonomous.emissions.map((emission) => emission.id);
  if (new Set(emissionIds).size !== emissionIds.length) throw new Error("Autonomous Run emission ids must be unique");
  const emittedProposalIds: string[] = [];
  const generatedById = new Map(autonomous.generatedInputs.map((input) => [input.id, input]));
  const externalById = new Map(autonomous.externalInputs.map((input) => [input.id, input]));
  const emissionById = new Map(autonomous.emissions.map((emission) => [emission.id, emission]));
  const runInputIndex = new Map(autonomous.run.inputs.map((input, index) => [input.id, index]));
  const orderedExternalInputs = autonomous.externalInputs.map((input) => ({ input, index: runInputIndex.get(input.id) ?? Number.POSITIVE_INFINITY })).sort((left, right) => left.index - right.index);
  const writerByPath = new Map<string, { readonly kind: "emission" | "input"; readonly id: string }>();
  let externalCursor = 0;
  const seenEmissionIds = new Set<string>();
  for (const emission of autonomous.emissions) {
    const partition = [...emission.substantiveProposalIds, ...emission.markerProposalIds];
    if (new Set(emission.proposalIds).size !== emission.proposalIds.length || hash([...partition].sort()) !== hash([...emission.proposalIds].sort())) throw new Error(`Emission ${emission.id} proposal partition is invalid`);
    if (new Set(emission.readPaths).size !== emission.readPaths.length || hash([...emission.readPaths].sort()) !== hash(emission.readPaths)) throw new Error(`Emission ${emission.id} read paths must be unique and sorted`);
    if (new Set(emission.writePaths).size !== emission.writePaths.length || hash([...emission.writePaths].sort()) !== hash(emission.writePaths)) throw new Error(`Emission ${emission.id} write paths must be unique and sorted`);
    if ([...emission.readPaths, ...emission.writePaths].some((path) => !isCanonicalWorldStatePath(path))) throw new Error(`Emission ${emission.id} contains a non-canonical World state path`);
    const allowedDimensions = new Set(CAUSAL_DIMENSIONS);
    const validatePathDimensions = (role: "read" | "write", paths: readonly string[], bindings: typeof emission.readPathDimensions) => {
      if (bindings.length !== paths.length || hash(bindings.map((binding) => binding.path)) !== hash(paths)) throw new Error(`Emission ${emission.id} ${role} path dimensions must cover its sorted paths exactly`);
      for (const binding of bindings) {
        if (binding.dimensions.length === 0 || new Set(binding.dimensions).size !== binding.dimensions.length || hash([...binding.dimensions].sort()) !== hash(binding.dimensions)) throw new Error(`Emission ${emission.id} ${role} path ${binding.path} has invalid causal dimensions`);
        if (binding.dimensions.some((dimension) => !allowedDimensions.has(dimension))) throw new Error(`Emission ${emission.id} ${role} path ${binding.path} has an unknown causal dimension`);
      }
    };
    validatePathDimensions("read", emission.readPaths, emission.readPathDimensions);
    validatePathDimensions("write", emission.writePaths, emission.writePathDimensions);
    if (new Set(emission.causalPredecessorEmissionIds).size !== emission.causalPredecessorEmissionIds.length || hash([...emission.causalPredecessorEmissionIds].sort()) !== hash(emission.causalPredecessorEmissionIds)) throw new Error(`Emission ${emission.id} predecessor emission ids must be unique and sorted`);
    if (new Set(emission.causalPredecessorInputIds).size !== emission.causalPredecessorInputIds.length || hash([...emission.causalPredecessorInputIds].sort()) !== hash(emission.causalPredecessorInputIds)) throw new Error(`Emission ${emission.id} predecessor input ids must be unique and sorted`);
    const expectedWritePaths = [...new Set(emission.substantiveProposalIds.map((proposalId) => generatedById.get(proposalId)).filter((input): input is NonNullable<typeof input> => Boolean(input)).map((input) => graphActionWritePath(input.action)))].sort();
    if (hash(expectedWritePaths) !== hash(emission.writePaths)) throw new Error(`Emission ${emission.id} write paths do not match its substantive proposals`);
    for (const proposalId of emission.proposalIds) {
      const input = generatedById.get(proposalId);
      if (!input) throw new Error(`Emission ${emission.id} references unknown generated input ${proposalId}`);
      if (hash(input.causalReadPaths ?? []) !== hash(emission.readPaths)) throw new Error(`Emission ${emission.id} generated input ${proposalId} does not retain actual causal reads`);
      if (hash([...(input.readDimensions ?? [])].sort()) !== hash([...emission.readDimensions].sort())) throw new Error(`Emission ${emission.id} generated input ${proposalId} read dimensions mismatch`);
      if (hash([...(input.writeDimensions ?? [])].sort()) !== hash([...emission.writeDimensions].sort())) throw new Error(`Emission ${emission.id} generated input ${proposalId} write dimensions mismatch`);
    }
    const firstProposalIndex = Math.min(...emission.proposalIds.map((proposalId) => runInputIndex.get(proposalId) ?? Number.POSITIVE_INFINITY));
    while (externalCursor < orderedExternalInputs.length && orderedExternalInputs[externalCursor]!.index < firstProposalIndex) {
      const external = orderedExternalInputs[externalCursor]!.input;
      writerByPath.set(graphActionWritePath(external.action), { kind: "input", id: external.id });
      externalCursor += 1;
    }
    const expectedPredecessors = [...new Map(emission.readPaths
      .map((path) => writerForWorldReadPath(writerByPath, path))
      .filter((writer): writer is { readonly kind: "emission" | "input"; readonly id: string } => Boolean(writer))
      .map((writer) => [`${writer.kind}:${writer.id}`, writer])).values()];
    const expectedEmissionIds = expectedPredecessors.filter((writer) => writer.kind === "emission").map((writer) => writer.id).sort();
    const expectedInputIds = expectedPredecessors.filter((writer) => writer.kind === "input").map((writer) => writer.id).sort();
    if (hash(expectedEmissionIds) !== hash(emission.causalPredecessorEmissionIds) || hash(expectedInputIds) !== hash(emission.causalPredecessorInputIds)) throw new Error(`Emission ${emission.id} causal predecessor set is incomplete or contains an extra writer`);
    for (const predecessorId of emission.causalPredecessorEmissionIds) {
      const predecessor = emissionById.get(predecessorId);
      if (!predecessor || !seenEmissionIds.has(predecessorId)) throw new Error(`Emission ${emission.id} cites a missing or future predecessor ${predecessorId}`);
      if (!predecessor.writePaths.some((writePath) => emission.readPaths.some((readPath) => writePathCanProduceReadPath(writePath, readPath)))) throw new Error(`Emission ${emission.id} predecessor ${predecessorId} has no matching causal path`);
    }
    for (const inputId of emission.causalPredecessorInputIds) {
      const predecessor = externalById.get(inputId);
      if (!predecessor) throw new Error(`Emission ${emission.id} cites an unknown external input predecessor ${inputId}`);
      const writePath = graphActionWritePath(predecessor.action);
      if (!emission.readPaths.some((readPath) => writePathCanProduceReadPath(writePath, readPath))) throw new Error(`Emission ${emission.id} external predecessor ${inputId} has no matching causal path`);
    }
    emittedProposalIds.push(...emission.proposalIds);
    seenEmissionIds.add(emission.id);
    for (const path of emission.writePaths) writerByPath.set(path, { kind: "emission", id: emission.id });
  }
  if (new Set(emittedProposalIds).size !== emittedProposalIds.length || hash([...emittedProposalIds].sort()) !== hash([...generatedIds].sort())) throw new Error("Autonomous Run emissions do not exactly explain every generated input");

  if (hash(autonomous.boundaries.map((record) => record.boundary.id)) !== hash(autonomous.plan.boundaries.map((boundary) => boundary.id))) throw new Error("Autonomous Run boundary records do not exactly cover its Evolution Plan");
  const recordedEmissionIds = autonomous.boundaries.flatMap((boundary) => boundary.emissionIds);
  const recordedProposalIds = autonomous.boundaries.flatMap((boundary) => boundary.proposalIds);
  if (hash([...recordedEmissionIds].sort()) !== hash([...emissionIds].sort())) throw new Error("Autonomous Run boundary records do not exactly cover its emissions");
  if (hash([...recordedProposalIds].sort()) !== hash([...generatedIds].sort())) throw new Error("Autonomous Run boundary records do not exactly cover its generated inputs");
  const dimensionsClosed = [...new Set(autonomous.boundaries.flatMap((record) => record.dimensionsActivated))].sort();
  if (hash(dimensionsClosed) !== hash(autonomous.dimensionsClosed)) throw new Error("Autonomous Run dimension summary is inconsistent");
  const recomputedAudit = auditCausalClosure(autonomous.worldId, autonomous.emissions, autonomous.boundaries);
  if (hash(recomputedAudit) !== hash(autonomous.closureAudit)) throw new Error("Autonomous Run causal closure audit is not reproducible from its committed emissions");
}

export class SqliteWorldStore {
  readonly #database: DatabaseSync;

  constructor(location = ":memory:") {
    this.#database = new DatabaseSync(location);
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS we_schema_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS we_worlds (
        world_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS we_sources (
        world_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, source_id, revision),
        FOREIGN KEY (world_id) REFERENCES we_worlds(world_id)
      );

      CREATE TABLE IF NOT EXISTS we_blueprints (
        world_id TEXT NOT NULL,
        blueprint_id TEXT NOT NULL,
        version TEXT NOT NULL,
        blueprint_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, blueprint_id, version),
        UNIQUE (world_id, blueprint_hash),
        FOREIGN KEY (world_id) REFERENCES we_worlds(world_id)
      );

      CREATE TABLE IF NOT EXISTS we_world_drafts (
        world_id TEXT NOT NULL,
        draft_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, draft_id),
        FOREIGN KEY (world_id) REFERENCES we_worlds(world_id)
      );

      CREATE TABLE IF NOT EXISTS we_run_controls (
        world_id TEXT NOT NULL,
        control_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        contract_hash TEXT NOT NULL,
        next_boundary_index INTEGER NOT NULL,
        control_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, control_id),
        FOREIGN KEY (world_id, instance_id) REFERENCES we_instances(world_id, instance_id),
        FOREIGN KEY (world_id, contract_hash) REFERENCES we_contracts(world_id, contract_hash)
      );

      CREATE TABLE IF NOT EXISTS we_context_packages (
        world_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, context_id),
        UNIQUE (world_id, payload_hash),
        FOREIGN KEY (world_id) REFERENCES we_worlds(world_id)
      );

      CREATE TABLE IF NOT EXISTS we_model_invocations (
        world_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, invocation_id),
        FOREIGN KEY (world_id, context_id) REFERENCES we_context_packages(world_id, context_id)
      );

      CREATE TABLE IF NOT EXISTS we_semantic_contributions (
        world_id TEXT NOT NULL,
        contribution_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        context_hash TEXT NOT NULL,
        impact TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, contribution_id),
        FOREIGN KEY (world_id, context_id) REFERENCES we_context_packages(world_id, context_id)
      );

      CREATE TABLE IF NOT EXISTS we_creator_queries (
        world_id TEXT NOT NULL,
        query_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, query_id),
        FOREIGN KEY (world_id, context_id) REFERENCES we_context_packages(world_id, context_id)
      );

      CREATE TABLE IF NOT EXISTS we_transition_proposal_sets (
        world_id TEXT NOT NULL,
        proposal_set_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, proposal_set_id),
        FOREIGN KEY (world_id, context_id) REFERENCES we_context_packages(world_id, context_id),
        FOREIGN KEY (world_id, invocation_id) REFERENCES we_model_invocations(world_id, invocation_id)
      );

      CREATE TABLE IF NOT EXISTS we_contracts (
        world_id TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        version TEXT NOT NULL,
        contract_hash TEXT NOT NULL,
        blueprint_id TEXT NOT NULL,
        authority TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, contract_id, version),
        UNIQUE (world_id, contract_hash),
        FOREIGN KEY (world_id) REFERENCES we_worlds(world_id)
      );

      CREATE TABLE IF NOT EXISTS we_instances (
        world_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        lineage_id TEXT NOT NULL,
        contract_hash TEXT NOT NULL,
        initial_state_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (world_id, instance_id),
        FOREIGN KEY (world_id, contract_hash) REFERENCES we_contracts(world_id, contract_hash)
      );

      CREATE TABLE IF NOT EXISTS we_nodes (
        world_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        node_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, instance_id, node_id),
        FOREIGN KEY (world_id, instance_id) REFERENCES we_instances(world_id, instance_id)
      );

      CREATE TABLE IF NOT EXISTS we_edges (
        world_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        edge_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, instance_id, edge_id),
        FOREIGN KEY (world_id, instance_id) REFERENCES we_instances(world_id, instance_id)
      );

      CREATE TABLE IF NOT EXISTS we_facts (
        world_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        subject_node_id TEXT NOT NULL,
        predicate TEXT NOT NULL,
        authority TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, instance_id, fact_id),
        FOREIGN KEY (world_id, instance_id) REFERENCES we_instances(world_id, instance_id)
      );

      CREATE TABLE IF NOT EXISTS we_runs (
        world_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        possible_history_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        contract_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        initial_state_hash TEXT NOT NULL,
        final_state_hash TEXT NOT NULL,
        trace_hash TEXT NOT NULL,
        record_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, run_id),
        FOREIGN KEY (world_id, instance_id) REFERENCES we_instances(world_id, instance_id),
        FOREIGN KEY (world_id, contract_hash) REFERENCES we_contracts(world_id, contract_hash)
      );

      CREATE TABLE IF NOT EXISTS we_autonomous_runs (
        world_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        generated_input_hash TEXT NOT NULL,
        quiescent INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, run_id),
        FOREIGN KEY (world_id, run_id) REFERENCES we_runs(world_id, run_id)
      );

      CREATE TABLE IF NOT EXISTS we_transitions (
        world_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence_no INTEGER NOT NULL,
        transition_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, run_id, sequence_no),
        UNIQUE (world_id, run_id, transition_id),
        FOREIGN KEY (world_id, run_id) REFERENCES we_runs(world_id, run_id)
      );

      CREATE TABLE IF NOT EXISTS we_trace_nodes (
        world_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence_no INTEGER NOT NULL,
        trace_node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, run_id, sequence_no),
        UNIQUE (world_id, run_id, trace_node_id),
        FOREIGN KEY (world_id, run_id) REFERENCES we_runs(world_id, run_id)
      );

      CREATE TABLE IF NOT EXISTS we_branches (
        world_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        parent_run_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, branch_id),
        FOREIGN KEY (world_id, parent_run_id) REFERENCES we_runs(world_id, run_id),
        FOREIGN KEY (world_id, run_id) REFERENCES we_runs(world_id, run_id)
      );

      CREATE TABLE IF NOT EXISTS we_history_evidence (
        world_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        parent_run_id TEXT NOT NULL,
        candidate_run_id TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, evidence_id),
        FOREIGN KEY (world_id, branch_id) REFERENCES we_branches(world_id, branch_id),
        FOREIGN KEY (world_id, parent_run_id) REFERENCES we_runs(world_id, run_id),
        FOREIGN KEY (world_id, candidate_run_id) REFERENCES we_runs(world_id, run_id)
      );

      CREATE TABLE IF NOT EXISTS we_wiki_pages (
        world_id TEXT NOT NULL,
        page_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, page_id),
        UNIQUE (world_id, slug),
        FOREIGN KEY (world_id) REFERENCES we_worlds(world_id)
      );

      CREATE TABLE IF NOT EXISTS we_setting_book_exports (
        world_id TEXT NOT NULL,
        export_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        contract_hash TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, export_id),
        FOREIGN KEY (world_id, run_id) REFERENCES we_runs(world_id, run_id),
        FOREIGN KEY (world_id, contract_hash) REFERENCES we_contracts(world_id, contract_hash)
      );

      CREATE TABLE IF NOT EXISTS we_projections (
        world_id TEXT NOT NULL,
        projection_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_state_hash TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, projection_id),
        FOREIGN KEY (world_id, run_id) REFERENCES we_runs(world_id, run_id)
      );

      CREATE TABLE IF NOT EXISTS we_projection_reviews (
        world_id TEXT NOT NULL,
        review_id TEXT NOT NULL,
        projection_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, review_id),
        FOREIGN KEY (world_id, projection_id) REFERENCES we_projections(world_id, projection_id)
      );

      CREATE TABLE IF NOT EXISTS we_contract_changes (
        world_id TEXT NOT NULL,
        change_id TEXT NOT NULL,
        from_contract_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (world_id, change_id),
        FOREIGN KEY (world_id, from_contract_hash) REFERENCES we_contracts(world_id, contract_hash)
      );
    `);
    const schema = this.#database.prepare("SELECT schema_version FROM we_schema_meta WHERE singleton = 1").get() as { schema_version?: number } | undefined;
    if (schema?.schema_version !== undefined && schema.schema_version > WORLD_STUDIO_SCHEMA_VERSION) throw new Error(`Database schema ${schema.schema_version} is newer than supported ${WORLD_STUDIO_SCHEMA_VERSION}`);
    this.#database.prepare(`
      INSERT INTO we_schema_meta (singleton, schema_version) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET schema_version = excluded.schema_version
    `).run(WORLD_STUDIO_SCHEMA_VERSION);
  }

  close(): void {
    this.#database.close();
  }

  schemaVersion(): number {
    const row = this.#database.prepare("SELECT schema_version FROM we_schema_meta WHERE singleton = 1").get() as { schema_version: number };
    return row.schema_version;
  }

  #insertImmutable(
    selectSql: string,
    selectArgs: readonly (string | number)[],
    insertSql: string,
    insertArgs: readonly (string | number)[],
    payload: unknown,
    label: string,
  ): void {
    const existing = this.#database.prepare(selectSql).get(...selectArgs) as { payload_json?: unknown } | undefined;
    if (existing) {
      if (hash(parse(existing.payload_json)) !== hash(payload)) throw new Error(`${label} is immutable and already exists with different content`);
      return;
    }
    this.#database.prepare(insertSql).run(...insertArgs);
  }

  #ensureWorld(worldId: string, title = worldId, payload: unknown = { worldId, title }): void {
    this.#database.prepare(`
      INSERT INTO we_worlds (world_id, title, payload_json) VALUES (?, ?, ?)
      ON CONFLICT(world_id) DO UPDATE SET title = excluded.title
    `).run(worldId, title, json(payload));
  }

  saveSource(worldId: string, source: WorldSourceRecord): void {
    assertExpectedWorld(worldId, source.worldId, `Source ${source.id}`);
    this.#ensureWorld(worldId);
    this.#insertImmutable(
      "SELECT payload_json FROM we_sources WHERE world_id = ? AND source_id = ? AND revision = ?",
      [worldId, source.id, source.revision],
      "INSERT INTO we_sources (world_id, source_id, revision, content_hash, payload_json) VALUES (?, ?, ?, ?, ?)",
      [worldId, source.id, source.revision, source.contentHash, json(source)],
      source,
      `Source ${source.id}@${source.revision}`,
    );
  }

  saveWorldDraft(draft: CreatorWorldDraft, expectedRevision: number): void {
    assertExpectedWorld(draft.worldId, draft.definition.worldId, `Draft ${draft.draftId} definition`);
    if (draft.definition.draftId !== draft.draftId) throw new Error(`Draft ${draft.draftId} identity does not match its definition`);
    if (draft.definitionHash !== hash(draft.definition)) throw new Error(`Draft ${draft.draftId} definition hash is invalid`);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new RangeError("Expected draft revision must be a non-negative safe integer");
    if (!Number.isSafeInteger(draft.revision) || draft.revision !== expectedRevision + 1) throw new Error(`Draft revision conflict: expected next revision ${expectedRevision + 1}, received ${draft.revision}`);
    this.#ensureWorld(draft.worldId, draft.definition.metadata.title, { worldId: draft.worldId, title: draft.definition.metadata.title, draftId: draft.draftId });
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare("SELECT revision FROM we_world_drafts WHERE world_id = ? AND draft_id = ?").get(draft.worldId, draft.draftId) as { revision?: number } | undefined;
      const actualRevision = existing?.revision ?? 0;
      if (actualRevision !== expectedRevision) throw new Error(`Draft revision conflict: expected ${expectedRevision}, stored ${actualRevision}`);
      this.#database.prepare(`
        INSERT INTO we_world_drafts (world_id, draft_id, revision, status, definition_hash, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(world_id, draft_id) DO UPDATE SET
          revision = excluded.revision,
          status = excluded.status,
          definition_hash = excluded.definition_hash,
          payload_json = excluded.payload_json
      `).run(draft.worldId, draft.draftId, draft.revision, draft.status, draft.definitionHash, json(draft));
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  loadWorldDraft(worldId: string, draftId: string): CreatorWorldDraft | undefined {
    const row = this.#database.prepare("SELECT payload_json, definition_hash FROM we_world_drafts WHERE world_id = ? AND draft_id = ?").get(worldId, draftId) as { payload_json?: unknown; definition_hash?: string } | undefined;
    const value = row ? parse<CreatorWorldDraft>(row.payload_json) : undefined;
    if (value) {
      assertExpectedWorld(worldId, value.worldId, `Stored Draft ${draftId}`);
      if (value.draftId !== draftId || value.definition.draftId !== draftId) throw new Error(`Stored Draft ${draftId} identity is invalid`);
      if (value.definitionHash !== row?.definition_hash || value.definitionHash !== hash(value.definition)) throw new Error(`Stored Draft ${draftId} definition hash is invalid`);
    }
    return value ? deepFreezeArtifact(value) : value;
  }

  listWorldDrafts(worldId: string): readonly CreatorWorldDraft[] {
    return (this.#database.prepare("SELECT draft_id FROM we_world_drafts WHERE world_id = ? ORDER BY rowid DESC").all(worldId) as readonly { draft_id: string }[])
      .map((row) => this.loadWorldDraft(worldId, row.draft_id)!)
      .filter(Boolean);
  }

  saveRunControl(control: StudioRunControl, expectedRevision: number): void {
    if (control.controlHash !== runControlContentHash(control)) throw new Error(`Run control ${control.id} hash is invalid`);
    if (control.plan.worldId !== control.worldId || control.schedule.worldId !== control.worldId || control.checkpoint?.worldId && control.checkpoint.worldId !== control.worldId) throw new WorldIsolationError(`Run control ${control.id} contains a foreign World artifact`);
    if (control.plan.contractHash !== control.contractHash || control.schedule.contractHash !== control.contractHash) throw new Error(`Run control ${control.id} Contract binding is invalid`);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new RangeError("Expected run-control revision must be a non-negative safe integer");
    if (!Number.isSafeInteger(control.revision) || control.revision !== expectedRevision + 1) throw new Error(`Run control revision conflict: expected next revision ${expectedRevision + 1}, received ${control.revision}`);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare("SELECT revision FROM we_run_controls WHERE world_id = ? AND control_id = ?").get(control.worldId, control.id) as { revision?: number } | undefined;
      const actualRevision = existing?.revision ?? 0;
      if (actualRevision !== expectedRevision) throw new Error(`Run control revision conflict: expected ${expectedRevision}, stored ${actualRevision}`);
      this.#database.prepare(`
        INSERT INTO we_run_controls (world_id, control_id, revision, status, instance_id, contract_hash, next_boundary_index, control_hash, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(world_id, control_id) DO UPDATE SET
          revision = excluded.revision,
          status = excluded.status,
          next_boundary_index = excluded.next_boundary_index,
          control_hash = excluded.control_hash,
          payload_json = excluded.payload_json
      `).run(control.worldId, control.id, control.revision, control.status, control.instanceId, control.contractHash, control.nextBoundaryIndex, control.controlHash, json(control));
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  loadRunControl(worldId: string, controlId: string): StudioRunControl | undefined {
    const row = this.#database.prepare("SELECT payload_json, control_hash FROM we_run_controls WHERE world_id = ? AND control_id = ?").get(worldId, controlId) as { payload_json?: unknown; control_hash?: string } | undefined;
    const value = row ? parse<StudioRunControl>(row.payload_json) : undefined;
    if (value) {
      assertExpectedWorld(worldId, value.worldId, `Stored Run control ${controlId}`);
      if (value.id !== controlId) throw new Error(`Stored Run control ${controlId} identity is invalid`);
      if (value.controlHash !== row?.control_hash || value.controlHash !== runControlContentHash(value)) throw new Error(`Stored Run control ${controlId} hash is invalid`);
      if (value.checkpoint && value.checkpointHash !== hash(value.checkpoint)) throw new Error(`Stored Run control ${controlId} checkpoint hash is invalid`);
    }
    return value ? deepFreezeArtifact(value) : value;
  }

  saveContextPackage(worldId: string, context: WorldContextPackage): void {
    assertExpectedWorld(worldId, context.worldId, `Context ${context.id}`);
    if (context.payloadHash !== hash(context.payload)) throw new Error(`Context ${context.id} payload hash is invalid`);
    this.#ensureWorld(worldId);
    this.#insertImmutable(
      "SELECT payload_json FROM we_context_packages WHERE world_id = ? AND context_id = ?",
      [worldId, context.id],
      "INSERT INTO we_context_packages (world_id, context_id, payload_hash, payload_json) VALUES (?, ?, ?, ?)",
      [worldId, context.id, context.payloadHash, json(context)],
      context,
      `Context ${context.id}`,
    );
  }

  saveModelInvocation(worldId: string, invocation: ModelInvocationRecord): void {
    assertExpectedWorld(worldId, invocation.worldId, `Model Invocation ${invocation.id}`);
    const context = this.#database.prepare("SELECT payload_hash FROM we_context_packages WHERE world_id = ? AND context_id = ?").get(worldId, invocation.contextPackageId) as { payload_hash?: unknown } | undefined;
    if (!context || context.payload_hash !== invocation.contextPackageHash) throw new Error(`Model Invocation ${invocation.id} has no matching context hash`);
    this.#insertImmutable(
      "SELECT payload_json FROM we_model_invocations WHERE world_id = ? AND invocation_id = ?",
      [worldId, invocation.id],
      "INSERT INTO we_model_invocations (world_id, invocation_id, context_id, status, payload_json) VALUES (?, ?, ?, ?, ?)",
      [worldId, invocation.id, invocation.contextPackageId, invocation.status, json(invocation)],
      invocation,
      `Model Invocation ${invocation.id}`,
    );
  }

  saveSemanticContribution(worldId: string, contribution: SemanticContribution): void {
    assertExpectedWorld(worldId, contribution.worldId, `Contribution ${contribution.id}`);
    const context = this.#database.prepare("SELECT payload_hash FROM we_context_packages WHERE world_id = ? AND context_id = ?").get(worldId, contribution.contextPackageId) as { payload_hash?: unknown } | undefined;
    if (!context || context.payload_hash !== contribution.contextPackageHash) throw new Error(`Contribution ${contribution.id} has no matching context hash`);
    this.#insertImmutable(
      "SELECT payload_json FROM we_semantic_contributions WHERE world_id = ? AND contribution_id = ?",
      [worldId, contribution.id],
      "INSERT INTO we_semantic_contributions (world_id, contribution_id, context_id, context_hash, impact, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
      [worldId, contribution.id, contribution.contextPackageId, contribution.contextPackageHash, contribution.impact, json(contribution)],
      contribution,
      `Contribution ${contribution.id}`,
    );
  }

  saveCreatorQuery(worldId: string, query: CreatorQuery): void {
    assertExpectedWorld(worldId, query.worldId, `Creator Query ${query.id}`);
    this.#insertImmutable(
      "SELECT payload_json FROM we_creator_queries WHERE world_id = ? AND query_id = ?",
      [worldId, query.id],
      "INSERT INTO we_creator_queries (world_id, query_id, context_id, status, payload_json) VALUES (?, ?, ?, ?, ?)",
      [worldId, query.id, query.contextPackageId, query.status, json(query)],
      query,
      `Creator Query ${query.id}`,
    );
  }

  saveTransitionProposalSet(
    worldId: string,
    proposalSet: TransitionProposalSet,
  ): void {
    const contextPackage = proposalSet.contextPackage;
    assertExpectedWorld(worldId, contextPackage.worldId, `Context ${contextPackage.id}`);
    assertExpectedWorld(worldId, proposalSet.worldId, `Transition Proposal Set ${proposalSet.id}`);
    assertWorldScope(worldId, [
      { label: "Decision context", value: proposalSet.context },
      { label: "Decision context package", value: contextPackage },
      { label: "Model Invocation", value: proposalSet.invocation },
      ...(proposalSet.attemptedInvocations ?? []).map((value) => ({ label: `Attempted Invocation ${value.id}`, value })),
      ...proposalSet.candidates.map((candidate) => ({ label: `Candidate ${candidate.id}`, value: candidate })),
      ...proposalSet.candidates.map((candidate) => ({ label: `Candidate input ${candidate.input.id}`, value: candidate.input })),
    ]);
    if (proposalSet.context.id !== proposalSet.candidates[0]?.contextId) throw new Error("Transition Proposal Set candidate context mismatch");
    if (proposalSet.invocation.contextPackageId !== contextPackage.id || proposalSet.invocation.contextPackageHash !== contextPackage.payloadHash) throw new Error("Transition Proposal Set invocation context mismatch");
    this.saveContextPackage(worldId, contextPackage);
    for (const invocation of proposalSet.attemptedInvocations ?? []) this.saveModelInvocation(worldId, invocation);
    this.saveModelInvocation(worldId, proposalSet.invocation);
    this.#insertImmutable(
      "SELECT payload_json FROM we_transition_proposal_sets WHERE world_id = ? AND proposal_set_id = ?",
      [worldId, proposalSet.id],
      "INSERT INTO we_transition_proposal_sets (world_id, proposal_set_id, context_id, invocation_id, payload_json) VALUES (?, ?, ?, ?, ?)",
      [worldId, proposalSet.id, contextPackage.id, proposalSet.invocation.id, json(proposalSet)],
      proposalSet,
      `Transition Proposal Set ${proposalSet.id}`,
    );
  }

  saveCompiledWorld(worldId: string, compiled: CompiledWorldPackage): void {
    assertExpectedWorld(worldId, compiled.worldId, "Compiled World");
    assertCompiledWorldIsolation(compiled);
    if (compiled.instance.initialStateHash !== hash(compiled.instance.initialSnapshot)) throw new Error("Compiled Instance initial-state hash is invalid");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#ensureWorld(worldId, compiled.blueprint.title, { worldId, title: compiled.blueprint.title, blueprintId: compiled.blueprint.id });
      this.#insertImmutable(
        "SELECT payload_json FROM we_blueprints WHERE world_id = ? AND blueprint_id = ? AND version = ?",
        [worldId, compiled.blueprint.id, compiled.blueprint.version],
        "INSERT INTO we_blueprints (world_id, blueprint_id, version, blueprint_hash, payload_json) VALUES (?, ?, ?, ?, ?)",
        [worldId, compiled.blueprint.id, compiled.blueprint.version, hash(compiled.blueprint), json(compiled.blueprint)],
        compiled.blueprint,
        `Blueprint ${compiled.blueprint.id}@${compiled.blueprint.version}`,
      );
      this.#insertImmutable(
        "SELECT payload_json FROM we_contracts WHERE world_id = ? AND contract_id = ? AND version = ?",
        [worldId, compiled.contract.id, compiled.contract.version],
        "INSERT INTO we_contracts (world_id, contract_id, version, contract_hash, blueprint_id, authority, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [worldId, compiled.contract.id, compiled.contract.version, compiled.contract.hash, compiled.contract.blueprintId, compiled.contract.authority, json(compiled.contract)],
        compiled.contract,
        `Contract ${compiled.contract.id}@${compiled.contract.version}`,
      );
      this.#insertImmutable(
        "SELECT payload_json FROM we_instances WHERE world_id = ? AND instance_id = ?",
        [worldId, compiled.instance.id],
        "INSERT INTO we_instances (world_id, instance_id, lineage_id, contract_hash, initial_state_hash, payload_json, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [worldId, compiled.instance.id, compiled.instance.lineageId, compiled.instance.contractHash, compiled.instance.initialStateHash, json(compiled.instance), json(compiled.instance.initialSnapshot)],
        compiled.instance,
        `Instance ${compiled.instance.id}`,
      );
      const nodeInsert = this.#database.prepare("INSERT OR IGNORE INTO we_nodes (world_id, instance_id, node_id, node_type, payload_json) VALUES (?, ?, ?, ?, ?)");
      for (const node of Object.values(compiled.instance.initialSnapshot.nodes)) nodeInsert.run(worldId, compiled.instance.id, node.id, node.type, json(node));
      const edgeInsert = this.#database.prepare("INSERT OR IGNORE INTO we_edges (world_id, instance_id, edge_id, edge_type, source_node_id, target_node_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const edge of Object.values(compiled.instance.initialSnapshot.edges)) edgeInsert.run(worldId, compiled.instance.id, edge.id, edge.type, edge.from, edge.to, json(edge));
      const factInsert = this.#database.prepare("INSERT OR IGNORE INTO we_facts (world_id, instance_id, fact_id, subject_node_id, predicate, authority, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const fact of Object.values(compiled.instance.initialSnapshot.facts)) factInsert.run(worldId, compiled.instance.id, fact.id, fact.subjectId, fact.predicate, fact.authority, json(fact));
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  saveRun(worldId: string, run: WorldRunRecord): void {
    assertExpectedWorld(worldId, run.worldId, `Run ${run.manifest.runId}`);
    assertWorldScope(worldId, [{ label: "Run manifest", value: run.manifest }, { label: "Initial snapshot", value: run.initialSnapshot }, { label: "Final snapshot", value: run.finalSnapshot }, ...run.inputs.map((value) => ({ label: `Input ${value.id}`, value }))]);
    if (run.manifest.inputHash !== hash(run.inputs)) throw new Error(`Run ${run.manifest.runId} input hash is invalid`);
    if (run.manifest.initialStateHash !== hash(run.initialSnapshot)) throw new Error(`Run ${run.manifest.runId} initial-state hash is invalid`);
    if (run.finalStateHash !== hash(run.finalSnapshot)) throw new Error(`Run ${run.manifest.runId} final-state hash is invalid`);
    if (run.traceHash !== hash(run.trace)) throw new Error(`Run ${run.manifest.runId} trace hash is invalid`);
    if (run.initialSnapshot.contractHash !== run.manifest.contractHash || run.finalSnapshot.contractHash !== run.manifest.contractHash) throw new Error(`Run ${run.manifest.runId} snapshot Contract binding is invalid`);
    const recordHash = hash(run);
    const existing = this.#database.prepare("SELECT record_hash FROM we_runs WHERE world_id = ? AND run_id = ?").get(worldId, run.manifest.runId) as { record_hash?: unknown } | undefined;
    if (existing) {
      if (existing.record_hash !== recordHash) throw new Error(`Run ${run.manifest.runId} is immutable and already exists with different content`);
      return;
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`
        INSERT INTO we_runs (world_id, run_id, possible_history_id, instance_id, contract_hash, status, initial_state_hash, final_state_hash, trace_hash, record_hash, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(worldId, run.manifest.runId, run.manifest.possibleHistoryId, run.manifest.instanceId, run.manifest.contractHash, run.status, run.manifest.initialStateHash, run.finalStateHash, run.traceHash, recordHash, json(run));
      const transitionInsert = this.#database.prepare("INSERT INTO we_transitions (world_id, run_id, sequence_no, transition_id, payload_json) VALUES (?, ?, ?, ?, ?)");
      run.transitions.forEach((transition, index) => transitionInsert.run(worldId, run.manifest.runId, index, transition.id, json(transition)));
      const traceInsert = this.#database.prepare("INSERT INTO we_trace_nodes (world_id, run_id, sequence_no, trace_node_id, kind, payload_json) VALUES (?, ?, ?, ?, ?, ?)");
      run.trace.forEach((node, index) => traceInsert.run(worldId, run.manifest.runId, index, node.id, node.kind, json(node)));
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  saveAutonomousRun(worldId: string, autonomous: AutonomousWorldRun): void {
    assertExpectedWorld(worldId, autonomous.worldId, `Autonomous Run ${autonomous.run.manifest.runId}`);
    assertWorldScope(worldId, [
      { label: "Autonomous Run", value: autonomous },
      { label: "Evolution Plan", value: autonomous.plan },
      ...autonomous.generatedInputs.map((value) => ({ label: `Generated Input ${value.id}`, value })),
      ...autonomous.externalInputs.map((value) => ({ label: `External Input ${value.id}`, value })),
    ]);
    if (autonomous.run.worldId !== worldId) throw new WorldIsolationError("Autonomous Run payload and committed Run belong to different Worlds");
    assertAutonomousArtifactConsistency(autonomous);
    if (autonomous.plan.contractHash !== autonomous.run.manifest.contractHash) throw new Error("Autonomous Run Plan and committed Run have different Contracts");
    if (autonomous.generatedInputHash !== hash(autonomous.generatedInputs)) throw new Error("Autonomous Run generated-input hash is invalid");
    if (autonomous.quiescent !== autonomous.boundaries.every((boundary) => boundary.quiescent)) throw new Error("Autonomous Run quiescence summary is inconsistent");
    const storedRun = this.#database.prepare("SELECT record_hash FROM we_runs WHERE world_id = ? AND run_id = ?").get(worldId, autonomous.run.manifest.runId) as { record_hash?: unknown } | undefined;
    if (!storedRun || storedRun.record_hash !== hash(autonomous.run)) throw new Error(`Autonomous Run ${autonomous.run.manifest.runId} requires its exact committed Run to be stored first`);
    const payloadHash = hash(autonomous);
    this.#insertImmutable(
      "SELECT payload_json FROM we_autonomous_runs WHERE world_id = ? AND run_id = ?",
      [worldId, autonomous.run.manifest.runId],
      "INSERT INTO we_autonomous_runs (world_id, run_id, plan_id, generated_input_hash, quiescent, payload_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [worldId, autonomous.run.manifest.runId, autonomous.plan.id, autonomous.generatedInputHash, autonomous.quiescent ? 1 : 0, payloadHash, json(autonomous)],
      autonomous,
      `Autonomous Run ${autonomous.run.manifest.runId}`,
    );
  }

  saveBranch(worldId: string, branch: WorldBranch): void {
    assertExpectedWorld(worldId, branch.worldId, `Branch ${branch.id}`);
    this.#insertImmutable(
      "SELECT payload_json FROM we_branches WHERE world_id = ? AND branch_id = ?",
      [worldId, branch.id],
      "INSERT INTO we_branches (world_id, branch_id, parent_run_id, run_id, payload_json) VALUES (?, ?, ?, ?, ?)",
      [worldId, branch.id, branch.parentRunId, branch.runId, json(branch)],
      branch,
      `Branch ${branch.id}`,
    );
  }

  saveHistoryEvidence(worldId: string, evidence: StudioHistoryEvidence): void {
    assertExpectedWorld(worldId, evidence.worldId, `History Evidence ${evidence.id}`);
    const { evidenceHash: _ignoredEvidenceHash, ...evidenceContent } = evidence;
    if (evidence.evidenceHash !== hash(evidenceContent)) throw new Error(`History Evidence ${evidence.id} hash is invalid`);
    this.#insertImmutable(
      "SELECT payload_json FROM we_history_evidence WHERE world_id = ? AND evidence_id = ?",
      [worldId, evidence.id],
      "INSERT INTO we_history_evidence (world_id, evidence_id, branch_id, parent_run_id, candidate_run_id, evidence_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [worldId, evidence.id, evidence.branchId, evidence.request.parentRunId, evidence.candidateRunId, evidence.evidenceHash, json(evidence)],
      evidence,
      `History Evidence ${evidence.id}`,
    );
  }

  loadHistoryEvidence(worldId: string, evidenceId: string): StudioHistoryEvidence | undefined {
    const row = this.#database.prepare("SELECT payload_json, evidence_hash FROM we_history_evidence WHERE world_id = ? AND evidence_id = ?").get(worldId, evidenceId) as { payload_json?: unknown; evidence_hash?: string } | undefined;
    const value = row ? parse<StudioHistoryEvidence>(row.payload_json) : undefined;
    if (value) {
      assertExpectedWorld(worldId, value.worldId, `Stored History Evidence ${evidenceId}`);
      const { evidenceHash: _ignoredEvidenceHash, ...evidenceContent } = value;
      if (value.id !== evidenceId || value.evidenceHash !== row?.evidence_hash || value.evidenceHash !== hash(evidenceContent)) throw new Error(`Stored History Evidence ${evidenceId} hash is invalid`);
    }
    return value ? deepFreezeArtifact(value) : value;
  }

  listHistoryEvidence(worldId: string): readonly StudioHistoryEvidence[] {
    return (this.#database.prepare("SELECT payload_json FROM we_history_evidence WHERE world_id = ? ORDER BY rowid").all(worldId) as readonly { payload_json: unknown }[])
      .map((row) => deepFreezeArtifact(parse<StudioHistoryEvidence>(row.payload_json)));
  }

  saveWikiPage(page: StudioWikiPage, expectedRevision: number): void {
    if (page.contentHash !== wikiPageContentHash(page)) throw new Error(`Wiki page ${page.id} content hash is invalid`);
    if (page.id !== `wiki:${page.worldId}:${page.slug}`) throw new Error(`Wiki page ${page.id} identity is invalid`);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || page.revision !== expectedRevision + 1) throw new Error(`Wiki revision conflict: expected next revision ${expectedRevision + 1}, received ${page.revision}`);
    this.#ensureWorld(page.worldId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare("SELECT revision FROM we_wiki_pages WHERE world_id = ? AND page_id = ?").get(page.worldId, page.id) as { revision?: number } | undefined;
      const actualRevision = existing?.revision ?? 0;
      if (actualRevision !== expectedRevision) throw new Error(`Wiki revision conflict: expected ${expectedRevision}, stored ${actualRevision}`);
      this.#database.prepare(`
        INSERT INTO we_wiki_pages (world_id, page_id, slug, title, revision, content_hash, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(world_id, page_id) DO UPDATE SET
          title = excluded.title,
          revision = excluded.revision,
          content_hash = excluded.content_hash,
          payload_json = excluded.payload_json
      `).run(page.worldId, page.id, page.slug, page.title, page.revision, page.contentHash, json(page));
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  loadWikiPage(worldId: string, slug: string): StudioWikiPageWithBacklinks | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM we_wiki_pages WHERE world_id = ? AND slug = ?").get(worldId, slug) as { payload_json?: unknown } | undefined;
    if (!row) return undefined;
    const page = parse<StudioWikiPage>(row.payload_json);
    assertExpectedWorld(worldId, page.worldId, `Wiki page ${page.id}`);
    if (page.contentHash !== wikiPageContentHash(page)) throw new Error(`Stored Wiki page ${page.id} content hash is invalid`);
    const backlinks = this.listWikiPages(worldId)
      .filter((candidate) => candidate.id !== page.id && candidate.links.some((title) => title.localeCompare(page.title, undefined, { sensitivity: "accent" }) === 0))
      .map((candidate) => ({ id: candidate.id, slug: candidate.slug, title: candidate.title }));
    return deepFreezeArtifact({ ...page, backlinks });
  }

  listWikiPages(worldId: string): readonly StudioWikiPage[] {
    return (this.#database.prepare("SELECT payload_json FROM we_wiki_pages WHERE world_id = ? ORDER BY title, slug").all(worldId) as readonly { payload_json: unknown }[]).map((row) => {
      const page = parse<StudioWikiPage>(row.payload_json);
      if (page.contentHash !== wikiPageContentHash(page)) throw new Error(`Stored Wiki page ${page.id} content hash is invalid`);
      return deepFreezeArtifact(page);
    });
  }

  searchWikiPages(worldId: string, query: string): readonly StudioWikiPage[] {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.listWikiPages(worldId);
    return this.listWikiPages(worldId).filter((page) => {
      const haystack = `${page.title}\n${page.markdown}\n${page.tags.join(" ")}`.toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  saveSettingBookExport(value: StudioSettingBookExport): void {
    if (value.contentHash !== hash(value.markdown)) throw new Error(`Setting-book export ${value.id} content hash is invalid`);
    this.#insertImmutable(
      "SELECT payload_json FROM we_setting_book_exports WHERE world_id = ? AND export_id = ?",
      [value.worldId, value.id],
      "INSERT INTO we_setting_book_exports (world_id, export_id, run_id, contract_hash, content_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
      [value.worldId, value.id, value.runId, value.contractHash, value.contentHash, json(value)],
      value,
      `Setting-book export ${value.id}`,
    );
  }

  loadSettingBookExport(worldId: string, exportId: string): StudioSettingBookExport | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM we_setting_book_exports WHERE world_id = ? AND export_id = ?").get(worldId, exportId) as { payload_json?: unknown } | undefined;
    const value = row ? parse<StudioSettingBookExport>(row.payload_json) : undefined;
    if (value) {
      assertExpectedWorld(worldId, value.worldId, `Setting-book export ${exportId}`);
      if (value.contentHash !== hash(value.markdown)) throw new Error(`Stored setting-book export ${exportId} content hash is invalid`);
    }
    return value ? deepFreezeArtifact(value) : value;
  }

  saveProjection(worldId: string, projectionId: string, projection: WorldProjection): void {
    assertExpectedWorld(worldId, projection.worldId, `Projection ${projectionId}`);
    const payloadHash = hash(projection);
    const run = this.#database.prepare("SELECT final_state_hash FROM we_runs WHERE world_id = ? AND run_id = ?").get(worldId, projection.sourceRunId) as { final_state_hash?: unknown } | undefined;
    if (!run) throw new Error(`Projection source Run ${projection.sourceRunId} is not stored in ${worldId}`);
    if (run.final_state_hash !== projection.sourceStateHash) throw new Error(`Projection ${projectionId} source state does not match its Run`);
    this.#insertImmutable(
      "SELECT payload_json FROM we_projections WHERE world_id = ? AND projection_id = ?",
      [worldId, projectionId],
      "INSERT INTO we_projections (world_id, projection_id, run_id, kind, source_state_hash, payload_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [worldId, projectionId, projection.sourceRunId, projection.kind, projection.sourceStateHash, payloadHash, json(projection)],
      projection,
      `Projection ${projectionId}`,
    );
  }

  saveProjectionReview(worldId: string, review: ProjectionReviewProposal): void {
    assertExpectedWorld(worldId, review.worldId, `Review ${review.id}`);
    this.#insertImmutable(
      "SELECT payload_json FROM we_projection_reviews WHERE world_id = ? AND review_id = ?",
      [worldId, review.id],
      "INSERT INTO we_projection_reviews (world_id, review_id, projection_id, status, payload_json) VALUES (?, ?, ?, ?, ?)",
      [worldId, review.id, review.projectionId, review.status, json(review)],
      review,
      `Projection Review ${review.id}`,
    );
  }

  saveContractChange(worldId: string, change: ContractChangeSet): void {
    assertExpectedWorld(worldId, change.worldId, `Contract Change ${change.id}`);
    this.#insertImmutable(
      "SELECT payload_json FROM we_contract_changes WHERE world_id = ? AND change_id = ?",
      [worldId, change.id],
      "INSERT INTO we_contract_changes (world_id, change_id, from_contract_hash, status, payload_json) VALUES (?, ?, ?, ?, ?)",
      [worldId, change.id, change.fromContractHash, change.status, json(change)],
      change,
      `Contract Change ${change.id}`,
    );
  }

  listWorlds(): readonly { readonly worldId: string; readonly title: string }[] {
    return (this.#database.prepare("SELECT world_id, title FROM we_worlds ORDER BY world_id").all() as readonly { world_id: string; title: string }[]).map((row) => ({ worldId: row.world_id, title: row.title }));
  }

  loadCompiledWorld(worldId: string): CompiledWorldPackage | undefined {
    const instanceRow = this.#database.prepare("SELECT payload_json FROM we_instances WHERE world_id = ? ORDER BY rowid DESC LIMIT 1").get(worldId) as { payload_json?: unknown } | undefined;
    if (!instanceRow) return undefined;
    const instance = parse<WorldInstance>(instanceRow.payload_json);
    const contractRow = this.#database.prepare("SELECT payload_json FROM we_contracts WHERE world_id = ? AND contract_hash = ?").get(worldId, instance.contractHash) as { payload_json?: unknown } | undefined;
    if (!contractRow) throw new Error(`Stored Instance ${instance.id} has no Contract`);
    const contract = parse<WorldContract>(contractRow.payload_json);
    const blueprintRow = this.#database.prepare("SELECT payload_json FROM we_blueprints WHERE world_id = ? AND blueprint_id = ? AND version = ?").get(worldId, contract.blueprintId, contract.blueprintVersion) as { payload_json?: unknown } | undefined;
    if (!blueprintRow) throw new Error(`Stored Contract ${contract.id} has no Blueprint`);
    const compiled: CompiledWorldPackage = { worldId, blueprint: parse<WorldBlueprint>(blueprintRow.payload_json), contract, instance, findings: [] };
    assertCompiledWorldIsolation(compiled);
    return deepFreezeArtifact(compiled);
  }

  listAutonomousRuns(worldId: string): readonly {
    readonly runId: string;
    readonly planId: string;
    readonly generatedInputHash: string;
    readonly quiescent: boolean;
  }[] {
    return (this.#database.prepare("SELECT run_id, plan_id, generated_input_hash, quiescent FROM we_autonomous_runs WHERE world_id = ? ORDER BY run_id").all(worldId) as readonly { run_id: string; plan_id: string; generated_input_hash: string; quiescent: number }[]).map((row) => ({
      runId: row.run_id,
      planId: row.plan_id,
      generatedInputHash: row.generated_input_hash,
      quiescent: row.quiescent === 1,
    }));
  }

  loadLatestAutonomousRun(worldId: string): AutonomousWorldRun | undefined {
    const row = this.#database.prepare("SELECT run_id FROM we_autonomous_runs WHERE world_id = ? ORDER BY rowid DESC LIMIT 1").get(worldId) as { run_id?: string } | undefined;
    return row?.run_id ? this.loadAutonomousRun(worldId, row.run_id) : undefined;
  }

  listRunControls(worldId: string): readonly StudioRunControl[] {
    return (this.#database.prepare("SELECT control_id FROM we_run_controls WHERE world_id = ? ORDER BY rowid DESC").all(worldId) as readonly { control_id: string }[])
      .map((row) => this.loadRunControl(worldId, row.control_id)!)
      .filter(Boolean);
  }

  listBranches(worldId: string): readonly WorldBranch[] {
    return (this.#database.prepare("SELECT payload_json FROM we_branches WHERE world_id = ? ORDER BY rowid DESC").all(worldId) as readonly { payload_json: unknown }[])
      .map((row) => deepFreezeArtifact(parse<WorldBranch>(row.payload_json)));
  }

  loadBlueprint(worldId: string, blueprintId: string, version: string): WorldBlueprint | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM we_blueprints WHERE world_id = ? AND blueprint_id = ? AND version = ?").get(worldId, blueprintId, version) as { payload_json?: unknown } | undefined;
    const value = row ? parse<WorldBlueprint>(row.payload_json) : undefined;
    if (value) assertExpectedWorld(worldId, value.worldId, "Stored Blueprint");
    return value ? deepFreezeArtifact(value) : value;
  }

  loadContract(worldId: string, contractId: string, version: string): WorldContract | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM we_contracts WHERE world_id = ? AND contract_id = ? AND version = ?").get(worldId, contractId, version) as { payload_json?: unknown } | undefined;
    const value = row ? parse<WorldContract>(row.payload_json) : undefined;
    if (value) assertExpectedWorld(worldId, value.worldId, "Stored Contract");
    return value ? deepFreezeArtifact(value) : value;
  }

  loadInstance(worldId: string, instanceId: string): WorldInstance | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM we_instances WHERE world_id = ? AND instance_id = ?").get(worldId, instanceId) as { payload_json?: unknown } | undefined;
    const value = row ? parse<WorldInstance>(row.payload_json) : undefined;
    if (value) assertExpectedWorld(worldId, value.worldId, "Stored Instance");
    return value ? deepFreezeArtifact(value) : value;
  }

  loadInitialGraph(worldId: string, instanceId: string): { readonly nodes: readonly WorldNode[]; readonly edges: readonly WorldEdge[]; readonly facts: readonly WorldFact[] } {
    const instance = this.#database.prepare("SELECT 1 FROM we_instances WHERE world_id = ? AND instance_id = ?").get(worldId, instanceId);
    if (!instance) return { nodes: [], edges: [], facts: [] };
    const nodes = this.#database.prepare("SELECT payload_json FROM we_nodes WHERE world_id = ? AND instance_id = ? ORDER BY node_id").all(worldId, instanceId) as readonly { payload_json: unknown }[];
    const edges = this.#database.prepare("SELECT payload_json FROM we_edges WHERE world_id = ? AND instance_id = ? ORDER BY edge_id").all(worldId, instanceId) as readonly { payload_json: unknown }[];
    const facts = this.#database.prepare("SELECT payload_json FROM we_facts WHERE world_id = ? AND instance_id = ? ORDER BY fact_id").all(worldId, instanceId) as readonly { payload_json: unknown }[];
    return { nodes: nodes.map((row) => parse<WorldNode>(row.payload_json)), edges: edges.map((row) => parse<WorldEdge>(row.payload_json)), facts: facts.map((row) => parse<WorldFact>(row.payload_json)) };
  }

  loadRun(worldId: string, runId: string): WorldRunRecord | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM we_runs WHERE world_id = ? AND run_id = ?").get(worldId, runId) as { payload_json?: unknown } | undefined;
    const value = row ? parse<WorldRunRecord>(row.payload_json) : undefined;
    if (value) assertExpectedWorld(worldId, value.worldId, "Stored Run");
    return value ? deepFreezeArtifact(value) : value;
  }

  loadAutonomousRun(worldId: string, runId: string): AutonomousWorldRun | undefined {
    const row = this.#database.prepare("SELECT payload_json, payload_hash FROM we_autonomous_runs WHERE world_id = ? AND run_id = ?").get(worldId, runId) as { payload_json?: unknown; payload_hash?: unknown } | undefined;
    const value = row ? parse<AutonomousWorldRun>(row.payload_json) : undefined;
    if (value) {
      assertExpectedWorld(worldId, value.worldId, "Stored Autonomous Run");
      if (row?.payload_hash !== hash(value)) throw new Error(`Stored Autonomous Run ${runId} payload hash is invalid`);
      if (value.run.manifest.runId !== runId) throw new Error(`Stored Autonomous Run ${runId} embeds another Run`);
      if (value.generatedInputHash !== hash(value.generatedInputs)) throw new Error(`Stored Autonomous Run ${runId} generated-input hash is invalid`);
      assertAutonomousArtifactConsistency(value);
    }
    return value ? deepFreezeArtifact(value) : value;
  }

  transitionCount(worldId: string, runId: string): number {
    const row = this.#database.prepare("SELECT COUNT(*) AS count FROM we_transitions WHERE world_id = ? AND run_id = ?").get(worldId, runId) as { count: number | bigint };
    return Number(row.count);
  }

  loadProjection(worldId: string, projectionId: string): WorldProjection | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM we_projections WHERE world_id = ? AND projection_id = ?").get(worldId, projectionId) as { payload_json?: unknown } | undefined;
    const value = row ? parse<WorldProjection>(row.payload_json) : undefined;
    if (value) assertExpectedWorld(worldId, value.worldId, "Stored Projection");
    return value;
  }

  loadTransitionProposalSet(worldId: string, proposalSetId: string): TransitionProposalSet | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM we_transition_proposal_sets WHERE world_id = ? AND proposal_set_id = ?").get(worldId, proposalSetId) as { payload_json?: unknown } | undefined;
    const value = row ? parse<TransitionProposalSet>(row.payload_json) : undefined;
    if (value) assertExpectedWorld(worldId, value.worldId, "Stored Transition Proposal Set");
    return value;
  }
}
