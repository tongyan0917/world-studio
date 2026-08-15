import type {
  AuditProjection,
  CompiledWorldPackage,
  GraphProjection,
  GraphWorldAction,
  SettingBookProjection,
  TimelineProjection,
  WorldRunRecord,
} from "./types.ts";

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function immutable<T>(value: T): T {
  return freezeDeep(structuredClone(value));
}

export function projectKnowledgeGraph(run: WorldRunRecord): GraphProjection {
  return immutable({
    worldId: run.worldId,
    kind: "knowledge-graph",
    sourceRunId: run.manifest.runId,
    sourceStateHash: run.finalStateHash,
    nodes: Object.values(run.finalSnapshot.nodes).sort((a, b) => a.id.localeCompare(b.id)),
    edges: Object.values(run.finalSnapshot.edges).sort((a, b) => a.id.localeCompare(b.id)),
    facts: Object.values(run.finalSnapshot.facts).sort((a, b) => a.id.localeCompare(b.id)),
  });
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
      return [action.edge.from, action.edge.to];
    case "assert-fact":
      return [action.fact.subjectId];
  }
}

function describeAction(action: GraphWorldAction): string {
  switch (action.kind) {
    case "adjust-node-number":
      return `${action.nodeId}.${action.fieldId} ${action.delta > 0 ? "+" : ""}${action.delta}${action.unit ? ` ${action.unit}` : ""}`;
    case "set-node-attribute":
      return `${action.nodeId}.${action.fieldId} := ${JSON.stringify(action.value)}`;
    case "adjust-edge-number":
      return `${action.edgeId}.${action.fieldId} ${action.delta > 0 ? "+" : ""}${action.delta}${action.unit ? ` ${action.unit}` : ""}`;
    case "set-edge-attribute":
      return `${action.edgeId}.${action.fieldId} := ${JSON.stringify(action.value)}`;
    case "create-node":
      return `形成 ${action.node.id}（${action.node.type}）`;
    case "create-edge":
      return `形成关系 ${action.edge.from} —${action.edge.type}→ ${action.edge.to}`;
    case "assert-fact":
      return `记录 ${action.fact.subjectId} · ${action.fact.predicate} = ${JSON.stringify(action.fact.value)}`;
  }
}

export function projectTimeline(run: WorldRunRecord): TimelineProjection {
  return immutable({
    worldId: run.worldId,
    kind: "timeline",
    sourceRunId: run.manifest.runId,
    sourceStateHash: run.finalStateHash,
    entries: run.transitions.filter((transition) => {
      const actions = transition.resolvedAction as readonly GraphWorldAction[];
      return !actions.every((action) => action.kind === "assert-fact" && action.fact.predicate === "mechanism-boundary-evaluation");
    }).map((transition) => {
      const actions = transition.resolvedAction as readonly GraphWorldAction[];
      return {
        transitionId: transition.id,
        instant: transition.instant,
        subjects: [...new Set(actions.flatMap(actionSubjects))].sort(),
        summary: actions.map(describeAction).join("；"),
        causalParents: transition.causalParents,
      };
    }),
  });
}

function describeNode(node: WorldRunRecord["finalSnapshot"]["nodes"][string]): string {
  const name = typeof node.attributes.name === "string" ? node.attributes.name : node.id;
  const details = Object.entries(node.attributes)
    .filter(([key]) => key !== "name")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("；");
  return `${name}（${node.type}，${node.id}）${details ? `：${details}` : ""}`;
}

