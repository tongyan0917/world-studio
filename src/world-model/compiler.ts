import { hash } from "../kernel/stable.ts";
import { assertCompiledWorldIsolation, validateWorldId, WorldIsolationError } from "./isolation.ts";
import { theoryPackLibrary, theoryPackRef, validateTheorySelections } from "./theory.ts";
import type {
  CompilationCandidate,
  CompilationFinding,
  CompiledWorldPackage,
  EdgeTypeDefinition,
  InitialWorldGraph,
  MechanismDefinition,
  NodeTypeDefinition,
  SemanticContribution,
  TheoryPackDefinition,
  WorldBlueprint,
  WorldBlueprintPatch,
  WorldCompilationResult,
  WorldContract,
  WorldInstance,
  WorldSnapshot,
} from "./types.ts";

export const WORLD_COMPILER_VERSION = "world-compiler.v1";

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function mergeById<T extends { readonly id: string }>(
  base: readonly T[],
  additions: readonly T[] = [],
): T[] {
  const merged = new Map(base.map((value) => [value.id, structuredClone(value)]));
  for (const value of additions) merged.set(value.id, structuredClone(value));
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function mergeTheorySelections(
  base: WorldBlueprint["theoryPacks"],
  additions: WorldBlueprintPatch["addTheoryPacks"] = [],
): WorldBlueprint["theoryPacks"] {
  const merged = new Map(base.map((value) => [theoryPackRef(value), structuredClone(value)]));
  for (const value of additions ?? []) merged.set(theoryPackRef(value), structuredClone(value));
  return [...merged.values()].sort((left, right) => theoryPackRef(left).localeCompare(theoryPackRef(right)));
}

export function applyBlueprintPatch(blueprint: WorldBlueprint, patch: WorldBlueprintPatch): WorldBlueprint {
  return {
    ...structuredClone(blueprint),
    assumptions: sortedUnique([...blueprint.assumptions, ...(patch.addAssumptions ?? [])]),
    theoryPacks: mergeTheorySelections(blueprint.theoryPacks, patch.addTheoryPacks),
    nodeTypes: mergeById(blueprint.nodeTypes, patch.addNodeTypes),
    edgeTypes: mergeById(blueprint.edgeTypes, patch.addEdgeTypes),
    rules: mergeById(blueprint.rules, patch.addRules),
    mechanisms: mergeById(blueprint.mechanisms, patch.addMechanisms),
    initialGraph: {
      nodes: mergeById(blueprint.initialGraph.nodes, patch.addNodes),
      edges: mergeById(blueprint.initialGraph.edges, patch.addEdges),
      facts: mergeById(blueprint.initialGraph.facts, patch.addFacts),
    },
    presentationHints: {
      ...(blueprint.presentationHints ?? {}),
      ...(patch.presentationHints ?? {}),
    },
  };
}

function duplicateIds(values: readonly { readonly id: string }[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value.id, (counts.get(value.id) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
}

function fieldFindings(type: NodeTypeDefinition | EdgeTypeDefinition): CompilationFinding[] {
  return duplicateIds(type.fields).map((fieldId) => ({
    code: "duplicate-field-id",
    severity: "error" as const,
    message: `Type ${type.id} declares field ${fieldId} more than once.`,
    refs: [type.id, fieldId],
  }));
}

function valueMatchesType(value: unknown, type: NodeTypeDefinition["fields"][number]): boolean {
  if (type.valueType === "json") return true;
  if (type.valueType === "reference") return typeof value === "string";
  return typeof value === type.valueType;
}

function validateInitialGraph(blueprint: WorldBlueprint, graph: InitialWorldGraph): CompilationFinding[] {
  const findings: CompilationFinding[] = [];
  const nodeTypes = new Map(blueprint.nodeTypes.map((type) => [type.id, type]));
  const edgeTypes = new Map(blueprint.edgeTypes.map((type) => [type.id, type]));
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));

  for (const id of duplicateIds(graph.nodes)) findings.push({ code: "duplicate-node-id", severity: "error", message: `Duplicate node ${id}.`, refs: [id] });
  for (const id of duplicateIds(graph.edges)) findings.push({ code: "duplicate-edge-id", severity: "error", message: `Duplicate edge ${id}.`, refs: [id] });
  for (const id of duplicateIds(graph.facts)) findings.push({ code: "duplicate-fact-id", severity: "error", message: `Duplicate fact ${id}.`, refs: [id] });

  for (const node of graph.nodes) {
    const type = nodeTypes.get(node.type);
    if (!type) {
      findings.push({ code: "unknown-node-type", severity: "error", message: `Node ${node.id} uses unknown type ${node.type}.`, refs: [node.id, node.type] });
      continue;
    }
    const fields = new Map(type.fields.map((field) => [field.id, field]));
    for (const field of type.fields.filter((candidate) => candidate.required)) {
      if (!(field.id in node.attributes)) findings.push({ code: "missing-required-field", severity: "error", message: `Node ${node.id} is missing ${field.id}.`, refs: [node.id, field.id] });
    }
    for (const [fieldId, value] of Object.entries(node.attributes)) {
      const field = fields.get(fieldId);
      if (!field) {
        findings.push({ code: "unknown-node-field", severity: "error", message: `Node ${node.id} declares unknown field ${fieldId}.`, refs: [node.id, fieldId] });
      } else if (!valueMatchesType(value, field)) {
        findings.push({ code: "invalid-node-field-type", severity: "error", message: `Node ${node.id}.${fieldId} is not ${field.valueType}.`, refs: [node.id, fieldId] });
      }
    }
  }

  for (const edge of graph.edges) {
    const type = edgeTypes.get(edge.type);
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!type) {
      findings.push({ code: "unknown-edge-type", severity: "error", message: `Edge ${edge.id} uses unknown type ${edge.type}.`, refs: [edge.id, edge.type] });
      continue;
    }
    if (!from || !to) {
      findings.push({ code: "dangling-edge", severity: "error", message: `Edge ${edge.id} has a missing endpoint.`, refs: [edge.id, edge.from, edge.to] });
      continue;
    }
    if (!type.fromTypes.includes(from.type) || !type.toTypes.includes(to.type)) {
      findings.push({ code: "invalid-edge-endpoint-type", severity: "error", message: `Edge ${edge.id} does not satisfy ${type.id} endpoint types.`, refs: [edge.id, from.type, to.type] });
    }
  }

  for (const fact of graph.facts) {
    if (!nodes.has(fact.subjectId)) findings.push({ code: "dangling-fact-subject", severity: "error", message: `Fact ${fact.id} refers to missing subject ${fact.subjectId}.`, refs: [fact.id, fact.subjectId] });
    if (fact.epistemicScope !== "world" && fact.epistemicScope.length === 0) findings.push({ code: "empty-epistemic-scope", severity: "error", message: `Fact ${fact.id} has an empty epistemic scope.`, refs: [fact.id] });
  }
  return findings;
}

