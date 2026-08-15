import { Kernel, type ProposalValidator, type StateAdapter, type ValidationIssue } from "../kernel/kernel.ts";
import { hash } from "../kernel/stable.ts";
import type { LogicalInstant, StateChange, TransitionProposal, ValidatorRef } from "../kernel/types.ts";
import { isCanonicalWorldStatePath, writePathCanProduceReadPath } from "./causal-path.ts";
import { assertCompiledWorldIsolation, assertWorldScope, WorldIsolationError } from "./isolation.ts";
import { validateSimulationSchedule } from "./simulation.ts";
import type {
  CompiledWorldPackage,
  GraphTransitionInput,
  GraphWorldAction,
  GuidanceSpecification,
  JsonValue,
  SimulationSchedule,
  WorldContract,
  WorldRunRecord,
  WorldScoped,
  WorldEdge,
  WorldFact,
  WorldNode,
  WorldSnapshot,
  CausalDimension,
} from "./types.ts";
import { CAUSAL_DIMENSIONS } from "./types.ts";

function deepFreezeArtifact<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeArtifact(child);
    Object.freeze(value);
  }
  return value;
}

export const GRAPH_CONTRACT_VALIDATOR: ValidatorRef = { id: "validator.world-graph-contract", version: "2" };
export const WORLD_ATOMIC_EFFECT_RESOLVER: ValidatorRef = { id: "resolver.world-atomic-effect-bundle", version: "1" };

export interface ResourceAdjustmentInput extends WorldScoped {
  readonly id: string;
  readonly mechanismId: string;
  readonly worldTime: number;
  readonly causalPhase?: number;
  readonly nodeId: string;
  readonly fieldId: string;
  readonly delta: number;
  readonly unit?: string;
  readonly causalParents?: readonly string[];
  readonly frameId?: string;
}

export interface RunWorldOptions {
  readonly runId?: string;
  readonly possibleHistoryId?: string;
  readonly seed?: string;
  readonly mode?: "accepted" | "trial";
  readonly schedule?: SimulationSchedule;
  readonly guidance?: readonly GuidanceSpecification[];
  readonly branchId?: string;
  readonly parentRunId?: string;
  readonly anchorInputCount?: number;
}

export interface ReplayVerification {
  readonly verified: boolean;
  readonly expectedFinalStateHash: string;
  readonly actualFinalStateHash: string;
  readonly expectedTraceHash: string;
  readonly actualTraceHash: string;
  readonly issues: readonly string[];
}

function escapePath(value: string): string {
  return encodeURIComponent(value);
}

function nodePath(nodeId: string): string {
  return `/nodes/${escapePath(nodeId)}`;
}

function nodeFieldPath(nodeId: string, fieldId: string): string {
  return `${nodePath(nodeId)}/attributes/${escapePath(fieldId)}`;
}

function edgePath(edgeId: string): string {
  return `/edges/${escapePath(edgeId)}`;
}

function edgeFieldPath(edgeId: string, fieldId: string): string {
  return `${edgePath(edgeId)}/attributes/${escapePath(fieldId)}`;
}

function factPath(factId: string): string {
  return `/facts/${escapePath(factId)}`;
}

const ABSENT_READ_VALUE = Object.freeze({ worldStudioAbsent: true });

function hashMaybeAbsent(value: unknown): string {
  return hash(value === undefined ? ABSENT_READ_VALUE : value);
}

function readPath(snapshot: WorldSnapshot, path: string): unknown {
  let match = /^\/nodes\/([^/]+)\/attributes\/([^/]+)$/.exec(path);
  if (match) {
    const value = snapshot.nodes[decodeURIComponent(match[1]!)]?.attributes[decodeURIComponent(match[2]!)];
    return value === undefined ? ABSENT_READ_VALUE : value;
  }
  match = /^\/nodes\/([^/]+)$/.exec(path);
  if (match) return snapshot.nodes[decodeURIComponent(match[1]!)] ?? ABSENT_READ_VALUE;
  match = /^\/edges\/([^/]+)$/.exec(path);
  if (match) return snapshot.edges[decodeURIComponent(match[1]!)] ?? ABSENT_READ_VALUE;
  match = /^\/edges\/([^/]+)\/attributes\/([^/]+)$/.exec(path);
  if (match) {
    const value = snapshot.edges[decodeURIComponent(match[1]!)]?.attributes[decodeURIComponent(match[2]!)];
    return value === undefined ? ABSENT_READ_VALUE : value;
  }
  match = /^\/facts\/([^/]+)$/.exec(path);
  if (match) return snapshot.facts[decodeURIComponent(match[1]!)] ?? ABSENT_READ_VALUE;
  return ABSENT_READ_VALUE;
}

function jsonTypeMatches(value: JsonValue, valueType: string): boolean {
  if (valueType === "json") return true;
  if (valueType === "reference") return typeof value === "string";
  return typeof value === valueType;
}

