import { hash } from "../kernel/stable.ts";
import { genericWorldEdgeTypes, genericWorldNodeTypes } from "../world-model/examples.ts";
import type {
  EdgeTypeDefinition,
  JsonValue,
  MechanismSelection,
  NodeTypeDefinition,
  WorldBlueprint,
  WorldEdge,
  WorldFact,
  WorldNode,
  WorldSourceRecord,
} from "../world-model/types.ts";
import type {
  CreatorInformationDefinition,
  CreatorWorldDefinition,
  CreatorWorldDraft,
  CreatorWorldInspection,
  CreatorWorldIssue,
  CreatorWorldQuestion,
} from "./types.ts";

export type {
  CreatorWorldDefinition,
  CreatorWorldDraft,
  CreatorWorldInspection,
  CreatorWorldIssue,
  CreatorWorldQuestion,
} from "./types.ts";

export interface CompiledCreatorDefinition {
  readonly blueprint: WorldBlueprint;
  readonly sources: readonly WorldSourceRecord[];
}

function question(
  worldId: string,
  code: string,
  section: string,
  prompt: string,
  whyConsequential: string,
  blockedCapabilities: readonly string[],
  suggestedAnswers: readonly string[],
): CreatorWorldQuestion {
  return {
    id: `question:${worldId || "unscoped"}:${code}`,
    code,
    section,
    prompt,
    whyConsequential,
    blockedCapabilities: [...blockedCapabilities].sort(),
    suggestedAnswers,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function values(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function localIdValid(value: unknown): boolean {
  return nonEmpty(value) && /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}

function duplicateIds(items: readonly unknown[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) if (isRecord(item) && nonEmpty(item.id)) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([id]) => id).sort();
}

export function inspectCreatorWorldDefinition(definition: CreatorWorldDefinition): CreatorWorldInspection {
  const root = definition as unknown as Record<string, unknown>;
  const worldId = nonEmpty(root.worldId) ? root.worldId : "";
  const questions: CreatorWorldQuestion[] = [];
  const issues: CreatorWorldIssue[] = [];
  const ask = (...args: Parameters<typeof question> extends [string, ...infer Rest] ? Rest : never) => questions.push(question(worldId, ...args));
  const issue = (code: string, path: string, message: string) => issues.push({ code, path, message });

  if (root.schemaVersion !== 1) issue("unsupported-definition-version", "/schemaVersion", "Creator World definition schemaVersion must be 1.");
  if (!/^world\.[a-z0-9][a-z0-9._-]*$/i.test(worldId)) issue("invalid-world-id", "/worldId", "World id must begin with world. and contain only stable identifier characters.");
  if (!localIdValid(root.draftId)) issue("invalid-draft-id", "/draftId", "Draft id must be a non-empty stable identifier.");
  if (!nonEmpty(root.version)) issue("missing-version", "/version", "Definition version is required.");

  const metadata = isRecord(root.metadata) ? root.metadata : undefined;
  if (!metadata || !nonEmpty(metadata.title) || !nonEmpty(metadata.summary)) ask(
    "world-metadata-missing", "metadata", "What is this World called, and what is its causal premise?",
    "The immutable Contract and creator workspace need a stable identity and scope.", ["compile", "workspace", "export"], ["Provide a title and a one-paragraph summary."],
  );
  const temporal = isRecord(root.temporal) ? root.temporal : undefined;
  if (!temporal || !nonEmpty(temporal.calendarName) || !finite(temporal.startYear) || !nonEmpty(temporal.coordinateDescription)) ask(
    "temporal-profile-missing", "temporal", "Which calendar and starting coordinate does this World use?",
    "Schedules, causal ordering, branch anchors, and replay cannot share a stable coordinate without this premise.", ["compile", "evolve", "branch", "timeline"], ["Use a linear calendar and numeric start year.", "Define another adapter before accepting a non-linear runtime."],
  );

  const geography = isRecord(root.geography) ? root.geography : undefined;
  const places = values(geography?.places);
  const routes = values(geography?.routes);
  if (places.length === 0) ask("places-missing", "geography.places", "What places make up the initial geography?", "Movement, exposure, resources, and jurisdiction need explicit spatial anchors.", ["compile", "map", "evolve"], ["Add at least one place with stress, capacity, accessibility, and coordinates."]);
  if (places.length > 1 && routes.length === 0) ask("routes-missing", "geography.routes", "How can people and resources move between these places?", "Cross-place movement and exchange must follow declared routes rather than narrative convenience.", ["evolve", "map", "economy"], ["Add a route with capacity, reliability, travel time, and maintenance."]);

  const populations = isRecord(root.populations) ? root.populations : undefined;
  if (values(populations?.settlements).length === 0 || values(populations?.groups).length === 0) ask("population-profile-missing", "populations", "Which settlements and ordinary population groups exist initially?", "Population, households, migration, exposure, and organization formation cannot emerge from characters alone.", ["compile", "population", "hazards", "formation"], ["Add at least one settlement and one population group."]);
  if (values(root.characters).length === 0) ask("focal-characters-missing", "characters", "Whose bounded perspectives should the World initially follow?", "Actor psychology, information limits, relationships, and focused micro evolution require actual subjects.", ["actors", "information", "micro-evolution"], ["Add one or more focal characters with place, motives, beliefs, stress, and agency."]);
  if (values(root.organizations).length === 0) ask("organizations-missing", "organizations", "Which organizations coordinate action and resources?", "Economy, politics, implementation, and conflict require organized actors distinct from individuals.", ["organizations", "economy", "conflict"], ["Add at least one organization with declared goal, actual practice, capacity, and coalitions."]);
  if (values(root.institutions).length === 0) ask("institutions-missing", "institutions", "Which formal rule and rule-in-use govern the initial World?", "Authority and adaptation need explicit institutions and enforcement capacity.", ["institutions", "politics", "authority"], ["Add an institution with formal rule, practice, and enforcement capacity."]);
  if (values(root.resources).length === 0) ask("resources-missing", "resources", "Which quantified resources constrain the World?", "Economy and conservation cannot run without declared stocks, flows, capacity, demand, and access.", ["resources", "economy", "conservation"], ["Add a resource stock with quantity, capacity, renewal, demand, and access regime."]);
  for (const [index, resource] of values(root.resources).entries()) {
    if (!isRecord(resource)) continue;
    if (!finite(resource.capacity) || resource.capacity <= 0) ask("resource-capacity-missing", `resources.${index}.capacity`, `What is the finite capacity of resource ${String(resource.name ?? resource.id ?? index)}?`, "Conservation and scarcity diverge materially when capacity is unknown.", ["compile", "resource-balance", "conservation"], ["Enter a positive capacity in the same unit as quantity."]);
    if (!finite(resource.renewalRate) || !finite(resource.baselineDemand)) ask("resource-flow-missing", `resources.${index}`, `What renews and consumes resource ${String(resource.name ?? resource.id ?? index)}?`, "A stock without declared flows cannot evolve honestly.", ["resource-balance", "economy"], ["Enter annual renewal and baseline demand, including zero when intentional."]);
  }
  if (values(root.relationships).length === 0) ask("relationships-missing", "relationships", "Which memberships, trust links, governance claims, or exchanges initially connect these objects?", "Organizations and people cannot influence one another without typed relationship paths.", ["relationships", "economy", "politics", "conflict"], ["Add at least one typed directional relationship."]);
  if (values(root.information).length === 0) ask("information-missing", "information", "What consequential fact is known, by whom, and with what uncertainty?", "Bounded cognition and information diffusion require perspective-scoped evidence.", ["information", "belief", "actors"], ["Add a fact with subject, predicate, value, epistemic scope, and optional uncertainty."]);
  if (values(root.hazards).length === 0) ask("hazards-missing", "hazards", "Which hazards can occur, and which objects are exposed?", "Extreme events must derive from frequency, triggers, exposure, and vulnerability rather than authored spectacle.", ["hazards", "events", "risk"], ["Add a hazard with frequency, trigger, severity basis, and at least one exposure."]);
  for (const [index, hazard] of values(root.hazards).entries()) if (isRecord(hazard) && (!finite(hazard.baselineFrequencyPerCentury) || values(hazard.exposures).length === 0)) ask("hazard-causality-missing", `hazards.${index}`, `What frequency and exposure paths govern hazard ${String(hazard.name ?? hazard.id ?? index)}?`, "Without both, the engine would either invent occurrence rates or broadcast damage without causal reachability.", ["hazard-impact", "events"], ["Enter a non-negative rate and target-specific vulnerabilities."]);
  if (values(root.theoryPacks).length === 0) ask("theory-packs-missing", "theoryPacks", "Which conditional Theory Packs may inform proposals?", "Actor, organization, institution, economy, history, and ecology proposals need explicit applicability rather than hidden universal assumptions.", ["compile", "hybrid-evolution"], ["Select installed packs and their modes/parameters."]);
  if (values(root.hardRules).length === 0) ask("hard-rules-missing", "hardRules", "Which invariants must every proposal obey?", "The Kernel needs creator-accepted limits for conservation, authority, and World law.", ["compile", "commit-authority"], ["Add numeric bounds and/or field authority rules."]);
  if (!isRecord(root.parameters)) ask("world-parameters-missing", "parameters", "How sensitive is this World to environment, routes, hazards, and organizational adaptation?", "Supported World parameters change the same executable mechanisms without custom source code.", ["evolve", "replay"], ["Set all four supported multipliers and optional custom metadata."]);
  if (isRecord(root.parameters) && !values(root.premises).includes("world.creator-parameters-causal")) ask("world-parameter-premise-missing", "premises", "Should the supported creator parameters participate in causal evolution?", "The parameter node cannot influence committed state unless the creator accepts it as a causal premise.", ["compile", "world-specific-evolution"], ["Add world.creator-parameters-causal to premises."]);
  if (!isRecord(root.initialState) || !Array.isArray(root.initialState.facts)) ask("initial-state-missing", "initialState", "Which initial facts are accepted as World state?", "A Contract can define laws, but an Instance also needs explicit initial epistemic state.", ["compile", "instance", "explain"], ["Provide an initial facts array; it may be empty when intentional."]);

  const collections: readonly [string, readonly unknown[]][] = [
    ["geography.places", places], ["geography.routes", routes], ["populations.settlements", values(populations?.settlements)],
    ["populations.groups", values(populations?.groups)], ["characters", values(root.characters)], ["organizations", values(root.organizations)],
    ["institutions", values(root.institutions)], ["resources", values(root.resources)], ["relationships", values(root.relationships)],
    ["information", values(root.information)], ["hazards", values(root.hazards)], ["hardRules", values(root.hardRules)],
  ];
  for (const [path, collection] of collections) {
    for (const id of duplicateIds(collection)) issue("duplicate-authoring-id", `/${path}`, `Duplicate id ${id}.`);
    collection.forEach((item, index) => {
      if (!isRecord(item) || !localIdValid(item.id)) issue("invalid-authoring-id", `/${path}/${index}/id`, "Entity ids must be stable local identifiers.");
    });
  }

  const allNumbers: readonly [string, unknown, number, number][] = [
    ["parameters.environmentalVolatility", isRecord(root.parameters) ? root.parameters.environmentalVolatility : undefined, 0, 2],
    ["parameters.routeSensitivity", isRecord(root.parameters) ? root.parameters.routeSensitivity : undefined, 0, 2],
    ["parameters.hazardFrequencyMultiplier", isRecord(root.parameters) ? root.parameters.hazardFrequencyMultiplier : undefined, 0, 2],
    ["parameters.organizationAdaptationRate", isRecord(root.parameters) ? root.parameters.organizationAdaptationRate : undefined, 0, 2],
  ];
  for (const [path, value, minimum, maximum] of allNumbers) if (isRecord(root.parameters) && (!finite(value) || value < minimum || value > maximum)) issue("invalid-world-parameter", `/${path.replaceAll(".", "/")}`, `${path} must be between ${minimum} and ${maximum}.`);

  questions.sort((left, right) => left.code.localeCompare(right.code) || left.section.localeCompare(right.section));
  issues.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
  return { ready: questions.length === 0 && issues.length === 0, questions, issues };
}

function prefixed(prefix: string, id: string): string {
  return id.includes(":") ? id : `${prefix}:${id}`;
}

function placeId(id: string): string { return prefixed("place", id); }
function factId(id: string): string { return prefixed("fact", id); }

function locationEdge(id: string, from: string, to: string): WorldEdge {
  return { id: `edge:location:${id}`, type: "located-in", from, to, attributes: {} };
}

function creatorFact(value: CreatorInformationDefinition, sourceId: string): WorldFact {
  return {
    id: factId(value.id),
    subjectId: value.subjectId,
    predicate: value.predicate,
    value: structuredClone(value.value),
    authority: "creator-confirmed",
    provenance: [sourceId],
    epistemicScope: value.scope === "world" ? "world" : [...value.scope],
    ...(value.uncertainty ? { uncertainty: value.uncertainty } : {}),
  };
}

function mechanismSelections(definition: CreatorWorldDefinition): MechanismSelection[] {
  const parameters = definition.parameters;
  return [
    { id: "mechanism.resource-balance", version: "1", parameters: { conservation: "capacity-and-declared-renewal" } },
    { id: "mechanism.world-evolution", version: "1", parameters: { custom: parameters.custom ?? {} } },
    { id: "mechanism.environment-cycle", version: "1", parameters: { volatility: parameters.environmentalVolatility } },
    { id: "mechanism.route-dynamics", version: "1", parameters: { sensitivity: parameters.routeSensitivity } },
    { id: "mechanism.population-dynamics", version: "1", parameters: { conservePopulationTransfers: true } },
    { id: "mechanism.exchange-network", version: "1", parameters: { routeAndScarcityBound: true } },
    { id: "mechanism.actor-deliberation", version: "1", parameters: { proposer: "bounded-model-or-deterministic-fallback" } },
    { id: "mechanism.organization-adaptation", version: "1", parameters: { adaptationRate: parameters.organizationAdaptationRate } },
    { id: "mechanism.institution-adaptation", version: "1", parameters: { rulesInUse: true } },
    { id: "mechanism.information-diffusion", version: "1", parameters: { perspectiveBounded: true } },
    { id: "mechanism.relationship-dynamics", version: "1", parameters: { directional: true } },
    { id: "mechanism.conflict-dynamics", version: "1", parameters: { eventDriven: true } },
    { id: "mechanism.hazard-impact", version: "1", parameters: { frequencyMultiplier: parameters.hazardFrequencyMultiplier } },
    { id: "mechanism.creator-world-laws", version: "1", parameters: structuredClone(parameters) },
  ];
}

export function compileCreatorWorldDefinition(definition: CreatorWorldDefinition): CompiledCreatorDefinition {
  const inspection = inspectCreatorWorldDefinition(definition);
  if (inspection.questions.length > 0) throw new Error(`Creator questions must be resolved before compilation: ${inspection.questions.map((value) => value.code).join(", ")}`);
  if (inspection.issues.length > 0) throw new Error(`Creator definition is invalid: ${inspection.issues.map((value) => `${value.path}:${value.code}`).join(", ")}`);

  const sourceContent = JSON.stringify(definition, null, 2);
  const sourceId = `source:creator-definition:${hash(definition).slice(0, 16)}`;
  const source: WorldSourceRecord = {
    worldId: definition.worldId,
    id: sourceId,
    revision: definition.version,
    kind: "structured-data",
    title: `${definition.metadata.title} creator definition`,
    content: sourceContent,
    contentHash: hash(sourceContent),
    provenance: [`creator-draft:${definition.draftId}`],
  };

  const nodes: WorldNode[] = [];
  const edges: WorldEdge[] = [];
  for (const place of definition.geography.places) nodes.push({
    id: placeId(place.id), type: "place", attributes: {
      name: place.name, ...(place.terrain ? { terrain: place.terrain } : {}), ...(place.climate ? { climate: place.climate } : {}),
      "environmental-stress": place.environmentalStress, "carrying-capacity": place.carryingCapacity, accessibility: place.accessibility,
      ...(place.coordinates ? { "map-x": place.coordinates.x, "map-y": place.coordinates.y } : {}),
      ...(place.image?.path ? { "image-path": place.image.path, "image-caption": place.image.caption } : {}),
    },
  });
  for (const route of definition.geography.routes) nodes.push({
    id: prefixed("route", route.id), type: "route", attributes: {
      name: route.name, origin: placeId(route.originPlaceId), destination: placeId(route.destinationPlaceId), capacity: route.capacity,
      reliability: route.reliability, "travel-time": route.travelTimeDays, maintenance: route.maintenance, status: route.status,
    },
  });
  for (const settlement of definition.populations.settlements) {
    const id = prefixed("settlement", settlement.id);
    nodes.push({ id, type: "settlement", attributes: {
      name: settlement.name, population: settlement.population, "founded-year": settlement.foundedYear, role: settlement.role,
      ...(settlement.infrastructureState ? { "infrastructure-state": settlement.infrastructureState } : {}),
      ...(settlement.foodSecurity === undefined ? {} : { "food-security": settlement.foodSecurity }),
      ...(settlement.migrationPressure === undefined ? {} : { "migration-pressure": settlement.migrationPressure }),
    } });
    edges.push(locationEdge(`settlement:${settlement.id}`, id, placeId(settlement.placeId)));
  }
  for (const population of definition.populations.groups) {
    const id = prefixed("population", population.id);
    nodes.push({ id, type: "population-group", attributes: {
      name: population.name, population: population.population, livelihood: population.livelihood, "current-place": placeId(population.placeId),
      mobility: population.mobility, cohesion: population.cohesion, "settlement-readiness": population.settlementReadiness,
      ...(population.settlementName ? { "settlement-name": population.settlementName } : {}),
    } });
    edges.push(locationEdge(`population:${population.id}`, id, placeId(population.placeId)));
  }
  for (const character of definition.characters) {
    const id = prefixed("person", character.id);
    nodes.push({ id, type: "person", attributes: {
      name: character.name, ...(character.age === undefined ? {} : { age: character.age }), ...(character.traits === undefined ? {} : { traits: structuredClone(character.traits) }),
      focal: character.focal ?? false,
      wants: [...(character.wants ?? [])], fears: [...(character.fears ?? [])], needs: [...(character.needs ?? [])], beliefs: [...(character.beliefs ?? [])],
      ...(character.narrative ? { narrative: character.narrative } : {}), memories: [...(character.memories ?? [])],
      ...(character.stress === undefined ? {} : { stress: character.stress }), ...(character.agency === undefined ? {} : { agency: character.agency }),
      ...(character.currentPlan ? { "current-plan": character.currentPlan } : {}),
    } });
    edges.push(locationEdge(`person:${character.id}`, id, placeId(character.placeId)));
  }
  for (const organization of definition.organizations) {
    const id = prefixed("organization", organization.id);
    nodes.push({ id, type: "organization", attributes: {
      name: organization.name, "declared-goal": organization.declaredGoal, "actual-practice": organization.actualPractice,
      ...(organization.resources === undefined ? {} : { resources: structuredClone(organization.resources) }),
      ...(organization.culture === undefined ? {} : { culture: structuredClone(organization.culture) }),
      ...(organization.coalitions === undefined ? {} : { "internal-coalitions": structuredClone(organization.coalitions) }),
      ...(organization.legitimacy === undefined ? {} : { legitimacy: organization.legitimacy }), ...(organization.cohesion === undefined ? {} : { cohesion: organization.cohesion }),
      ...(organization.capacity === undefined ? {} : { capacity: organization.capacity }), ...(organization.status ? { status: organization.status } : {}),
    } });
    edges.push(locationEdge(`organization:${organization.id}`, id, placeId(organization.placeId)));
  }
  for (const institution of definition.institutions) {
    const id = prefixed("institution", institution.id);
    nodes.push({ id, type: "institution", attributes: {
      name: institution.name, "formal-rule": institution.formalRule, "rule-in-use": institution.ruleInUse,
      ...(institution.enforcementCapacity === undefined ? {} : { "enforcement-capacity": institution.enforcementCapacity }),
    } });
    edges.push(locationEdge(`institution:${institution.id}`, id, placeId(institution.placeId)));
  }
  for (const resource of definition.resources) {
    const id = prefixed("resource", resource.id);
    nodes.push({ id, type: "resource-stock", attributes: {
      name: resource.name, quantity: resource.quantity, capacity: resource.capacity, "renewal-rate": resource.renewalRate,
      "baseline-demand": resource.baselineDemand, "access-regime": resource.accessRegime,
      scarcity: Math.round((1 - resource.quantity / resource.capacity) * 1_000_000) / 1_000_000,
      ...(resource.priceIndex === undefined ? {} : { "price-index": resource.priceIndex }),
    } });
    edges.push(locationEdge(`resource:${resource.id}`, id, placeId(resource.placeId)));
  }
  for (const hazard of definition.hazards) {
    const id = prefixed("hazard", hazard.id);
    nodes.push({ id, type: "hazard", attributes: {
      name: hazard.name, kind: hazard.kind, "baseline-frequency": hazard.baselineFrequencyPerCentury,
      "trigger-condition": hazard.triggerCondition, "severity-basis": hazard.severityBasis,
    } });
    edges.push(locationEdge(`hazard:${hazard.id}`, id, placeId(hazard.placeId)));
    for (const [index, exposure] of hazard.exposures.entries()) edges.push({
      id: `edge:exposure:${hazard.id}:${index}`, type: "exposed-to", from: exposure.targetId, to: id, attributes: { vulnerability: exposure.vulnerability },
    });
  }
  nodes.push({
    id: "parameters:world",
    type: "world-parameters",
    attributes: {
      name: `${definition.metadata.title} causal parameters`,
      "environmental-volatility": definition.parameters.environmentalVolatility,
      "route-sensitivity": definition.parameters.routeSensitivity,
      "hazard-frequency-multiplier": definition.parameters.hazardFrequencyMultiplier,
      "organization-adaptation-rate": definition.parameters.organizationAdaptationRate,
      custom: structuredClone(definition.parameters.custom ?? {}),
      "last-applied-boundary": "initial",
      "world-signal": {},
    },
  });
  for (const relationship of definition.relationships) {
    if (relationship.kind === "membership") edges.push({ id: prefixed("edge", relationship.id), type: "member-of", from: relationship.fromId, to: relationship.toId, attributes: { role: relationship.role } });
    else if (relationship.kind === "social") edges.push({ id: prefixed("edge", relationship.id), type: "related-to", from: relationship.fromId, to: relationship.toId, attributes: { relation: relationship.relation, ...(relationship.trust === undefined ? {} : { trust: relationship.trust }) } });
    else if (relationship.kind === "governance") edges.push({ id: prefixed("edge", relationship.id), type: "governs", from: relationship.fromId, to: relationship.toId, attributes: { basis: relationship.basis } });
    else edges.push({ id: prefixed("edge", relationship.id), type: "trades-with", from: relationship.fromId, to: relationship.toId, attributes: { capacity: relationship.capacity, reliability: relationship.reliability, "price-spread": relationship.priceSpread } });
  }

  const extensionNodeTypes = definition.extensions?.nodeTypes ?? [];
  const extensionEdgeTypes = definition.extensions?.edgeTypes ?? [];
  nodes.push(...structuredClone(definition.extensions?.nodes ?? []));
  edges.push(...structuredClone(definition.extensions?.edges ?? []));
  const facts = [
    ...definition.information.map((value) => creatorFact(value, sourceId)),
    ...definition.initialState.facts.map((value) => creatorFact(value, sourceId)),
    ...structuredClone(definition.extensions?.facts ?? []),
  ];
  const nodeTypes: NodeTypeDefinition[] = [...structuredClone(genericWorldNodeTypes), {
    id: "world-parameters",
    description: "Creator-authored supported parameters materialized as causal World state.",
    worldSpecific: true,
    fields: [
      { id: "name", valueType: "string", required: true, causal: false },
      { id: "environmental-volatility", valueType: "number", required: true, causal: true, unit: "ratio" },
      { id: "route-sensitivity", valueType: "number", required: true, causal: true, unit: "ratio" },
      { id: "hazard-frequency-multiplier", valueType: "number", required: true, causal: true, unit: "ratio" },
      { id: "organization-adaptation-rate", valueType: "number", required: true, causal: true, unit: "ratio" },
      { id: "custom", valueType: "json", required: true, causal: true },
      { id: "last-applied-boundary", valueType: "string", required: true, causal: true },
      { id: "world-signal", valueType: "json", required: true, causal: true },
    ],
  }, ...structuredClone(extensionNodeTypes)];
  const edgeTypes: EdgeTypeDefinition[] = [...structuredClone(genericWorldEdgeTypes), ...structuredClone(extensionEdgeTypes)];
  const images = Object.fromEntries(definition.geography.places.filter((place) => place.image?.path).map((place) => [placeId(place.id), place.image!])) as Readonly<Record<string, JsonValue>>;
  const blueprint: WorldBlueprint = {
    worldId: definition.worldId,
    id: "blueprint.main",
    version: definition.version,
    title: definition.metadata.title,
    summary: definition.metadata.summary,
    sourceRefs: [sourceId],
    temporalModel: { id: `time.${definition.worldId.slice("world.".length)}`, version: "1", kind: "linear", coordinateDescription: definition.temporal.coordinateDescription, runtimeProfile: "linear-discrete-v1" },
    identityModel: { id: "identity.creator-generic", version: "1", principles: ["people remain perspective-bound subjects", "organizations persist only through recorded succession", "labels do not create identity continuity"] },
    causalityModel: { id: "causality.forward-local", version: "1", principles: ["effects require prior reachable causes", "information stays perspective-scoped", "hazards require exposure", "only Kernel commits state"] },
    assumptions: [...new Set(definition.premises)].sort(),
    theoryPacks: [...definition.theoryPacks].sort((left, right) => `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`)),
    nodeTypes,
    edgeTypes,
    rules: definition.hardRules.map((rule) => ({ id: prefixed("rule", rule.id), description: rule.description, invariant: true, provenance: [sourceId], enforcement: [structuredClone(rule.constraint)] })),
    mechanisms: mechanismSelections(definition),
    initialGraph: { nodes, edges, facts },
    presentationHints: {
      language: definition.metadata.language ?? "en",
      tags: [...(definition.metadata.tags ?? [])],
      mapCoordinates: Object.fromEntries(definition.geography.places.map((place) => [placeId(place.id), place.coordinates ?? null])),
      optionalImages: images,
      creatorParameters: structuredClone(definition.parameters),
      creatorDraftId: definition.draftId,
      creatorDefinitionHash: hash(definition),
      calendarName: definition.temporal.calendarName,
      startYear: definition.temporal.startYear,
      focalCharacterIds: definition.characters.filter((character) => character.focal).map((character) => prefixed("person", character.id)).sort(),
    },
  };
  return { blueprint, sources: [source] };
}

export function createCreatorWorldDraft(definition: CreatorWorldDefinition, revision = 1): CreatorWorldDraft {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new RangeError("Draft revision must be a positive safe integer");
  const inspection = inspectCreatorWorldDefinition(definition);
  return {
    worldId: definition.worldId,
    draftId: definition.draftId,
    revision,
    status: inspection.issues.length > 0 ? "invalid" : inspection.questions.length > 0 ? "needs-input" : "ready",
    definitionHash: hash(definition),
    definition: structuredClone(definition),
    questions: inspection.questions,
    issues: inspection.issues,
  };
}