export function validateBlueprint(
  blueprint: WorldBlueprint,
  mechanismLibrary: readonly MechanismDefinition[],
  theoryLibrary: readonly TheoryPackDefinition[] = theoryPackLibrary,
): CompilationFinding[] {
  const findings: CompilationFinding[] = [];
  try {
    validateWorldId(blueprint.worldId);
  } catch (error) {
    findings.push({ code: "invalid-world-id", severity: "error", message: error instanceof Error ? error.message : String(error), refs: [blueprint.worldId] });
  }
  if (!blueprint.id || !blueprint.version) findings.push({ code: "invalid-blueprint-identity", severity: "error", message: "Blueprint id and version are required.", refs: [blueprint.id, blueprint.version] });
  if (new Set(blueprint.sourceRefs).size !== blueprint.sourceRefs.length) findings.push({ code: "duplicate-source-ref", severity: "error", message: "Blueprint source references must be unique.", refs: blueprint.sourceRefs });

  const nodeTypeIds = new Set(blueprint.nodeTypes.map((type) => type.id));
  const nodeTypeById = new Map(blueprint.nodeTypes.map((type) => [type.id, type]));
  const edgeTypeIds = new Set(blueprint.edgeTypes.map((type) => type.id));
  const selectedMechanismIds = new Set(blueprint.mechanisms.map((mechanism) => mechanism.id));
  const mechanismByRef = new Map(mechanismLibrary.map((definition) => [`${definition.id}@${definition.version}`, definition]));
  const selectedTheoryRefs = new Set(blueprint.theoryPacks.filter((value) => value.mode !== "disabled").map(theoryPackRef));

  for (const [kind, values] of [["node type", blueprint.nodeTypes], ["edge type", blueprint.edgeTypes], ["rule", blueprint.rules], ["mechanism", blueprint.mechanisms]] as const) {
    for (const id of duplicateIds(values)) findings.push({ code: "duplicate-blueprint-id", severity: "error", message: `Duplicate ${kind} ${id}.`, refs: [id] });
  }
  for (const type of [...blueprint.nodeTypes, ...blueprint.edgeTypes]) findings.push(...fieldFindings(type));
  for (const edgeType of blueprint.edgeTypes) {
    for (const endpoint of [...edgeType.fromTypes, ...edgeType.toTypes]) {
      if (!nodeTypeIds.has(endpoint)) findings.push({ code: "unknown-edge-endpoint-type", severity: "error", message: `Edge type ${edgeType.id} references unknown node type ${endpoint}.`, refs: [edgeType.id, endpoint] });
    }
  }
  for (const rule of blueprint.rules) {
    for (const constraint of rule.enforcement ?? []) {
      if (constraint.kind === "numeric-range" || constraint.kind === "field-write-authority") {
        for (const nodeTypeId of constraint.nodeTypes) {
          const nodeType = nodeTypeById.get(nodeTypeId);
          if (!nodeType) {
            findings.push({ code: "unknown-rule-node-type", severity: "error", message: `Rule ${rule.id} references unknown node type ${nodeTypeId}.`, refs: [rule.id, nodeTypeId] });
            continue;
          }
          if (!nodeType.fields.some((field) => field.id === constraint.fieldId)) findings.push({ code: "unknown-rule-field", severity: "error", message: `Rule ${rule.id} references unknown field ${nodeTypeId}.${constraint.fieldId}.`, refs: [rule.id, nodeTypeId, constraint.fieldId] });
          if (constraint.kind === "numeric-range" && constraint.maximumFieldId && !nodeType.fields.some((field) => field.id === constraint.maximumFieldId)) findings.push({ code: "unknown-rule-maximum-field", severity: "error", message: `Rule ${rule.id} references unknown maximum field ${nodeTypeId}.${constraint.maximumFieldId}.`, refs: [rule.id, nodeTypeId, constraint.maximumFieldId] });
        }
        if (constraint.kind === "field-write-authority") for (const mechanismId of constraint.mechanismIds) if (!selectedMechanismIds.has(mechanismId)) findings.push({ code: "unselected-rule-mechanism", severity: "error", message: `Rule ${rule.id} grants field authority to unselected Mechanism ${mechanismId}.`, refs: [rule.id, mechanismId] });
      } else {
        if (!selectedMechanismIds.has(constraint.mechanismId)) findings.push({ code: "unselected-rule-mechanism", severity: "error", message: `Rule ${rule.id} constrains unselected Mechanism ${constraint.mechanismId}.`, refs: [rule.id, constraint.mechanismId] });
        if (!edgeTypeIds.has(constraint.edgeType)) findings.push({ code: "unknown-rule-edge-type", severity: "error", message: `Rule ${rule.id} references unknown edge type ${constraint.edgeType}.`, refs: [rule.id, constraint.edgeType] });
        for (const nodeTypeId of constraint.targetNodeTypes) if (!nodeTypeIds.has(nodeTypeId)) findings.push({ code: "unknown-rule-node-type", severity: "error", message: `Rule ${rule.id} references unknown target node type ${nodeTypeId}.`, refs: [rule.id, nodeTypeId] });
      }
    }
  }

  for (const selection of blueprint.mechanisms) {
    const ref = `${selection.id}@${selection.version}`;
    const definition = mechanismByRef.get(ref);
    if (!definition) {
      findings.push({ code: "unknown-mechanism", severity: "error", message: `Mechanism ${ref} is not available.`, refs: [ref] });
      continue;
    }
    for (const typeId of definition.requiredNodeTypes) if (!nodeTypeIds.has(typeId)) findings.push({ code: "missing-mechanism-type", severity: "error", message: `Mechanism ${ref} requires node type ${typeId}.`, refs: [ref, typeId] });
    for (const assumption of definition.requiredAssumptions) if (!blueprint.assumptions.includes(assumption)) findings.push({ code: "unsatisfied-applicability-condition", severity: "error", message: `Mechanism ${ref} requires assumption ${assumption}.`, refs: [ref, assumption] });
    for (const assumption of definition.prohibitedAssumptions ?? []) if (blueprint.assumptions.includes(assumption)) findings.push({ code: "prohibited-mechanism-assumption", severity: "error", message: `Mechanism ${ref} is incompatible with assumption ${assumption}.`, refs: [ref, assumption] });
    for (const theoryRef of definition.theoryPackRefs ?? []) if (!selectedTheoryRefs.has(theoryRef)) findings.push({ code: "missing-mechanism-theory-pack", severity: "error", message: `Mechanism ${ref} requires selected Theory Pack ${theoryRef}.`, refs: [ref, theoryRef] });
  }
  if (!blueprint.temporalModel.runtimeProfile) findings.push({ code: "temporal-model-not-executable-in-slice", severity: "warning", message: `Temporal model ${blueprint.temporalModel.id} is representable but has no installed runtime adapter.`, refs: [blueprint.temporalModel.id] });
  findings.push(...validateTheorySelections(blueprint, theoryLibrary));
  findings.push(...validateInitialGraph(blueprint, blueprint.initialGraph));
  return findings.sort((left, right) => `${left.severity}:${left.code}:${left.message}`.localeCompare(`${right.severity}:${right.code}:${right.message}`));
}