function snapshotAdapter(contract: WorldContract): StateAdapter<WorldSnapshot> {
  const nodeTypeById = new Map(contract.nodeTypes.map((type) => [type.id, type]));
  const edgeTypeById = new Map(contract.edgeTypes.map((type) => [type.id, type]));
  return {
    clone: (state) => structuredClone(state),
    hash: (state) => hash(state),
    read: (state, path) => readPath(state, path),
    validatePath: isCanonicalWorldStatePath,
    setKernelMeta: (state, revision, instant) => {
      (state as { revision: number }).revision = revision;
      (state as { instant: LogicalInstant }).instant = structuredClone(instant);
    },
    validateInvariants: (state) => {
      const issues: ValidationIssue[] = [];
      if (state.worldId !== contract.worldId) issues.push({ code: "world-id-drift", message: "World snapshot changed its World scope." });
      if (state.contractHash !== contract.hash) issues.push({ code: "contract-hash-drift", message: "World snapshot changed its bound Contract hash." });
      for (const [id, node] of Object.entries(state.nodes)) {
        if (node.id !== id) issues.push({ code: "node-key-drift", message: `Node key ${id} does not match node id ${node.id}.` });
        const type = nodeTypeById.get(node.type);
        if (!type) {
          issues.push({ code: "unknown-runtime-node-type", message: `Node ${id} uses unknown type ${node.type}.` });
          continue;
        }
        const fields = new Map(type.fields.map((field) => [field.id, field]));
        for (const field of type.fields) {
          const value = node.attributes[field.id];
          if (field.required && value === undefined) issues.push({ code: "missing-runtime-field", message: `Node ${id} is missing ${field.id}.` });
          if (value !== undefined && !jsonTypeMatches(value, field.valueType)) issues.push({ code: "invalid-runtime-field", message: `Node ${id}.${field.id} must be ${field.valueType}.` });
          if (field.valueType === "number" && typeof value === "number" && !Number.isFinite(value)) issues.push({ code: "invalid-runtime-number", message: `Node ${id}.${field.id} must be finite.` });
        }
        for (const fieldId of Object.keys(node.attributes)) if (!fields.has(fieldId)) issues.push({ code: "unknown-runtime-field", message: `Node ${id} has undeclared field ${fieldId}.` });
      }
      for (const [id, edge] of Object.entries(state.edges)) {
        if (edge.id !== id) issues.push({ code: "edge-key-drift", message: `Edge key ${id} does not match edge id ${edge.id}.` });
        const type = edgeTypeById.get(edge.type);
        const from = state.nodes[edge.from];
        const to = state.nodes[edge.to];
        if (!type) issues.push({ code: "unknown-runtime-edge-type", message: `Edge ${id} uses unknown type ${edge.type}.` });
        if (!from || !to) issues.push({ code: "runtime-dangling-edge", message: `Edge ${id} has a missing endpoint.` });
        if (type && from && to && (!type.fromTypes.includes(from.type) || !type.toTypes.includes(to.type))) issues.push({ code: "runtime-edge-endpoint-type", message: `Edge ${id} violates endpoint types.` });
        if (type) {
          const fields = new Map(type.fields.map((field) => [field.id, field]));
          for (const field of type.fields) {
            const value = edge.attributes[field.id];
            if (field.required && value === undefined) issues.push({ code: "missing-runtime-edge-field", message: `Edge ${id} is missing ${field.id}.` });
            if (value !== undefined && !jsonTypeMatches(value, field.valueType)) issues.push({ code: "invalid-runtime-edge-field", message: `Edge ${id}.${field.id} must be ${field.valueType}.` });
            if (field.valueType === "number" && typeof value === "number" && !Number.isFinite(value)) issues.push({ code: "invalid-runtime-edge-number", message: `Edge ${id}.${field.id} must be finite.` });
          }
          for (const fieldId of Object.keys(edge.attributes)) if (!fields.has(fieldId)) issues.push({ code: "unknown-runtime-edge-field", message: `Edge ${id} has undeclared field ${fieldId}.` });
        }
      }
      for (const [id, fact] of Object.entries(state.facts)) {
        if (fact.id !== id) issues.push({ code: "fact-key-drift", message: `Fact key ${id} does not match fact id ${fact.id}.` });
        if (!state.nodes[fact.subjectId]) issues.push({ code: "runtime-dangling-fact", message: `Fact ${id} has no subject ${fact.subjectId}.` });
      }
      return issues;
    },
    diffPaths: (before, after) => {
      const changed: string[] = [];
      const nodeIds = new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)]);
      for (const nodeId of nodeIds) {
        const beforeNode = before.nodes[nodeId];
        const afterNode = after.nodes[nodeId];
        if (!beforeNode || !afterNode) {
          changed.push(nodePath(nodeId));
          continue;
        }
        const fieldIds = new Set([...Object.keys(beforeNode.attributes), ...Object.keys(afterNode.attributes)]);
        for (const fieldId of fieldIds) if (hashMaybeAbsent(beforeNode.attributes[fieldId]) !== hashMaybeAbsent(afterNode.attributes[fieldId])) changed.push(nodeFieldPath(nodeId, fieldId));
      }
      for (const edgeId of new Set([...Object.keys(before.edges), ...Object.keys(after.edges)])) {
        const beforeEdge = before.edges[edgeId];
        const afterEdge = after.edges[edgeId];
        if (!beforeEdge || !afterEdge) {
          changed.push(edgePath(edgeId));
          continue;
        }
        const fieldIds = new Set([...Object.keys(beforeEdge.attributes), ...Object.keys(afterEdge.attributes)]);
        for (const fieldId of fieldIds) if (hashMaybeAbsent(beforeEdge.attributes[fieldId]) !== hashMaybeAbsent(afterEdge.attributes[fieldId])) changed.push(edgeFieldPath(edgeId, fieldId));
      }
      for (const factId of new Set([...Object.keys(before.facts), ...Object.keys(after.facts)])) if (hashMaybeAbsent(before.facts[factId]) !== hashMaybeAbsent(after.facts[factId])) changed.push(factPath(factId));
      return changed.sort();
    },
  };
}