export function projectSettingBook(compiled: CompiledWorldPackage, run: WorldRunRecord): SettingBookProjection {
  if (compiled.worldId !== run.worldId) throw new Error("Cannot project a Run through another World's Contract");
  const auditPredicates = new Set(["mechanism-boundary-evaluation", "bounded-model-proposal-selected"]);
  const nodes = Object.values(run.finalSnapshot.nodes).sort((a, b) => a.id.localeCompare(b.id));
  const facts = Object.values(run.finalSnapshot.facts).filter((fact) => !auditPredicates.has(fact.predicate)).sort((a, b) => a.id.localeCompare(b.id));
  const edges = Object.values(run.finalSnapshot.edges).sort((a, b) => a.id.localeCompare(b.id));
  const byType = (types: readonly string[]) => nodes.filter((node) => types.includes(node.type));
  const auditOnlyTransitions = new Set(run.transitions.filter((transition) => {
    const actions = transition.resolvedAction as readonly GraphWorldAction[];
    return actions.length > 0 && actions.every((action) => action.kind === "assert-fact" && auditPredicates.has(action.fact.predicate));
  }).map((transition) => transition.id));
  const timeline = projectTimeline(run);
  const substantiveTimelineEntries = timeline.entries.filter((entry) => !auditOnlyTransitions.has(entry.transitionId));
  const sections: SettingBookProjection["sections"] = [
    {
      heading: "世界核心与因果边界",
      paragraphs: [compiled.blueprint.summary, ...compiled.contract.rules.map((rule) => `${rule.invariant ? "硬约束" : "可变规律"}：${rule.description}`)],
      sourceRefs: [compiled.blueprint.id, ...compiled.contract.rules.map((rule) => rule.id)],
    },
    {
      heading: "地理、环境与聚落",
      paragraphs: byType(["place", "settlement", "hazard", "spirit-vein"]).map(describeNode),
      sourceRefs: byType(["place", "settlement", "hazard", "spirit-vein"]).map((node) => node.id),
    },
    {
      heading: "资源、生产与进入权",
      paragraphs: byType(["resource-stock", "salt-pan", "spirit-vein"]).map(describeNode),
      sourceRefs: byType(["resource-stock", "salt-pan", "spirit-vein"]).map((node) => node.id),
    },
    {
      heading: "人物、欲望、信念与记忆",
      paragraphs: byType(["person", "cultivator"]).map(describeNode),
      sourceRefs: byType(["person", "cultivator"]).map((node) => node.id),
    },
    {
      heading: "世界专属体系与超凡约束",
      paragraphs: byType(["cultivation-art", "dao-oath"]).map(describeNode),
      sourceRefs: byType(["cultivation-art", "dao-oath"]).map((node) => node.id),
    },
    {
      heading: "组织、制度与实际运作",
      paragraphs: byType(["organization", "institution"]).map(describeNode),
      sourceRefs: byType(["organization", "institution"]).map((node) => node.id),
    },
    {
      heading: "关系网络",
      paragraphs: edges.map((edge) => `${edge.from} —${edge.type}→ ${edge.to}${Object.keys(edge.attributes).length ? `：${JSON.stringify(edge.attributes)}` : ""}`),
      sourceRefs: edges.map((edge) => edge.id),
    },
    {
      heading: "已确认事实与有限认知",
      paragraphs: facts.map((fact) => `${fact.subjectId} · ${fact.predicate} = ${JSON.stringify(fact.value)}［${fact.authority}；认知范围 ${JSON.stringify(fact.epistemicScope)}］`),
      sourceRefs: facts.map((fact) => fact.id),
    },
    {
      heading: "历史演变与当前可能史",
      paragraphs: substantiveTimelineEntries.length > 0
        ? substantiveTimelineEntries.map((entry) => `时间 ${entry.instant.worldTime}:${entry.instant.causalPhase}｜${entry.summary}`)
        : ["当前投影位于初始快照；尚无已提交的历史转换。"],
      sourceRefs: substantiveTimelineEntries.map((entry) => entry.transitionId),
    },
    {
      heading: "采用的机制与理论镜头",
      paragraphs: [
        ...compiled.contract.mechanismGrants.map((grant) => `${grant.id}@${grant.version}：${grant.actionKinds.join("、")}`),
        ...compiled.contract.theoryPacks.map((selection) => `${selection.id}@${selection.version}［${selection.mode}］${Object.keys(selection.parameters).length ? ` ${JSON.stringify(selection.parameters)}` : ""}`),
      ],
      sourceRefs: [
        ...compiled.contract.mechanismGrants.map((grant) => `${grant.id}@${grant.version}`),
        ...compiled.contract.theoryPacks.map((selection) => `${selection.id}@${selection.version}`),
      ],
    },
  ];
  return immutable({
    worldId: run.worldId,
    kind: "setting-book",
    sourceRunId: run.manifest.runId,
    sourceStateHash: run.finalStateHash,
    title: compiled.blueprint.title,
    summary: compiled.blueprint.summary,
    sections,
  });
}

export function projectAudit(
  compiled: CompiledWorldPackage,
  run: WorldRunRecord,
  replayStatus: AuditProjection["replayStatus"] = "unverified",
): AuditProjection {
  if (compiled.worldId !== run.worldId) throw new Error("Cannot audit a Run through another World");
  return immutable({
    worldId: run.worldId,
    kind: "audit",
    sourceRunId: run.manifest.runId,
    sourceStateHash: run.finalStateHash,
    contractHash: compiled.contract.hash,
    inputHash: run.manifest.inputHash,
    traceHash: run.traceHash,
    transitionCount: run.transitions.length,
    contributionIds: compiled.contract.includedContributionIds,
    replayStatus,
  });
}