function compileCandidate(
  blueprint: WorldBlueprint,
  mechanismLibrary: readonly MechanismDefinition[],
  theoryLibrary: readonly TheoryPackDefinition[],
  acceptedContributions: readonly SemanticContribution[],
): CompilationCandidate {
  const findings = validateBlueprint(blueprint, mechanismLibrary, theoryLibrary);
  const blueprintHash = hash(blueprint);
  const id = `candidate:${blueprint.worldId}:${blueprintHash.slice(0, 16)}`;
  if (findings.some((finding) => finding.severity === "error")) return { worldId: blueprint.worldId, id, sourceContributionIds: acceptedContributions.map((value) => value.id).sort(), blueprint, findings };

  const contractCore = {
    worldId: blueprint.worldId,
    id: `contract:${blueprint.worldId}:${blueprint.id}`,
    version: `candidate.${blueprint.version}.${blueprintHash.slice(0, 12)}`,
    authority: "working-candidate" as const,
    blueprintId: blueprint.id,
    blueprintVersion: blueprint.version,
    blueprintHash,
    compilerVersion: WORLD_COMPILER_VERSION,
    temporalModel: blueprint.temporalModel,
    identityModel: blueprint.identityModel,
    causalityModel: blueprint.causalityModel,
    assumptions: sortedUnique(blueprint.assumptions),
    theoryPacks: [...blueprint.theoryPacks].sort((a, b) => theoryPackRef(a).localeCompare(theoryPackRef(b))),
    nodeTypes: [...blueprint.nodeTypes].sort((a, b) => a.id.localeCompare(b.id)),
    edgeTypes: [...blueprint.edgeTypes].sort((a, b) => a.id.localeCompare(b.id)),
    rules: [...blueprint.rules].sort((a, b) => a.id.localeCompare(b.id)),
    mechanisms: [...blueprint.mechanisms].sort((a, b) => a.id.localeCompare(b.id)),
    mechanismGrants: [...blueprint.mechanisms]
      .map((selection) => {
        const definition = mechanismLibrary.find((candidate) => candidate.id === selection.id && candidate.version === selection.version)!;
        return { id: selection.id, version: selection.version, actionKinds: [...definition.actionKinds].sort() };
      })
      .sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`)),
    includedContributionIds: acceptedContributions.map((value) => value.id).sort(),
    inferenceProvenance: [...acceptedContributions].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const contract: WorldContract = { ...contractCore, hash: hash(contractCore) };
  const initialSnapshot: WorldSnapshot = {
    worldId: blueprint.worldId,
    contractHash: contract.hash,
    revision: 0,
    instant: { worldTime: 0, causalPhase: 0 },
    nodes: Object.fromEntries(blueprint.initialGraph.nodes.map((node) => [node.id, structuredClone(node)])),
    edges: Object.fromEntries(blueprint.initialGraph.edges.map((edge) => [edge.id, structuredClone(edge)])),
    facts: Object.fromEntries(blueprint.initialGraph.facts.map((fact) => [fact.id, structuredClone(fact)])),
  };
  const initialStateHash = hash(initialSnapshot);
  const instance: WorldInstance = {
    worldId: blueprint.worldId,
    id: `instance:${blueprint.worldId}:${initialStateHash.slice(0, 12)}`,
    lineageId: `lineage:${blueprint.worldId}`,
    contractId: contract.id,
    contractVersion: contract.version,
    contractHash: contract.hash,
    contractAuthority: contract.authority,
    initialStateHash,
    initialSnapshot,
  };
  const compiledPackage: CompiledWorldPackage = { worldId: blueprint.worldId, blueprint, contract, instance, findings };
  assertCompiledWorldIsolation(compiledPackage);
  return { worldId: blueprint.worldId, id, sourceContributionIds: contract.includedContributionIds, blueprint, findings, package: compiledPackage };
}

function validateContributions(source: WorldBlueprint, contributions: readonly SemanticContribution[]): void {
  const ids = new Set<string>();
  const allowedSources = new Set(source.sourceRefs);
  for (const contribution of contributions) {
    if (contribution.worldId !== source.worldId) throw new WorldIsolationError(`Contribution ${contribution.id} belongs to ${contribution.worldId}, not ${source.worldId}`);
    if (ids.has(contribution.id)) throw new Error(`Duplicate Semantic Contribution ${contribution.id}`);
    ids.add(contribution.id);
    if (!contribution.contextPackageId || !contribution.contextPackageHash) throw new Error(`Contribution ${contribution.id} is missing its isolated context binding`);
    const foreign = contribution.sourceRefs.filter((ref) => !allowedSources.has(ref));
    if (foreign.length > 0) throw new WorldIsolationError(`Contribution ${contribution.id} cites sources outside ${source.worldId}: ${foreign.join(", ")}`);
  }
}

export function compileWorld(
  source: WorldBlueprint,
  mechanismLibrary: readonly MechanismDefinition[],
  contributions: readonly SemanticContribution[] = [],
  theoryLibrary: readonly TheoryPackDefinition[] = theoryPackLibrary,
): WorldCompilationResult {
  validateWorldId(source.worldId);
  validateContributions(source, contributions);
  const lowImpact = contributions.filter((value) => value.impact === "low").sort((left, right) => left.id.localeCompare(right.id));
  const highImpact = contributions.filter((value) => value.impact === "high").sort((left, right) => left.id.localeCompare(right.id));
  let baseBlueprint = structuredClone(source);
  for (const contribution of lowImpact) baseBlueprint = applyBlueprintPatch(baseBlueprint, contribution.patch);
  const base = compileCandidate(baseBlueprint, mechanismLibrary, theoryLibrary, lowImpact);
  const alternatives = highImpact.map((contribution) => compileCandidate(applyBlueprintPatch(baseBlueprint, contribution.patch), mechanismLibrary, theoryLibrary, [...lowImpact, contribution]));
  return { worldId: source.worldId, base, alternatives, deferredContributionIds: highImpact.map((value) => value.id).sort() };
}

/** Compilation alone never crosses the creator-authority boundary. */
export function acceptCompilationCandidate(candidate: CompilationCandidate): CompiledWorldPackage {
  if (!candidate.package) throw new Error(`Cannot accept invalid candidate ${candidate.id}`);
  const source = candidate.package;
  const { hash: _candidateHash, authority: _candidateAuthority, version: _candidateVersion, ...rest } = source.contract;
  const contractCore = { ...rest, version: `${source.blueprint.version}.${source.contract.blueprintHash.slice(0, 12)}`, authority: "accepted" as const };
  const contract: WorldContract = { ...contractCore, hash: hash(contractCore) };
  const initialSnapshot: WorldSnapshot = { ...structuredClone(source.instance.initialSnapshot), worldId: source.worldId, contractHash: contract.hash };
  const initialStateHash = hash(initialSnapshot);
  const instance: WorldInstance = {
    worldId: source.worldId,
    id: `instance:${source.worldId}:${initialStateHash.slice(0, 12)}`,
    lineageId: source.instance.lineageId,
    contractId: contract.id,
    contractVersion: contract.version,
    contractHash: contract.hash,
    contractAuthority: contract.authority,
    initialStateHash,
    initialSnapshot,
  };
  const accepted: CompiledWorldPackage = { worldId: source.worldId, blueprint: source.blueprint, contract, instance, findings: source.findings };
  assertCompiledWorldIsolation(accepted);
  return accepted;
}