function actionPath(action: GraphWorldAction): string {
  switch (action.kind) {
    case "adjust-node-number":
    case "set-node-attribute":
      return nodeFieldPath(action.nodeId, action.fieldId);
    case "adjust-edge-number":
    case "set-edge-attribute":
      return edgeFieldPath(action.edgeId, action.fieldId);
    case "create-node":
      return nodePath(action.node.id);
    case "create-edge":
      return edgePath(action.edge.id);
    case "assert-fact":
      return factPath(action.fact.id);
  }
}

function actionSubjects(action: GraphWorldAction): string[] {
  switch (action.kind) {
    case "adjust-node-number":
    case "set-node-attribute":
      return [action.nodeId];
    case "adjust-edge-number":
    case "set-edge-attribute":
      return [action.edgeId];
    case "create-node":
      return [action.node.id];
    case "create-edge":
      return [action.edge.id, action.edge.from, action.edge.to];
    case "assert-fact":
      return [action.fact.id, action.fact.subjectId];
  }
}

function actionReadPaths(action: GraphWorldAction): string[] {
  switch (action.kind) {
    case "adjust-node-number":
    case "set-node-attribute":
      return [nodeFieldPath(action.nodeId, action.fieldId)];
    case "adjust-edge-number":
    case "set-edge-attribute":
      return [edgeFieldPath(action.edgeId, action.fieldId)];
    case "create-node":
      return [nodePath(action.node.id)];
    case "create-edge":
      return [edgePath(action.edge.id), nodePath(action.edge.from), nodePath(action.edge.to)];
    case "assert-fact":
      return [factPath(action.fact.id), nodePath(action.fact.subjectId)];
  }
}

