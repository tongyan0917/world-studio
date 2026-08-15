import { hash } from "../kernel/stable.ts";
import { applyBlueprintPatch, compileWorld } from "./compiler.ts";
import { assertRunIsolation, assertWorldScope, WorldIsolationError } from "./isolation.ts";
import { runWorld, verifyWorldReplay, type RunWorldOptions } from "./runtime.ts";
import { theoryPackLibrary } from "./theory.ts";
import type {
  CompilationCandidate,
  CompiledWorldPackage,
  ContractChangeSet,
  GraphTransitionInput,
  GuidanceSpecification,
  MechanismDefinition,
  SimulationSchedule,
  TheoryPackDefinition,
  WorldBlueprintPatch,
  WorldBranch,
  WorldRunRecord,
} from "./types.ts";

export interface AnchoredBranchOptions {
  readonly id?: string;
  readonly reason: string;
  readonly anchorInputCount: number;
  readonly schedule?: SimulationSchedule;
  readonly guidance?: readonly GuidanceSpecification[];
  readonly seed?: string;
}

function instantKey(input: GraphTransitionInput): readonly [number, number] {
  return [input.worldTime, input.causalPhase ?? 0];
}

function instantStrictlyAfter(left: GraphTransitionInput, right: GraphTransitionInput): boolean {
  const [leftTime, leftPhase] = instantKey(left);
  const [rightTime, rightPhase] = instantKey(right);
  return leftTime > rightTime || (leftTime === rightTime && leftPhase > rightPhase);
}

export function createAnchoredBranch(
  compiled: CompiledWorldPackage,
  parent: WorldRunRecord,
  replacementSuffix: readonly GraphTransitionInput[],
  options: AnchoredBranchOptions,
): { readonly branch: WorldBranch; readonly run: WorldRunRecord } {
  assertRunIsolation(compiled, parent);
  assertWorldScope(compiled.worldId, replacementSuffix.map((value) => ({ label: `Branch input ${value.id}`, value })));
  if (!Number.isSafeInteger(options.anchorInputCount) || options.anchorInputCount < 0 || options.anchorInputCount > parent.inputs.length) throw new RangeError("anchorInputCount is outside the parent input range");
  const replay = verifyWorldReplay(compiled, parent, options.schedule, options.guidance ?? []);
  if (!replay.verified) throw new Error(`Cannot branch from an unverified parent Run: ${replay.issues.join(", ")}`);
  const prefix = parent.inputs.slice(0, options.anchorInputCount);
  const lastPrefix = prefix.at(-1);
  const firstReplacement = [...replacementSuffix].sort((a, b) => a.worldTime - b.worldTime || (a.causalPhase ?? 0) - (b.causalPhase ?? 0) || a.id.localeCompare(b.id))[0];
  if (lastPrefix && firstReplacement && !instantStrictlyAfter(firstReplacement, lastPrefix)) throw new Error("Branch replacement inputs must occur strictly after the retained prefix");

  const prefixRun = runWorld(compiled, prefix, {
    runId: `run:${compiled.worldId}:anchor-check:${hash({ parent: parent.manifest.runId, count: options.anchorInputCount }).slice(0, 12)}`,
    seed: parent.manifest.seed,
    ...(options.schedule ? { schedule: options.schedule } : {}),
    guidance: options.guidance ?? [],
  });
  const inputDeltaHash = hash(replacementSuffix);
  const branchId = options.id ?? `branch:${compiled.worldId}:${hash({ parent: parent.manifest.runId, anchor: options.anchorInputCount, inputDeltaHash, reason: options.reason }).slice(0, 16)}`;
  const runId = `run:${compiled.worldId}:${hash({ branchId, prefix: hash(prefix), inputDeltaHash }).slice(0, 16)}`;
  const runOptions: RunWorldOptions = {
    runId,
    possibleHistoryId: `history:${compiled.worldId}:${hash(branchId).slice(0, 12)}`,
    seed: options.seed ?? parent.manifest.seed,
    ...(options.schedule ? { schedule: options.schedule } : {}),
    guidance: options.guidance ?? [],
    branchId,
    parentRunId: parent.manifest.runId,
    anchorInputCount: options.anchorInputCount,
  };
  const run = runWorld(compiled, [...prefix, ...replacementSuffix], runOptions);
  const branch: WorldBranch = {
    worldId: compiled.worldId,
    id: branchId,
    lineageId: parent.manifest.lineageId,
    parentRunId: parent.manifest.runId,
    anchorInputCount: options.anchorInputCount,
    anchorStateHash: prefixRun.finalStateHash,
    inputDeltaHash,
    reason: options.reason,
    runId,
  };
  return { branch, run };
}

export function createContractChangeSet(
  compiled: CompiledWorldPackage,
  kind: ContractChangeSet["kind"],
  patch: WorldBlueprintPatch,
  rationale: string,
  earliestCausalImpactInput?: number,
): ContractChangeSet {
  return {
    worldId: compiled.worldId,
    id: `change:${compiled.worldId}:${hash({ from: compiled.contract.hash, kind, patch, rationale }).slice(0, 16)}`,
    fromContractHash: compiled.contract.hash,
    kind,
    patch: structuredClone(patch),
    rationale,
    ...(earliestCausalImpactInput === undefined ? {} : { earliestCausalImpactInput }),
    status: "proposed",
  };
}

export function acceptContractChangeSet(changeSet: ContractChangeSet): ContractChangeSet {
  return { ...structuredClone(changeSet), status: "accepted" };
}

/**
 * Ontology or law changes always compile a new Contract candidate. A mutable
 * in-world law state should instead be modelled as ordinary graph state under
 * a predeclared meta-mechanism.
 */
export function compileAcceptedContractChange(
  compiled: CompiledWorldPackage,
  changeSet: ContractChangeSet,
  mechanismLibrary: readonly MechanismDefinition[],
  theoryLibrary: readonly TheoryPackDefinition[] = theoryPackLibrary,
): CompilationCandidate {
  if (changeSet.worldId !== compiled.worldId) throw new WorldIsolationError(`Change Set ${changeSet.id} belongs to another World`);
  if (changeSet.fromContractHash !== compiled.contract.hash) throw new Error("Change Set targets a different Contract version");
  if (changeSet.status !== "accepted") throw new Error("Contract Change Set must be explicitly accepted before compilation");
  const patched = applyBlueprintPatch(compiled.blueprint, changeSet.patch);
  const blueprint = {
    ...patched,
    version: `${compiled.blueprint.version}+${changeSet.kind}.${hash(changeSet).slice(0, 10)}`,
  };
  return compileWorld(blueprint, mechanismLibrary, [], theoryLibrary).base;
}
