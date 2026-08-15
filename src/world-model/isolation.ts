import { hash } from "../kernel/stable.ts";
import type {
  CompiledWorldPackage,
  SemanticContribution,
  TheoryPackDefinition,
  WorldBlueprint,
  WorldContextPackage,
  WorldId,
  WorldRunRecord,
  WorldScoped,
  WorldSourceRecord,
} from "./types.ts";

export class WorldIsolationError extends Error {
  readonly code = "world-isolation-violation";

  constructor(message: string) {
    super(message);
    this.name = "WorldIsolationError";
  }
}

export function validateWorldId(worldId: string): WorldId {
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(worldId)) {
    throw new WorldIsolationError(`Invalid worldId ${JSON.stringify(worldId)}`);
  }
  return worldId;
}

export function assertWorldScope(
  expectedWorldId: WorldId,
  artifacts: readonly { readonly label: string; readonly value: WorldScoped }[],
): void {
  validateWorldId(expectedWorldId);
  for (const artifact of artifacts) {
    if (artifact.value.worldId !== expectedWorldId) {
      throw new WorldIsolationError(
        `${artifact.label} belongs to ${artifact.value.worldId}, not ${expectedWorldId}`,
      );
    }
  }
}

export function assertCompiledWorldIsolation(compiled: CompiledWorldPackage): void {
  assertWorldScope(compiled.worldId, [
    { label: "Blueprint", value: compiled.blueprint },
    { label: "Contract", value: compiled.contract },
    { label: "Instance", value: compiled.instance },
    { label: "Initial snapshot", value: compiled.instance.initialSnapshot },
    ...compiled.contract.inferenceProvenance.map((value) => ({
      label: `Semantic contribution ${value.id}`,
      value,
    })),
  ]);
  if (compiled.contract.blueprintId !== compiled.blueprint.id) {
    throw new WorldIsolationError("Contract Blueprint identity does not match compiled Blueprint");
  }
  if (compiled.instance.contractHash !== compiled.contract.hash) {
    throw new WorldIsolationError("Instance is not bound to the compiled Contract hash");
  }
  if (compiled.instance.initialSnapshot.contractHash !== compiled.contract.hash) {
    throw new WorldIsolationError("Initial snapshot is not bound to the compiled Contract hash");
  }
}

export function assertRunIsolation(compiled: CompiledWorldPackage, run: WorldRunRecord): void {
  assertCompiledWorldIsolation(compiled);
  assertWorldScope(compiled.worldId, [
    { label: "Run", value: run },
    { label: "Run manifest", value: run.manifest },
    { label: "Run initial snapshot", value: run.initialSnapshot },
    { label: "Run final snapshot", value: run.finalSnapshot },
    ...run.inputs.map((value) => ({ label: `Run input ${value.id}`, value })),
  ]);
  if (run.manifest.instanceId !== compiled.instance.id) {
    throw new WorldIsolationError("Run Instance does not match the compiled World");
  }
  if (run.manifest.contractHash !== compiled.contract.hash) {
    throw new WorldIsolationError("Run Contract does not match the compiled World");
  }
}

function selectedTheoryPacks(
  blueprint: WorldBlueprint,
  library: readonly TheoryPackDefinition[],
): TheoryPackDefinition[] {
  const byRef = new Map(library.map((pack) => [`${pack.id}@${pack.version}`, pack]));
  return blueprint.theoryPacks
    .filter((selection) => selection.mode !== "disabled")
    .map((selection) => {
      const ref = `${selection.id}@${selection.version}`;
      const pack = byRef.get(ref);
      if (!pack) throw new Error(`Unknown Theory Pack ${ref}`);
      return structuredClone(pack);
    })
    .sort((left, right) => `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`));
}

export interface ContextPackageOptions {
  readonly contractHash?: string;
  readonly instanceId?: string;
  readonly runId?: string;
}

/**
 * Materialize exactly one World's semantic context. The payload deliberately
 * contains no global registry, neighbouring workspace, other Blueprint, or
 * previous model transcript.
 */
export function buildWorldContextPackage(
  blueprint: WorldBlueprint,
  sources: readonly WorldSourceRecord[],
  theoryLibrary: readonly TheoryPackDefinition[],
  options: ContextPackageOptions = {},
): WorldContextPackage {
  validateWorldId(blueprint.worldId);
  assertWorldScope(
    blueprint.worldId,
    sources.map((value) => ({ label: `Source ${value.id}`, value })),
  );
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const missing = blueprint.sourceRefs.filter((ref) => !sourceById.has(ref));
  if (missing.length > 0) {
    throw new WorldIsolationError(`Blueprint references unavailable World sources: ${missing.join(", ")}`);
  }
  const selectedSources = blueprint.sourceRefs
    .map((ref) => structuredClone(sourceById.get(ref)!))
    .sort((left, right) => left.id.localeCompare(right.id));
  const theoryPacks = selectedTheoryPacks(blueprint, theoryLibrary);
  const payload = {
    schemaVersion: "world-context.v1",
    worldId: blueprint.worldId,
    blueprint: structuredClone(blueprint),
    sources: selectedSources,
    theoryPacks,
    authorityReminder: {
      semanticOutputIsProposalOnly: true,
      highImpactRequiresAlternative: true,
      creatorFactsMayNotBeInvented: true,
    },
  } as const;
  const payloadHash = hash(payload);
  return {
    worldId: blueprint.worldId,
    id: `context:${blueprint.worldId}:${payloadHash.slice(0, 20)}`,
    blueprintId: blueprint.id,
    blueprintVersion: blueprint.version,
    blueprintHash: hash(blueprint),
    ...(options.contractHash ? { contractHash: options.contractHash } : {}),
    ...(options.instanceId ? { instanceId: options.instanceId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    sourceRefs: selectedSources.map((source) => source.id),
    theoryPackRefs: theoryPacks.map((pack) => `${pack.id}@${pack.version}`),
    payload,
    payloadHash,
  };
}

export function assertSemanticContributionIsolation(
  context: WorldContextPackage,
  contribution: SemanticContribution,
): void {
  assertWorldScope(context.worldId, [
    { label: "Semantic context", value: context },
    { label: `Semantic contribution ${contribution.id}`, value: contribution },
  ]);
  if (contribution.contextPackageId !== context.id || contribution.contextPackageHash !== context.payloadHash) {
    throw new WorldIsolationError(`Contribution ${contribution.id} is bound to a different semantic context`);
  }
  const allowedSources = new Set(context.sourceRefs);
  const foreignRefs = contribution.sourceRefs.filter((ref) => !allowedSources.has(ref));
  if (foreignRefs.length > 0) {
    throw new WorldIsolationError(
      `Contribution ${contribution.id} cites sources outside ${context.worldId}: ${foreignRefs.join(", ")}`,
    );
  }
}