function graphValidator(contract: WorldContract): ProposalValidator<WorldSnapshot> {
  const grantByRef = new Map(contract.mechanismGrants.map((grant) => [`${grant.id}@${grant.version}`, grant]));
  const nodeTypeById = new Map(contract.nodeTypes.map((type) => [type.id, type]));
  const edgeTypeById = new Map(contract.edgeTypes.map((type) => [type.id, type]));
  const validateNode = (node: Extract<GraphWorldAction, { kind: "create-node" }>["node"]): ValidationIssue[] => {
    const issues: ValidationIssue[] = [];
    const type = nodeTypeById.get(node.type);
    if (!type) return [{ code: "unknown-action-node-type", message: `Unknown node type ${node.type}.` }];
    for (const field of type.fields) {
      const value = node.attributes[field.id];
      if (field.required && value === undefined) issues.push({ code: "missing-action-node-field", message: `Node ${node.id} is missing ${field.id}.` });
      if (value !== undefined && !jsonTypeMatches(value, field.valueType)) issues.push({ code: "invalid-action-node-field", message: `Node ${node.id}.${field.id} must be ${field.valueType}.` });
    }
    for (const fieldId of Object.keys(node.attributes)) if (!type.fields.some((field) => field.id === fieldId)) issues.push({ code: "unknown-action-node-field", message: `Node ${node.id} has unknown field ${fieldId}.` });
    return issues;
  };
  return {
    ...GRAPH_CONTRACT_VALIDATOR,
    validate: (proposal, state) => {
      const issues: ValidationIssue[] = [];
      const action = proposal.action as GraphWorldAction;
      const grant = grantByRef.get(`${proposal.source}@${proposal.version}`);
      if (!grant) issues.push({ code: "mechanism-not-selected-by-contract", message: `${proposal.source}@${proposal.version} is not selected.` });
      if (grant && !grant.actionKinds.includes(action.kind)) issues.push({ code: "action-outside-mechanism-grant", message: `${proposal.source}@${proposal.version} cannot ${action.kind}.` });
      switch (action.kind) {
        case "adjust-node-number": {
          const node = state.nodes[action.nodeId];
          const field = nodeTypeById.get(node?.type ?? "")?.fields.find((candidate) => candidate.id === action.fieldId);
          if (!node) issues.push({ code: "unknown-action-node", message: `Unknown node ${action.nodeId}.` });
          if (!field) issues.push({ code: "unknown-action-field", message: `Unknown field ${action.fieldId}.` });
          if (field && field.valueType !== "number") issues.push({ code: "non-numeric-action-field", message: `${action.nodeId}.${action.fieldId} is not numeric.` });
          if (field?.unit && action.unit !== field.unit) issues.push({ code: "action-unit-mismatch", message: `${action.nodeId}.${action.fieldId} requires unit ${field.unit}.` });
          if (!Number.isFinite(action.delta) || action.delta === 0) issues.push({ code: "invalid-adjustment", message: "Numeric adjustment must be finite and non-zero." });
          break;
        }
        case "set-node-attribute": {
          const node = state.nodes[action.nodeId];
          const field = nodeTypeById.get(node?.type ?? "")?.fields.find((candidate) => candidate.id === action.fieldId);
          if (!node) issues.push({ code: "unknown-action-node", message: `Unknown node ${action.nodeId}.` });
          if (!field) issues.push({ code: "unknown-action-field", message: `Unknown field ${action.fieldId}.` });
          if (field && !jsonTypeMatches(action.value, field.valueType)) issues.push({ code: "invalid-action-value", message: `${action.nodeId}.${action.fieldId} requires ${field.valueType}.` });
          break;
        }
        case "adjust-edge-number": {
          const edge = state.edges[action.edgeId];
          const field = edgeTypeById.get(edge?.type ?? "")?.fields.find((candidate) => candidate.id === action.fieldId);
          if (!edge) issues.push({ code: "unknown-action-edge", message: `Unknown edge ${action.edgeId}.` });
          if (!field) issues.push({ code: "unknown-action-edge-field", message: `Unknown edge field ${action.fieldId}.` });
          if (field && field.valueType !== "number") issues.push({ code: "non-numeric-action-edge-field", message: `${action.edgeId}.${action.fieldId} is not numeric.` });
          if (field?.unit && action.unit !== field.unit) issues.push({ code: "action-edge-unit-mismatch", message: `${action.edgeId}.${action.fieldId} requires unit ${field.unit}.` });
          if (!Number.isFinite(action.delta) || action.delta === 0) issues.push({ code: "invalid-edge-adjustment", message: "Numeric edge adjustment must be finite and non-zero." });
          break;
        }
        case "set-edge-attribute": {
          const edge = state.edges[action.edgeId];
          const field = edgeTypeById.get(edge?.type ?? "")?.fields.find((candidate) => candidate.id === action.fieldId);
          if (!edge) issues.push({ code: "unknown-action-edge", message: `Unknown edge ${action.edgeId}.` });
          if (!field) issues.push({ code: "unknown-action-edge-field", message: `Unknown edge field ${action.fieldId}.` });
          if (field && !jsonTypeMatches(action.value, field.valueType)) issues.push({ code: "invalid-action-edge-value", message: `${action.edgeId}.${action.fieldId} requires ${field.valueType}.` });
          break;
        }
        case "create-node":
          if (state.nodes[action.node.id]) issues.push({ code: "node-already-exists", message: `Node ${action.node.id} already exists.` });
          issues.push(...validateNode(action.node));
          break;
        case "create-edge": {
          const edge = action.edge;
          const type = edgeTypeById.get(edge.type);
          const from = state.nodes[edge.from];
          const to = state.nodes[edge.to];
          if (state.edges[edge.id]) issues.push({ code: "edge-already-exists", message: `Edge ${edge.id} already exists.` });
          if (!type) issues.push({ code: "unknown-action-edge-type", message: `Unknown edge type ${edge.type}.` });
          if (!from || !to) issues.push({ code: "action-dangling-edge", message: `Edge ${edge.id} has a missing endpoint.` });
          if (type && from && to && (!type.fromTypes.includes(from.type) || !type.toTypes.includes(to.type))) issues.push({ code: "action-edge-endpoint-type", message: `Edge ${edge.id} violates endpoint types.` });
          if (type) {
            for (const field of type.fields) {
              const value = edge.attributes[field.id];
              if (field.required && value === undefined) issues.push({ code: "missing-action-edge-field", message: `Edge ${edge.id} is missing ${field.id}.` });
              if (value !== undefined && !jsonTypeMatches(value, field.valueType)) issues.push({ code: "invalid-action-edge-field", message: `Edge ${edge.id}.${field.id} must be ${field.valueType}.` });
            }
            for (const fieldId of Object.keys(edge.attributes)) if (!type.fields.some((field) => field.id === fieldId)) issues.push({ code: "unknown-action-edge-field", message: `Edge ${edge.id} has unknown field ${fieldId}.` });
          }
          break;
        }
        case "assert-fact": {
          const existing = state.facts[action.fact.id];
          if (!state.nodes[action.fact.subjectId]) issues.push({ code: "action-dangling-fact", message: `Fact ${action.fact.id} has no subject.` });
          if (existing && hash(existing) !== hash(action.fact)) issues.push({ code: "fact-id-conflict", message: `Fact ${action.fact.id} already has different content.` });
          if (action.fact.authority !== "world-transition") issues.push({ code: "invalid-transition-fact-authority", message: "Runtime asserted facts must have world-transition authority." });
          break;
        }
      }
      const nodeWrite = action.kind === "adjust-node-number" || action.kind === "set-node-attribute"
        ? { nodeId: action.nodeId, fieldId: action.fieldId, value: action.kind === "adjust-node-number" ? (typeof state.nodes[action.nodeId]?.attributes[action.fieldId] === "number" ? Number(state.nodes[action.nodeId]!.attributes[action.fieldId]) + action.delta : undefined) : action.value }
        : undefined;
      for (const rule of contract.rules.filter((candidate) => candidate.invariant)) {
        for (const constraint of rule.enforcement ?? []) {
          if (constraint.kind === "numeric-range") {
            if (!nodeWrite || nodeWrite.fieldId !== constraint.fieldId) continue;
            const node = state.nodes[nodeWrite.nodeId];
            if (!node || !constraint.nodeTypes.includes(node.type) || typeof nodeWrite.value !== "number") continue;
            const maximum = constraint.maximumFieldId && typeof node.attributes[constraint.maximumFieldId] === "number" ? Number(node.attributes[constraint.maximumFieldId]) : constraint.maximum;
            if (constraint.minimum !== undefined && nodeWrite.value < constraint.minimum) issues.push({ code: "world-rule-violation", message: `${rule.id} forbids ${nodeWrite.nodeId}.${nodeWrite.fieldId} below ${constraint.minimum}.` });
            if (maximum !== undefined && nodeWrite.value > maximum) issues.push({ code: "world-rule-violation", message: `${rule.id} forbids ${nodeWrite.nodeId}.${nodeWrite.fieldId} above ${maximum}.` });
          } else if (constraint.kind === "field-write-authority") {
            if (!nodeWrite || nodeWrite.fieldId !== constraint.fieldId) continue;
            const node = state.nodes[nodeWrite.nodeId];
            if (node && constraint.nodeTypes.includes(node.type) && !constraint.mechanismIds.includes(proposal.source)) issues.push({ code: "world-rule-violation", message: `${rule.id} does not authorize ${proposal.source} to write ${node.type}.${nodeWrite.fieldId}.` });
          } else if (proposal.source === constraint.mechanismId && nodeWrite) {
            const node = state.nodes[nodeWrite.nodeId];
            if (!node || !constraint.targetNodeTypes.includes(node.type)) continue;
            const reachable = Object.values(state.edges).some((edge) => edge.type === constraint.edgeType && (
              constraint.direction === "from-target" ? edge.from === node.id
                : constraint.direction === "to-target" ? edge.to === node.id
                  : edge.from === node.id || edge.to === node.id
            ));
            if (!reachable) issues.push({ code: "world-rule-violation", message: `${rule.id} requires ${constraint.edgeType} (${constraint.direction}) before ${proposal.source} may affect ${node.id}.` });
          }
        }
      }
      return issues;
    },
  };
}

function applyAction(action: GraphWorldAction, draft: WorldSnapshot): StateChange[] {
  const nodes = draft.nodes as Record<string, WorldNode>;
  const edges = draft.edges as Record<string, WorldEdge>;
  const facts = draft.facts as Record<string, WorldFact>;
  switch (action.kind) {
    case "adjust-node-number": {
      const node = nodes[action.nodeId]!;
      const current = node.attributes[action.fieldId];
      if (typeof current !== "number") throw new Error(`${action.nodeId}.${action.fieldId} is not numeric`);
      const next = Math.round((current + action.delta) * 1_000_000_000) / 1_000_000_000;
      nodes[action.nodeId] = { ...node, attributes: { ...node.attributes, [action.fieldId]: next } };
      return [{ operation: "increment", path: actionPath(action), value: action.delta }];
    }
    case "set-node-attribute": {
      const node = nodes[action.nodeId]!;
      nodes[action.nodeId] = { ...node, attributes: { ...node.attributes, [action.fieldId]: structuredClone(action.value) } };
      return [{ operation: "set", path: actionPath(action), value: action.value }];
    }
    case "adjust-edge-number": {
      const edge = edges[action.edgeId]!;
      const current = edge.attributes[action.fieldId];
      if (typeof current !== "number") throw new Error(`${action.edgeId}.${action.fieldId} is not numeric`);
      const next = Math.round((current + action.delta) * 1_000_000_000) / 1_000_000_000;
      edges[action.edgeId] = { ...edge, attributes: { ...edge.attributes, [action.fieldId]: next } };
      return [{ operation: "increment", path: actionPath(action), value: action.delta }];
    }
    case "set-edge-attribute": {
      const edge = edges[action.edgeId]!;
      edges[action.edgeId] = { ...edge, attributes: { ...edge.attributes, [action.fieldId]: structuredClone(action.value) } };
      return [{ operation: "set", path: actionPath(action), value: action.value }];
    }
    case "create-node":
      nodes[action.node.id] = structuredClone(action.node);
      return [{ operation: "set", path: actionPath(action), value: action.node }];
    case "create-edge":
      edges[action.edge.id] = structuredClone(action.edge);
      return [{ operation: "set", path: actionPath(action), value: action.edge }];
    case "assert-fact":
      facts[action.fact.id] = structuredClone(action.fact);
      return [{ operation: "set", path: actionPath(action), value: action.fact }];
  }
}

function registerContractRuntime(kernel: Kernel<WorldSnapshot>, contract: WorldContract): Kernel<WorldSnapshot> {
  kernel.registerValidator(graphValidator(contract));
  kernel.registerResolver({
    ...WORLD_ATOMIC_EFFECT_RESOLVER,
    resolve: (proposals) => {
      const sources = new Set(proposals.map((proposal) => `${proposal.source}@${proposal.version}`));
      const writePaths = proposals.flatMap((proposal) => proposal.effectScope.paths);
      const overlappingWrites = writePaths.some((path, index) => writePaths.slice(index + 1).some((other) =>
        writePathCanProduceReadPath(path, other) || writePathCanProduceReadPath(other, path),
      ));
      if (sources.size !== 1 || overlappingWrites) {
        return {
          acceptedProposalIds: [],
          rejected: Object.fromEntries(proposals.map((proposal) => [proposal.id, "invalid-atomic-effect-bundle"])),
          randomDraws: [],
          summary: "invalid-world-atomic-effect-bundle",
        };
      }
      return {
        acceptedProposalIds: proposals.map((proposal) => proposal.id),
        rejected: {},
        randomDraws: [],
        summary: "same-mechanism-atomic-effect-bundle",
      };
    },
  });
  for (const grant of contract.mechanismGrants) {
    kernel.registerMechanism({
      id: grant.id,
      version: grant.version,
      capabilities: grant.actionKinds,
      actionKinds: grant.actionKinds,
      requiredValidators: [GRAPH_CONTRACT_VALIDATOR],
      requireCausalPathDimensions: true,
      allowedCausalDimensions: CAUSAL_DIMENSIONS,
      footprint: (proposal) => [actionPath(proposal.action as GraphWorldAction)],
      apply: (proposal, draft) => applyAction(proposal.action as GraphWorldAction, draft).map((change) => ({
        ...change,
        causalDimensions: proposal.causalPathDimensions?.writes.find((binding) => binding.path === change.path)?.dimensions ?? [],
      })),
    });
  }
  return kernel;
}

function normalizeInput(input: GraphTransitionInput | ResourceAdjustmentInput): GraphTransitionInput {
  if ("action" in input) return structuredClone(input);
  return {
    worldId: input.worldId,
    id: input.id,
    mechanismId: input.mechanismId,
    worldTime: input.worldTime,
    ...(input.causalPhase === undefined ? {} : { causalPhase: input.causalPhase }),
    action: { kind: "adjust-node-number", nodeId: input.nodeId, fieldId: input.fieldId, delta: input.delta, ...(input.unit ? { unit: input.unit } : {}) },
    ...(input.causalParents ? { causalParents: input.causalParents } : {}),
    ...(input.frameId ? { frameId: input.frameId } : {}),
  };
}

function makeProposal(kernel: Kernel<WorldSnapshot>, contract: WorldContract, input: GraphTransitionInput): TransitionProposal<GraphWorldAction> {
  const mechanism = contract.mechanisms.find((candidate) => candidate.id === input.mechanismId);
  if (!mechanism) throw new Error(`Contract does not select mechanism ${input.mechanismId}`);
  const grant = contract.mechanismGrants.find((candidate) => candidate.id === mechanism.id && candidate.version === mechanism.version);
  if (!grant?.actionKinds.includes(input.action.kind)) throw new Error(`Mechanism ${input.mechanismId} cannot ${input.action.kind}`);
  const readPaths = [...new Set([...actionReadPaths(input.action), ...(input.causalReadPaths ?? [])])].sort();
  const readSet = readPaths.map((path) => kernel.read(path));
  const causalParents = [...new Set([...(input.causalParents ?? []), ...readSet.flatMap((read) => read.producerTraceId ? [read.producerTraceId] : [])])].sort();
  const subjects = [...new Set(actionSubjects(input.action))].sort();
  const resourceClaims = input.action.kind === "adjust-node-number" ? [{ resourceType: input.action.fieldId, resourceId: input.action.nodeId, mode: input.action.delta > 0 ? "produce" as const : "consume" as const, quantity: Math.abs(input.action.delta), unit: input.action.unit ?? "unit" }] : [];
  const readDimensions = [...new Set<CausalDimension>(input.readDimensions ?? input.writeDimensions ?? ["world-specific"])].sort();
  const writeDimensions = [...new Set<CausalDimension>(input.writeDimensions ?? input.readDimensions ?? ["world-specific"])].sort();
  const writePath = actionPath(input.action);
  return {
    id: input.id,
    source: mechanism.id,
    version: mechanism.version,
    authority: { kind: "mechanism", principalId: mechanism.id, capability: input.action.kind },
    subjects,
    instant: { worldTime: input.worldTime, causalPhase: input.causalPhase ?? 0 },
    causalParents,
    readSet,
    causalPathDimensions: {
      reads: readPaths.map((path) => ({ path, dimensions: readDimensions })),
      writes: [{ path: writePath, dimensions: writeDimensions }],
    },
    preconditions: [],
    effectScope: { paths: [writePath], entityIds: subjects },
    resourceClaims,
    permissionClaims: [{ capability: input.action.kind, subjectId: mechanism.id, objectId: subjects[0]! }],
    validators: [GRAPH_CONTRACT_VALIDATOR],
    resolution: WORLD_ATOMIC_EFFECT_RESOLVER,
    action: structuredClone(input.action),
  };
}

function validateRunScope(
  compiled: CompiledWorldPackage,
  inputs: readonly GraphTransitionInput[],
  options: RunWorldOptions,
): void {
  assertCompiledWorldIsolation(compiled);
  assertWorldScope(compiled.worldId, [
    ...inputs.map((value) => ({ label: `Run input ${value.id}`, value })),
    ...(options.schedule ? [{ label: "Simulation schedule", value: options.schedule }] : []),
    ...(options.guidance ?? []).map((value) => ({ label: `Guidance ${value.id}`, value })),
  ]);
  if (options.schedule) {
    if (options.schedule.contractHash !== compiled.contract.hash) throw new WorldIsolationError("Simulation schedule is bound to a different Contract");
    const findings = validateSimulationSchedule(options.schedule);
    if (findings.length > 0) throw new Error(findings.join("; "));
    const frameById = new Map(options.schedule.frames.map((frame) => [frame.id, frame]));
    for (const input of inputs) {
      if (!input.frameId) continue;
      const frame = frameById.get(input.frameId);
      if (!frame) throw new Error(`Run input ${input.id} references unknown Simulation Frame ${input.frameId}`);
      if (input.worldTime < frame.startWorldTime || input.worldTime > frame.endWorldTime) throw new Error(`Run input ${input.id} falls outside Simulation Frame ${frame.id}`);
    }
  } else if (inputs.some((input) => input.frameId)) {
    throw new Error("Run inputs reference Simulation Frames but no schedule was supplied");
  }
}

export function runWorld(
  compiled: CompiledWorldPackage,
  inputValues: readonly (GraphTransitionInput | ResourceAdjustmentInput)[],
  options: RunWorldOptions = {},
): WorldRunRecord {
  const session = new WorldRuntimeSession(compiled, options);
  session.commit(inputValues);
  return session.finish();
}

/** Incremental Kernel session used by autonomous Mechanisms; finish() remains exactly replayable by runWorld(). */
export class WorldRuntimeSession {
  readonly #compiled: CompiledWorldPackage;
  readonly #options: RunWorldOptions;
  readonly #initialSnapshot: WorldSnapshot;
  readonly #kernel: Kernel<WorldSnapshot>;
  readonly #inputs: GraphTransitionInput[] = [];
  #finished = false;

  constructor(compiled: CompiledWorldPackage, options: RunWorldOptions = {}) {
    this.#compiled = compiled;
    this.#options = options;
    if (compiled.contract.authority !== "accepted" && options.mode !== "trial") throw new Error(`Contract ${compiled.contract.id}@${compiled.contract.version} is not accepted; use an explicit trial Run.`);
    if (compiled.contract.temporalModel.runtimeProfile !== "linear-discrete-v1") throw new Error(`Runtime cannot execute temporal model ${compiled.contract.temporalModel.id}`);
    validateRunScope(compiled, [], options);
    this.#initialSnapshot = structuredClone(compiled.instance.initialSnapshot);
    this.#kernel = registerContractRuntime(new Kernel(structuredClone(this.#initialSnapshot), snapshotAdapter(compiled.contract)), compiled.contract);
  }

  snapshot(): WorldSnapshot {
    return this.#kernel.state();
  }

  stateHash(): string {
    return hash(this.#kernel.state());
  }

  inputs(): readonly GraphTransitionInput[] {
    return structuredClone(this.#inputs);
  }

  commit(inputValues: readonly (GraphTransitionInput | ResourceAdjustmentInput)[]): void {
    if (this.#finished) throw new Error("World Runtime Session is already finished");
    if (inputValues.length === 0) return;
    const inputs = inputValues.map(normalizeInput).sort((left, right) => left.worldTime - right.worldTime || (left.causalPhase ?? 0) - (right.causalPhase ?? 0) || left.id.localeCompare(right.id));
    validateRunScope(this.#compiled, inputs, this.#options);
    const prior = this.#inputs.at(-1);
    if (prior) {
      const first = inputs[0]!;
      if (first.worldTime < prior.worldTime || (first.worldTime === prior.worldTime && (first.causalPhase ?? 0) <= (prior.causalPhase ?? 0))) {
        throw new Error(`Incremental input ${first.id} does not advance beyond the last committed causal phase`);
      }
    }
    for (let index = 0; index < inputs.length;) {
      const first = inputs[index]!;
      const phaseInputs: GraphTransitionInput[] = [];
      while (index < inputs.length && inputs[index]!.worldTime === first.worldTime && (inputs[index]!.causalPhase ?? 0) === (first.causalPhase ?? 0)) phaseInputs.push(inputs[index++]!);
      const instant = { worldTime: first.worldTime, causalPhase: first.causalPhase ?? 0 };
      const proposals = phaseInputs.map((input) => makeProposal(this.#kernel, this.#compiled.contract, input));
      const result = this.#kernel.commitPhase(instant, proposals);
      for (const input of phaseInputs) {
        const disposition = result.dispositions.find((candidate) => candidate.proposalId === input.id);
        if (disposition?.kind !== "accepted") throw new Error(`Input ${input.id} was ${disposition?.kind ?? "missing"}: ${disposition?.reasonCode ?? "no disposition"}`);
      }
      this.#inputs.push(...phaseInputs);
    }
  }

  finish(): WorldRunRecord {
    this.#finished = true;
    const compiled = this.#compiled;
    const options = this.#options;
    const inputs = structuredClone(this.#inputs);
    const finalSnapshot = this.#kernel.state();
    const transitions = this.#kernel.transitions() as WorldRunRecord["transitions"];
    const trace = this.#kernel.trace();
    const seed = options.seed ?? "world-run-seed-v1";
    const inputHash = hash(inputs);
    const guidanceIds = [...(options.guidance ?? []).map((value) => value.id)].sort();
    const runId = options.runId ?? `run:${compiled.worldId}:${hash({
      seed,
      inputHash,
      guidanceIds,
      ...(options.schedule ? { scheduleHash: options.schedule.scheduleHash } : {}),
      ...(options.branchId ? { branchId: options.branchId } : {}),
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
      ...(options.anchorInputCount === undefined ? {} : { anchorInputCount: options.anchorInputCount }),
    }).slice(0, 16)}`;
    const record: WorldRunRecord = {
      worldId: compiled.worldId,
      manifest: {
        worldId: compiled.worldId,
        runId,
        possibleHistoryId: options.possibleHistoryId ?? `history:${compiled.worldId}:${hash({ runId, seed }).slice(0, 12)}`,
        lineageId: compiled.instance.lineageId,
        instanceId: compiled.instance.id,
        contractId: compiled.contract.id,
        contractVersion: compiled.contract.version,
        contractHash: compiled.contract.hash,
        initialStateHash: compiled.instance.initialStateHash,
        mechanismVersions: Object.fromEntries(compiled.contract.mechanisms.map((value) => [value.id, value.version])),
        seed,
        inputHash,
        ...(options.schedule ? { scheduleHash: options.schedule.scheduleHash } : {}),
        guidanceIds,
        ...(options.branchId ? { branchId: options.branchId } : {}),
        ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
        ...(options.anchorInputCount === undefined ? {} : { anchorInputCount: options.anchorInputCount }),
      },
      status: "complete",
      inputs,
      initialSnapshot: structuredClone(this.#initialSnapshot),
      finalSnapshot,
      transitions,
      trace,
      finalStateHash: hash(finalSnapshot),
      traceHash: hash(trace),
    };
    assertWorldScope(compiled.worldId, [{ label: "Run", value: record }, { label: "Run manifest", value: record.manifest }, { label: "Run final snapshot", value: record.finalSnapshot }]);
    return deepFreezeArtifact(record);
  }
}

export function verifyWorldReplay(
  compiled: CompiledWorldPackage,
  run: WorldRunRecord,
  schedule?: SimulationSchedule,
  guidance: readonly GuidanceSpecification[] = [],
): ReplayVerification {
  const issues: string[] = [];
  if (run.worldId !== compiled.worldId) throw new WorldIsolationError(`Run ${run.manifest.runId} belongs to ${run.worldId}`);
  if (run.manifest.contractHash !== compiled.contract.hash) issues.push("contract-hash-mismatch");
  if (run.manifest.inputHash !== hash(run.inputs)) issues.push("input-hash-mismatch");
  if (hash(run.manifest.guidanceIds) !== hash([...guidance.map((value) => value.id)].sort())) issues.push("guidance-id-mismatch");
  let replay: WorldRunRecord;
  try {
    replay = runWorld(compiled, run.inputs, {
      runId: run.manifest.runId,
      possibleHistoryId: run.manifest.possibleHistoryId,
      seed: run.manifest.seed,
      ...(schedule ? { schedule } : {}),
      guidance,
      ...(run.manifest.branchId ? { branchId: run.manifest.branchId } : {}),
      ...(run.manifest.parentRunId ? { parentRunId: run.manifest.parentRunId } : {}),
      ...(run.manifest.anchorInputCount === undefined ? {} : { anchorInputCount: run.manifest.anchorInputCount }),
    });
  } catch (error) {
    issues.push(`replay-failed:${error instanceof Error ? error.message : String(error)}`);
    return { verified: false, expectedFinalStateHash: run.finalStateHash, actualFinalStateHash: "", expectedTraceHash: run.traceHash, actualTraceHash: "", issues };
  }
  if (replay.finalStateHash !== run.finalStateHash) issues.push("final-state-hash-mismatch");
  if (replay.traceHash !== run.traceHash) issues.push("trace-hash-mismatch");
  return { verified: issues.length === 0, expectedFinalStateHash: run.finalStateHash, actualFinalStateHash: replay.finalStateHash, expectedTraceHash: run.traceHash, actualTraceHash: replay.traceHash, issues };
}
