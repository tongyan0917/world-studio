import { hash, stableRandom } from "../kernel/stable.ts";
import type {
  BuildDecisionContextOptions,
  CausalDimension,
  CompiledWorldPackage,
  EvolutionBoundary,
  GraphWorldAction,
  JsonValue,
  SimulationScale,
  TransitionProposalSet,
  WorldEdge,
  WorldFact,
  WorldNode,
  WorldSnapshot,
} from "./types.ts";

export interface EvolutionModelProposer {
  propose(
    compiled: CompiledWorldPackage,
    snapshot: WorldSnapshot,
    options: BuildDecisionContextOptions,
  ): Promise<TransitionProposalSet>;
}

export interface MechanismEvaluationContext {
  readonly compiled: CompiledWorldPackage;
  readonly snapshot: WorldSnapshot;
  readonly boundary: EvolutionBoundary;
  readonly seed: string;
  readonly pass: number;
  readonly focusSubjectIds: readonly string[];
  readonly modelProposer?: EvolutionModelProposer;
}

export interface ProposedWorldEffect {
  readonly localId: string;
  readonly action: GraphWorldAction;
  readonly phaseOffset?: number;
  readonly causalParents?: readonly string[];
}

export interface MechanismEvaluation {
  readonly triggerSummary: string;
  readonly effects: readonly ProposedWorldEffect[];
  readonly modelInvocationId?: string;
  readonly proposalSet?: TransitionProposalSet;
}

export interface ExecutableWorldMechanism {
  /** Runtime process identity. Several processes may implement one Contract Mechanism. */
  readonly id: string;
  readonly mechanismId: string;
  readonly version: string;
  readonly stage: number;
  readonly dimensions: readonly CausalDimension[];
  /** Causal ports are part of the executable process contract and power closure auditing. */
  readonly reads: readonly CausalDimension[];
  readonly writes: readonly CausalDimension[];
  readonly scales: readonly SimulationScale[];
  evaluate(context: MechanismEvaluationContext): Promise<MechanismEvaluation> | MechanismEvaluation;
}

const allScales: readonly SimulationScale[] = ["macro", "meso", "micro"];

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function rounded(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function numberAttribute(node: WorldNode | undefined, field: string, fallback = 0): number {
  const value = node?.attributes[field];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function edgeNumber(edge: WorldEdge | undefined, field: string, fallback = 0): number {
  const value = edge?.attributes[field];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nodesOfType(snapshot: WorldSnapshot, ...types: string[]): WorldNode[] {
  const selected = new Set(types);
  return Object.values(snapshot.nodes).filter((node) => selected.has(node.type)).sort((left, right) => left.id.localeCompare(right.id));
}

function markerId(processId: string, boundaryId: string, subjectId: string): string {
  return `fact:process:${hash({ processId, boundaryId, subjectId }).slice(0, 24)}`;
}

function alreadyProcessed(context: MechanismEvaluationContext, processId: string, subjectId: string): boolean {
  return Boolean(context.snapshot.facts[markerId(processId, context.boundary.id, subjectId)]);
}

function marker(
  context: MechanismEvaluationContext,
  process: ExecutableWorldMechanism,
  subjectId: string,
  details: JsonValue,
  phaseOffset = 8,
  scopeId = subjectId,
): ProposedWorldEffect {
  const id = markerId(process.id, context.boundary.id, scopeId);
  const fact: WorldFact = {
    id,
    subjectId,
    predicate: "mechanism-boundary-evaluation",
    value: {
      processId: process.id,
      mechanismId: process.mechanismId,
      boundaryId: context.boundary.id,
      scale: context.boundary.scale,
      details,
    },
    authority: "world-transition",
    provenance: [`mechanism:${process.id}@${process.version}`, `boundary:${context.boundary.id}`],
    epistemicScope: "world",
  };
  return { localId: `marker:${hash(id).slice(0, 12)}`, phaseOffset, action: { kind: "assert-fact", fact } };
}

function nodeLocation(snapshot: WorldSnapshot, nodeId: string): string | undefined {
  return Object.values(snapshot.edges).find((edge) => edge.type === "located-in" && edge.from === nodeId)?.to;
}

function nodesAt(snapshot: WorldSnapshot, placeId: string, types?: readonly string[]): WorldNode[] {
  const allowed = types ? new Set(types) : undefined;
  const ids = Object.values(snapshot.edges).filter((edge) => edge.type === "located-in" && edge.to === placeId).map((edge) => edge.from);
  return ids.map((id) => snapshot.nodes[id]).filter((node): node is WorldNode => Boolean(node) && (!allowed || allowed.has(node.type))).sort((a, b) => a.id.localeCompare(b.id));
}

function boundaryEvents(snapshot: WorldSnapshot, boundary: EvolutionBoundary): WorldNode[] {
  return nodesOfType(snapshot, "event").filter((node) => node.attributes["start-time"] === boundary.worldTime);
}

function resourceScarcity(node: WorldNode): number {
  const explicit = node.attributes.scarcity;
  if (typeof explicit === "number") return clamp(explicit, 0, 1);
  if (node.type === "spirit-vein") {
    const capacity = numberAttribute(node, "qi-capacity", 1);
    return capacity > 0 ? clamp(1 - numberAttribute(node, "qi-reserve") / capacity, 0, 1) : 1;
  }
  const capacity = numberAttribute(node, "capacity", numberAttribute(node, "quantity", 1));
  const quantity = numberAttribute(node, "quantity");
  return capacity > 0 ? clamp(1 - quantity / capacity, 0, 1) : 1;
}

function localScarcity(snapshot: WorldSnapshot, placeId: string | undefined): number {
  if (!placeId) return 0;
  const resources = nodesAt(snapshot, placeId, ["resource-stock", "spirit-vein"]);
  if (resources.length === 0) return 0;
  return resources.reduce((sum, node) => sum + resourceScarcity(node), 0) / resources.length;
}

function eventNode(
  id: string,
  name: string,
  category: string,
  boundary: EvolutionBoundary,
  intensity: number,
  summary: string,
  dimensions: readonly CausalDimension[],
  locationId?: string,
): WorldNode {
  return {
    id,
    type: "event",
    attributes: {
      name,
      category,
      "start-time": boundary.worldTime,
      scale: boundary.scale,
      status: "occurred",
      intensity: rounded(intensity),
      summary,
      dimensions: [...dimensions],
      ...(locationId ? { "location-id": locationId } : {}),
    },
  };
}

export const creatorWorldLawMechanism: ExecutableWorldMechanism = {
  id: "process.creator-world-laws",
  mechanismId: "mechanism.creator-world-laws",
  version: "1",
  stage: 5,
  dimensions: ["world-specific", "environment", "space", "hazard", "organization", "information", "relationship", "conflict", "cross-scale"],
  reads: ["world-specific", "environment", "space", "hazard", "organization", "relationship"],
  writes: ["world-specific", "environment", "hazard", "organization", "information", "conflict", "cross-scale"],
  scales: allScales,
  evaluate(context) {
    const parameters = nodesOfType(context.snapshot, "world-parameters")[0];
    if (!parameters || alreadyProcessed(context, this.id, parameters.id)) return { triggerSummary: "No unapplied creator parameter state was available.", effects: [] };
    const environmentalVolatility = numberAttribute(parameters, "environmental-volatility", 1);
    const routeSensitivity = numberAttribute(parameters, "route-sensitivity", 1);
    const hazardMultiplier = numberAttribute(parameters, "hazard-frequency-multiplier", 1);
    const organizationRate = numberAttribute(parameters, "organization-adaptation-rate", 1);
    const routeMean = nodesOfType(context.snapshot, "route").map((node) => numberAttribute(node, "reliability", 50));
    const hazardMean = nodesOfType(context.snapshot, "hazard").map((node) => numberAttribute(node, "baseline-frequency", 0));
    const organizationMean = nodesOfType(context.snapshot, "organization").map((node) => numberAttribute(node, "capacity", 50));
    const trustValues = Object.values(context.snapshot.edges).filter((edge) => edge.type === "related-to").map((edge) => edgeNumber(edge, "trust", 50));
    const mean = (items: readonly number[], fallback: number) => items.length > 0 ? items.reduce((sum, value) => sum + value, 0) / items.length : fallback;
    const draw = stableRandom({
      seed: context.seed,
      mechanismId: this.mechanismId,
      mechanismVersion: this.version,
      causalInstanceId: `${context.boundary.id}:${parameters.id}`,
      purpose: "creator-world-coupling",
      drawIndex: 0,
    });
    const signal = {
      boundaryId: context.boundary.id,
      environmentalVolatility,
      routeSensitivity,
      hazardMultiplier,
      organizationRate,
      routeReliability: rounded(mean(routeMean, 50)),
      hazardPressure: rounded(mean(hazardMean, 0) * hazardMultiplier),
      organizationCapacity: rounded(mean(organizationMean, 50) * organizationRate),
      relationshipTrust: rounded(mean(trustValues, 50)),
      residualDraw: draw.keyHash,
    };
    const effects: ProposedWorldEffect[] = [
      { localId: "last-boundary", action: { kind: "set-node-attribute", nodeId: parameters.id, fieldId: "last-applied-boundary", value: context.boundary.id } },
      { localId: "world-signal", action: { kind: "set-node-attribute", nodeId: parameters.id, fieldId: "world-signal", value: signal } },
    ];
    for (const place of nodesOfType(context.snapshot, "place")) {
      const current = numberAttribute(place, "environmental-stress", 30);
      const routePressure = (50 - signal.routeReliability) * 0.015 * routeSensitivity;
      const hazardPressure = signal.hazardPressure * 0.012;
      const socialBuffer = Math.max(0, signal.organizationCapacity + signal.relationshipTrust - 100) * 0.006;
      const residual = (draw.unitInterval - 0.5) * 2.5 * environmentalVolatility;
      const next = rounded(clamp(current + routePressure + hazardPressure + residual - socialBuffer));
      if (next !== current) effects.push({ localId: `stress:${place.id}`, action: { kind: "set-node-attribute", nodeId: place.id, fieldId: "environmental-stress", value: next } });
    }
    effects.push(marker(context, this, parameters.id, signal));
    return { triggerSummary: "Creator parameters couple current routes, hazards, organizations, relationships, and environment through a deterministic recorded signal rather than a supplied outcome.", effects };
  },
};

export const environmentCycleMechanism: ExecutableWorldMechanism = {
  id: "process.environment-cycle",
  mechanismId: "mechanism.environment-cycle",
  version: "1",
  stage: 10,
  dimensions: ["environment", "space", "resource", "population", "cross-scale"],
  reads: ["resource", "population", "cross-scale"],
  writes: ["environment", "space"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const place of nodesOfType(context.snapshot, "place")) {
      if (alreadyProcessed(context, this.id, place.id)) continue;
      const current = numberAttribute(place, "environmental-stress", 30);
      const scarcity = localScarcity(context.snapshot, place.id);
      const indicator = nodesOfType(context.snapshot, "world-indicator")[0];
      const ecologicalHealth = numberAttribute(indicator, "ecological-health", 65);
      const draw = stableRandom({
        seed: context.seed,
        mechanismId: this.mechanismId,
        mechanismVersion: this.version,
        causalInstanceId: `${context.boundary.id}:${place.id}`,
        purpose: "environmental-pressure",
        drawIndex: 0,
      });
      const durationFactor = Math.min(1.5, Math.sqrt(context.boundary.durationYears / 10));
      const stochasticPressure = (draw.unitInterval - 0.5) * 18 * durationFactor;
      const feedbackPressure = scarcity * 12 + Math.max(0, 55 - ecologicalHealth) * 0.12;
      const recovery = context.boundary.scale === "micro" ? 0 : 2.5;
      const next = rounded(clamp(current + stochasticPressure + feedbackPressure - recovery));
      if (next !== current) effects.push({ localId: `stress:${place.id}`, action: { kind: "set-node-attribute", nodeId: place.id, fieldId: "environmental-stress", value: next } });
      effects.push(marker(context, this, place.id, { from: current, to: next, scarcity: rounded(scarcity), randomDraw: draw.keyHash }));
    }
    return { triggerSummary: "Environmental pressure derived from duration, local scarcity, prior ecological state, and a stable random stream.", effects };
  },
};

export const routeDynamicsMechanism: ExecutableWorldMechanism = {
  id: "process.route-dynamics",
  mechanismId: "mechanism.route-dynamics",
  version: "1",
  stage: 20,
  dimensions: ["space", "environment", "economy", "population"],
  reads: ["environment", "space"],
  writes: ["space", "economy", "population"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    const events = boundaryEvents(context.snapshot, context.boundary);
    for (const route of nodesOfType(context.snapshot, "route")) {
      if (alreadyProcessed(context, this.id, route.id)) continue;
      const origin = typeof route.attributes.origin === "string" ? route.attributes.origin : undefined;
      const destination = typeof route.attributes.destination === "string" ? route.attributes.destination : undefined;
      const places = [origin, destination].map((id) => id ? context.snapshot.nodes[id] : undefined).filter((node): node is WorldNode => Boolean(node));
      const environmentalStress = places.length > 0 ? places.reduce((sum, node) => sum + numberAttribute(node, "environmental-stress", 30), 0) / places.length : 30;
      const maintenance = numberAttribute(route, "maintenance", 50);
      const current = numberAttribute(route, "reliability", 60);
      const eventPenalty = events.some((event) => event.attributes.category === "hazard") ? 12 : 0;
      const duration = Math.min(20, context.boundary.durationYears);
      const delta = (maintenance - 50) * 0.025 * duration - Math.max(0, environmentalStress - 45) * 0.018 * duration - eventPenalty;
      const next = rounded(clamp(current + delta));
      const status = next < 25 ? "interrupted" : next < 50 ? "fragile" : next < 75 ? "open-with-risk" : "reliable";
      if (next !== current) effects.push({ localId: `reliability:${route.id}`, action: { kind: "set-node-attribute", nodeId: route.id, fieldId: "reliability", value: next } });
      if (route.attributes.status !== status) effects.push({ localId: `status:${route.id}`, action: { kind: "set-node-attribute", nodeId: route.id, fieldId: "status", value: status } });
      effects.push(marker(context, this, route.id, { reliabilityFrom: current, reliabilityTo: next, environmentalStress: rounded(environmentalStress), eventPenalty }));
    }
    return { triggerSummary: "Route reliability follows endpoints, environmental pressure, maintenance, and contemporaneous interruption rather than a written timetable.", effects };
  },
};

export const resourceBalanceMechanism: ExecutableWorldMechanism = {
  id: "process.resource-stock-flow",
  mechanismId: "mechanism.resource-balance",
  version: "1",
  stage: 30,
  dimensions: ["resource", "economy", "population", "environment"],
  reads: ["environment", "population", "economy"],
  writes: ["resource", "economy"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const resource of nodesOfType(context.snapshot, "resource-stock")) {
      if (alreadyProcessed(context, this.id, resource.id)) continue;
      const quantity = numberAttribute(resource, "quantity");
      const capacity = numberAttribute(resource, "capacity", quantity);
      const renewal = numberAttribute(resource, "renewal-rate");
      const demand = numberAttribute(resource, "baseline-demand");
      if (capacity <= 0) continue;
      const placeId = nodeLocation(context.snapshot, resource.id);
      const environmentalStress = numberAttribute(placeId ? context.snapshot.nodes[placeId] : undefined, "environmental-stress", 30);
      const environmentalRenewalFactor = rounded(clamp(1 - Math.max(0, environmentalStress - 30) * 0.008, 0.5, 1), 4);
      const effectiveRenewal = rounded(renewal * environmentalRenewalFactor);
      const rawDelta = (effectiveRenewal - demand) * context.boundary.durationYears;
      const nextQuantity = rounded(clamp(quantity + rawDelta, 0, capacity));
      const delta = rounded(nextQuantity - quantity);
      const scarcity = rounded(capacity > 0 ? 1 - nextQuantity / capacity : 1, 4);
      const nextPrice = rounded(100 * (1 + 1.8 * scarcity ** 2));
      if (delta !== 0) effects.push({ localId: `quantity:${resource.id}`, action: { kind: "adjust-node-number", nodeId: resource.id, fieldId: "quantity", delta, unit: "index" } });
      if (resource.attributes.scarcity !== scarcity) effects.push({ localId: `scarcity:${resource.id}`, action: { kind: "set-node-attribute", nodeId: resource.id, fieldId: "scarcity", value: scarcity } });
      if (resource.attributes["price-index"] !== nextPrice) effects.push({ localId: `price:${resource.id}`, action: { kind: "set-node-attribute", nodeId: resource.id, fieldId: "price-index", value: nextPrice } });
      effects.push(marker(context, this, resource.id, { quantityFrom: quantity, quantityTo: nextQuantity, renewal, effectiveRenewal, environmentalStress, environmentalRenewalFactor, demand, durationYears: context.boundary.durationYears, scarcity }));
    }
    return { triggerSummary: "Balanced stocks apply environmentally constrained renewal and demand, preserve capacity bounds, and derive scarcity and price pressure.", effects };
  },
};

export const spiritVeinCirculationMechanism: ExecutableWorldMechanism = {
  id: "process.spirit-vein-circulation",
  mechanismId: "mechanism.spirit-vein-circulation",
  version: "1",
  stage: 31,
  dimensions: ["world-specific", "resource", "environment", "economy", "hazard"],
  reads: ["world-specific", "environment", "economy", "resource"],
  writes: ["world-specific", "resource", "hazard"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const vein of nodesOfType(context.snapshot, "spirit-vein")) {
      if (alreadyProcessed(context, this.id, vein.id)) continue;
      let renewalRate = numberAttribute(vein, "renewal-rate");
      const regime = String(vein.attributes["renewal-regime"] ?? "");
      if (context.boundary.durationYears >= 0.5 && regime.startsWith("pending-low")) {
        renewalRate = Math.min(renewalRate, 210);
        effects.push({ localId: `renewal-rate:${vein.id}`, action: { kind: "set-node-attribute", nodeId: vein.id, fieldId: "renewal-rate", value: renewalRate } });
        effects.push({ localId: `renewal-regime:${vein.id}`, action: { kind: "set-node-attribute", nodeId: vein.id, fieldId: "renewal-regime", value: "degraded-below-50; annual renewal 210" } });
      }
      const draws = Object.values(context.snapshot.edges).filter((edge) => edge.type === "draws-from" && edge.to === vein.id).reduce((sum, edge) => sum + edgeNumber(edge, "annual-quota"), 0);
      const outflow = Object.values(context.snapshot.edges).filter((edge) => edge.type === "flows-to" && edge.from === vein.id).reduce((sum, edge) => sum + edgeNumber(edge, "annual-flow"), 0);
      const reserve = numberAttribute(vein, "qi-reserve");
      const capacity = numberAttribute(vein, "qi-capacity", reserve);
      const rawDelta = (renewalRate - draws - outflow) * context.boundary.durationYears;
      const reserveNext = rounded(clamp(reserve + rawDelta, 0, capacity));
      const reserveDelta = rounded(reserveNext - reserve);
      if (reserveDelta !== 0) effects.push({ localId: `reserve:${vein.id}`, action: { kind: "adjust-node-number", nodeId: vein.id, fieldId: "qi-reserve", delta: reserveDelta, unit: "qi-unit" } });

      const calendarYear = context.boundary.calendarYear;
      for (const perturbation of Object.values(context.snapshot.edges).filter((edge) => edge.type === "perturbs" && edge.to === vein.id)) {
        const gate = context.snapshot.nodes[perturbation.from];
        const period = numberAttribute(gate, "resonance-period");
        if (calendarYear === undefined || period <= 0 || calendarYear % period !== 0) continue;
        const resonanceFactId = `fact:resonance:${hash({ gate: gate?.id, vein: vein.id, calendarYear }).slice(0, 20)}`;
        if (context.snapshot.facts[resonanceFactId]) continue;
        const penalty = edgeNumber(perturbation, "stability-penalty");
        if (penalty > 0) effects.push({ localId: `resonance-penalty:${vein.id}`, action: { kind: "adjust-node-number", nodeId: vein.id, fieldId: "stability", delta: -penalty, unit: "index" } });
        effects.push({
          localId: `resonance-fact:${vein.id}`,
          action: { kind: "assert-fact", fact: { id: resonanceFactId, subjectId: gate!.id, predicate: "realm-gate-resonance", value: { calendarYear, targetVeinId: vein.id, stabilityPenalty: penalty }, authority: "world-transition", provenance: [`mechanism:${this.id}`, `edge:${perturbation.id}`], epistemicScope: "world" } },
        });
      }
      effects.push(marker(context, this, vein.id, { reserveFrom: reserve, reserveTo: reserveNext, renewalRate, draws, outflow, calendarYear: calendarYear ?? null }));
    }
    return { triggerSummary: "Spirit veins execute local renewal, extraction, outflow, capacity, resonance, and delayed-regime accounting.", effects };
  },
};

export const hazardImpactMechanism: ExecutableWorldMechanism = {
  id: "process.hazard-opportunity-and-impact",
  mechanismId: "mechanism.hazard-impact",
  version: "1",
  stage: 40,
  dimensions: ["hazard", "environment", "space", "resource", "population", "psychology", "organization", "world-specific"],
  reads: ["environment", "space", "resource", "world-specific"],
  writes: ["hazard", "resource", "population", "psychology", "organization"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const hazard of nodesOfType(context.snapshot, "hazard")) {
      if (alreadyProcessed(context, this.id, hazard.id)) continue;
      const locationId = nodeLocation(context.snapshot, hazard.id);
      const trigger = String(hazard.attributes["trigger-condition"] ?? "");
      let eligible = true;
      if (trigger) {
        const resonance = Object.values(context.snapshot.facts).some((fact) => fact.predicate === "realm-gate-resonance" && (fact.value as { calendarYear?: number }).calendarYear === context.boundary.calendarYear);
        const lowVein = nodesOfType(context.snapshot, "spirit-vein").some((node) => numberAttribute(node, "stability", 100) < 65);
        eligible = resonance && lowVein;
      }
      const frequency = numberAttribute(hazard, "baseline-frequency");
      const probability = eligible ? clamp(trigger ? 0.82 : frequency * context.boundary.durationYears / 100, 0, 0.9) : 0;
      const occurrence = stableRandom({ seed: context.seed, mechanismId: this.mechanismId, mechanismVersion: this.version, causalInstanceId: `${context.boundary.id}:${hazard.id}`, purpose: "hazard-occurrence", drawIndex: 0 });
      const magnitude = stableRandom({ seed: context.seed, mechanismId: this.mechanismId, mechanismVersion: this.version, causalInstanceId: `${context.boundary.id}:${hazard.id}`, purpose: "hazard-magnitude", drawIndex: 0 });
      const occurred = occurrence.unitInterval < probability;
      if (occurred) {
        const severity = rounded(30 + magnitude.unitInterval * 70);
        const eventId = `event:hazard:${hash({ boundary: context.boundary.id, hazard: hazard.id }).slice(0, 18)}`;
        effects.push({ localId: `event:${hazard.id}`, action: { kind: "create-node", node: eventNode(eventId, `${String(hazard.attributes.name)}发生`, "hazard", context.boundary, severity, `${String(hazard.attributes.name)}在已满足的世界条件下发生，具体损失沿暴露路径分别结算。`, this.dimensions, locationId) } });
        const exposures = Object.values(context.snapshot.edges).filter((edge) => edge.type === "exposed-to" && edge.to === hazard.id).sort((a, b) => a.id.localeCompare(b.id));
        for (const exposure of exposures) {
          const target = context.snapshot.nodes[exposure.from];
          if (!target) continue;
          const vulnerability = clamp(edgeNumber(exposure, "vulnerability")) / 100;
          const impact = severity / 100 * vulnerability;
          if (target.type === "settlement") {
            const population = numberAttribute(target, "population");
            const loss = Math.max(1, Math.round(population * impact * 0.006));
            effects.push({ localId: `population-loss:${target.id}`, action: { kind: "adjust-node-number", nodeId: target.id, fieldId: "population", delta: -loss, unit: "person" } });
            effects.push({ localId: `infrastructure:${target.id}`, action: { kind: "set-node-attribute", nodeId: target.id, fieldId: "infrastructure-state", value: `受${String(hazard.attributes.name)}影响；损伤指数${Math.round(impact * 100)}` } });
          } else if (target.type === "resource-stock") {
            const quantity = numberAttribute(target, "quantity");
            const loss = rounded(Math.min(quantity, Math.max(0.01, quantity * impact * 0.12)));
            if (loss > 0) effects.push({ localId: `resource-loss:${target.id}`, action: { kind: "adjust-node-number", nodeId: target.id, fieldId: "quantity", delta: -loss, unit: "index" } });
          } else if (target.type === "spirit-vein") {
            const stabilityLoss = Math.max(1, Math.round(impact * 16));
            effects.push({ localId: `vein-instability:${target.id}`, action: { kind: "adjust-node-number", nodeId: target.id, fieldId: "stability", delta: -stabilityLoss, unit: "index" } });
          } else if (target.type === "person" || target.type === "cultivator") {
            if (typeof target.attributes["qi-reserve"] === "number") {
              const qiLoss = Math.max(1, Math.round(numberAttribute(target, "qi-reserve") * impact * 0.35));
              effects.push({ localId: `qi-loss:${target.id}`, action: { kind: "adjust-node-number", nodeId: target.id, fieldId: "qi-reserve", delta: -qiLoss, unit: "qi-unit" } });
            }
            if (typeof target.attributes.stress === "number") {
              const stress = rounded(clamp(numberAttribute(target, "stress") + impact * 35));
              effects.push({ localId: `stress:${target.id}`, action: { kind: "set-node-attribute", nodeId: target.id, fieldId: "stress", value: stress } });
            }
          }
          effects.push({ localId: `impact-edge:${target.id}`, phaseOffset: 1, action: { kind: "create-edge", edge: { id: `edge:affected:${hash({ eventId, target: target.id }).slice(0, 18)}`, type: "affected-by", from: target.id, to: eventId, attributes: { impact: rounded(impact * 100), channel: exposure.id } } } });
        }
        effects.push({ localId: `occurrence:${hazard.id}`, action: { kind: "assert-fact", fact: { id: `fact:hazard:${hash({ eventId, occurred: true }).slice(0, 20)}`, subjectId: hazard.id, predicate: "hazard-occurrence", value: { eventId, probability: rounded(probability, 4), occurrenceDraw: occurrence.keyHash, magnitudeDraw: magnitude.keyHash, severity }, authority: "world-transition", provenance: [`controlled-random:${occurrence.keyHash}`, `controlled-random:${magnitude.keyHash}`], epistemicScope: "world" } } });
      }
      effects.push(marker(context, this, hazard.id, { eligible, probability: rounded(probability, 4), occurrenceDraw: occurrence.keyHash, occurred }));
    }
    return { triggerSummary: "Hazard eligibility comes from current World state; occurrence is reproducible; damage follows typed exposure paths.", effects };
  },
};

export const spiritVeinThresholdMechanism: ExecutableWorldMechanism = {
  id: "process.spirit-vein-threshold-feedback",
  mechanismId: "mechanism.spirit-vein-circulation",
  version: "1",
  stage: 45,
  dimensions: ["world-specific", "hazard", "resource", "cross-scale"],
  reads: ["hazard", "resource", "world-specific"],
  writes: ["world-specific", "resource", "cross-scale"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const vein of nodesOfType(context.snapshot, "spirit-vein")) {
      if (alreadyProcessed(context, this.id, vein.id)) continue;
      const stability = numberAttribute(vein, "stability");
      const regime = String(vein.attributes["renewal-regime"] ?? "");
      if (stability < 50 && !regime.startsWith("pending-low") && !regime.startsWith("degraded")) {
        effects.push({ localId: `pending:${vein.id}`, action: { kind: "set-node-attribute", nodeId: vein.id, fieldId: "renewal-regime", value: `pending-low-from-${context.boundary.calendarYear ?? context.boundary.worldTime}; applies next complete year` } });
      } else if (stability >= 55 && regime.startsWith("degraded") && context.boundary.durationYears >= 1) {
        const renewal = numberAttribute(vein, "renewal-rate");
        const recovered = Math.min(310, renewal + 25);
        effects.push({ localId: `recover-rate:${vein.id}`, action: { kind: "set-node-attribute", nodeId: vein.id, fieldId: "renewal-rate", value: recovered } });
        effects.push({ localId: `recover-regime:${vein.id}`, action: { kind: "set-node-attribute", nodeId: vein.id, fieldId: "renewal-regime", value: recovered >= 310 ? "stable-renewal-310" : `recovering-${recovered}` } });
      }
      effects.push(marker(context, this, vein.id, { stability, regimeBefore: regime }));
    }
    return { triggerSummary: "Spirit-vein hysteresis is evaluated after hazard effects and changes only a later complete-year renewal regime.", effects };
  },
};

export const populationDynamicsMechanism: ExecutableWorldMechanism = {
  id: "process.population-dynamics",
  mechanismId: "mechanism.population-dynamics",
  version: "1",
  stage: 50,
  dimensions: ["population", "resource", "environment", "hazard", "space"],
  reads: ["resource", "environment", "hazard", "space"],
  writes: ["population", "space"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const subject of nodesOfType(context.snapshot, "settlement", "population-group")) {
      if (alreadyProcessed(context, this.id, subject.id)) continue;
      const field = subject.type === "settlement" ? "population" : "population";
      const population = numberAttribute(subject, field);
      const placeId = nodeLocation(context.snapshot, subject.id) ?? (typeof subject.attributes["current-place"] === "string" ? String(subject.attributes["current-place"]) : undefined);
      const scarcity = localScarcity(context.snapshot, placeId);
      const environmentalStress = numberAttribute(placeId ? context.snapshot.nodes[placeId] : undefined, "environmental-stress", 30) / 100;
      const hazardImpact = Object.values(context.snapshot.edges).filter((edge) => edge.type === "affected-by" && edge.from === subject.id).some((edge) => context.snapshot.nodes[edge.to]?.attributes["start-time"] === context.boundary.worldTime) ? 1 : 0;
      const annualRate = 0.012 - scarcity * 0.028 - Math.max(0, environmentalStress - 0.45) * 0.018 - hazardImpact * 0.02;
      const delta = Math.round(population * annualRate * context.boundary.durationYears);
      const boundedDelta = Math.max(-Math.max(0, population - 1), delta);
      const foodSecurity = rounded(clamp(100 - scarcity * 85 - hazardImpact * 12));
      const migrationPressure = rounded(clamp(scarcity * 70 + environmentalStress * 25 + hazardImpact * 20));
      if (boundedDelta !== 0) effects.push({ localId: `population:${subject.id}`, action: { kind: "adjust-node-number", nodeId: subject.id, fieldId: field, delta: boundedDelta, unit: "person" } });
      if (subject.type === "settlement") {
        if (subject.attributes["food-security"] !== foodSecurity) effects.push({ localId: `food:${subject.id}`, action: { kind: "set-node-attribute", nodeId: subject.id, fieldId: "food-security", value: foodSecurity } });
        if (subject.attributes["migration-pressure"] !== migrationPressure) effects.push({ localId: `migration:${subject.id}`, action: { kind: "set-node-attribute", nodeId: subject.id, fieldId: "migration-pressure", value: migrationPressure } });
      } else {
        const readiness = rounded(clamp(numberAttribute(subject, "settlement-readiness", 45) + (55 - migrationPressure) * 0.08 + Math.max(0, 65 - scarcity * 100) * 0.04));
        if (subject.attributes["settlement-readiness"] !== readiness) effects.push({ localId: `readiness:${subject.id}`, action: { kind: "set-node-attribute", nodeId: subject.id, fieldId: "settlement-readiness", value: readiness } });
      }
      effects.push(marker(context, this, subject.id, { population, delta: boundedDelta, scarcity: rounded(scarcity), environmentalStress: rounded(environmentalStress), hazardImpact }));
    }
    return { triggerSummary: "Population changes derive from resource security, environment, hazard exposure, duration, and mobility pressure.", effects };
  },
};

export const exchangeNetworkMechanism: ExecutableWorldMechanism = {
  id: "process.exchange-network",
  mechanismId: "mechanism.exchange-network",
  version: "1",
  stage: 55,
  dimensions: ["economy", "space", "resource", "organization", "institution"],
  reads: ["space", "resource", "organization", "institution"],
  writes: ["economy", "resource"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    const routeReliability = nodesOfType(context.snapshot, "route").map((node) => numberAttribute(node, "reliability", 60));
    const routeMean = routeReliability.length ? routeReliability.reduce((a, b) => a + b, 0) / routeReliability.length : 60;
    for (const edge of Object.values(context.snapshot.edges).filter((candidate) => candidate.type === "trades-with").sort((a, b) => a.id.localeCompare(b.id))) {
      if (alreadyProcessed(context, this.id, edge.id)) continue;
      const scarcity = (localScarcity(context.snapshot, nodeLocation(context.snapshot, edge.from)) + localScarcity(context.snapshot, nodeLocation(context.snapshot, edge.to))) / 2;
      const enforcement = nodesOfType(context.snapshot, "institution").map((node) => numberAttribute(node, "enforcement-capacity", 50));
      const enforcementMean = enforcement.length ? enforcement.reduce((a, b) => a + b, 0) / enforcement.length : 50;
      const reliability = rounded(clamp(routeMean * 0.65 + enforcementMean * 0.25 + (1 - scarcity) * 10));
      const capacity = rounded(Math.max(0, edgeNumber(edge, "capacity", 50) * (0.7 + reliability / 333)));
      const spread = rounded(100 + scarcity * 120 + (100 - reliability) * 0.7);
      if (edge.attributes.reliability !== reliability) effects.push({ localId: `reliability:${edge.id}`, action: { kind: "set-edge-attribute", edgeId: edge.id, fieldId: "reliability", value: reliability } });
      if (edge.attributes.capacity !== capacity) effects.push({ localId: `capacity:${edge.id}`, action: { kind: "set-edge-attribute", edgeId: edge.id, fieldId: "capacity", value: capacity } });
      if (edge.attributes["price-spread"] !== spread) effects.push({ localId: `spread:${edge.id}`, action: { kind: "set-edge-attribute", edgeId: edge.id, fieldId: "price-spread", value: spread } });
      effects.push(marker(context, this, edge.from, { edgeId: edge.id, routeReliability: rounded(routeMean), enforcement: rounded(enforcementMean), scarcity: rounded(scarcity), reliability, capacity, spread }, 8, edge.id));
    }
    return { triggerSummary: "Exchange capacity and price pressure follow route reliability, institutional enforcement, and local scarcity.", effects };
  },
};

export const organizationAdaptationMechanism: ExecutableWorldMechanism = {
  id: "process.organization-adaptation",
  mechanismId: "mechanism.organization-adaptation",
  version: "1",
  stage: 60,
  dimensions: ["organization", "institution", "resource", "economy", "population", "conflict"],
  reads: ["resource", "economy", "population", "conflict", "institution"],
  writes: ["organization", "institution"],
  scales: allScales,
  async evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    let proposalSet: TransitionProposalSet | undefined;
    const modelCallFactId = `fact:model-proposal:${hash({ process: this.id, boundary: context.boundary.id }).slice(0, 22)}`;
    let modelAlreadyProposed = Boolean(context.snapshot.facts[modelCallFactId]);
    for (const organization of nodesOfType(context.snapshot, "organization").filter((node) => node.attributes.status !== "dissolved")) {
      if (alreadyProcessed(context, this.id, organization.id)) continue;
      const placeId = nodeLocation(context.snapshot, organization.id);
      const scarcity = localScarcity(context.snapshot, placeId);
      const crisis = boundaryEvents(context.snapshot, context.boundary).some((event) => !event.attributes["location-id"] || event.attributes["location-id"] === placeId);
      const gap = Object.values(context.snapshot.facts).some((fact) => fact.subjectId === organization.id && fact.predicate === "mission-practice-gap" && fact.value === true);
      const legitimacy = numberAttribute(organization, "legitimacy", 55);
      const cohesion = numberAttribute(organization, "cohesion", 55);
      const capacity = numberAttribute(organization, "capacity", 55);
      const nextLegitimacy = rounded(clamp(legitimacy - scarcity * 9 - (gap ? 3 : 0) - (crisis ? 2 : 0) + capacity * 0.025));
      const nextCohesion = rounded(clamp(cohesion + (crisis ? 2 : 0) - scarcity * 5 - (gap ? 1.5 : 0)));
      const nextCapacity = rounded(clamp(capacity - (crisis ? 2 : 0) - scarcity * 3 + nextCohesion * 0.018));
      const status = nextCohesion < 18 || nextLegitimacy < 12 ? "dissolving" : nextCohesion < 35 ? "factional" : "active";
      if (organization.attributes.legitimacy !== nextLegitimacy) effects.push({ localId: `legitimacy:${organization.id}`, action: { kind: "set-node-attribute", nodeId: organization.id, fieldId: "legitimacy", value: nextLegitimacy } });
      if (organization.attributes.cohesion !== nextCohesion) effects.push({ localId: `cohesion:${organization.id}`, action: { kind: "set-node-attribute", nodeId: organization.id, fieldId: "cohesion", value: nextCohesion } });
      if (organization.attributes.capacity !== nextCapacity) effects.push({ localId: `capacity:${organization.id}`, action: { kind: "set-node-attribute", nodeId: organization.id, fieldId: "capacity", value: nextCapacity } });
      if (organization.attributes.status !== status) effects.push({ localId: `status:${organization.id}`, action: { kind: "set-node-attribute", nodeId: organization.id, fieldId: "status", value: status } });
      const practice = scarcity > 0.45 || crisis
        ? "在正式使命之外启动紧急配给、内部审计与执行者裁量；其效果取决于资源、监督和成员合作"
        : "维持例行职责，同时通过内部联盟协商资源和执行优先级";
      if (organization.attributes["actual-practice"] !== practice) effects.push({ localId: `practice:${organization.id}`, action: { kind: "set-node-attribute", nodeId: organization.id, fieldId: "actual-practice", value: practice } });
      if (context.modelProposer && context.boundary.scale === "meso" && !modelAlreadyProposed) {
        proposalSet = await context.modelProposer.propose(context.compiled, context.snapshot, {
          subjectId: organization.id,
          purpose: "organization-deliberation",
          trigger: `The organization must choose a bounded response to scarcity=${rounded(scarcity)}, crisis=${crisis}, missionPracticeGap=${gap}, legitimacy=${legitimacy}, cohesion=${cohesion}, capacity=${capacity}. Deterministic accounting remains authoritative.`,
          worldTime: context.boundary.worldTime,
          causalPhase: context.pass * 1000 + this.stage * 10,
          frameId: context.boundary.frameId,
          allowedMechanismIds: [this.mechanismId],
        });
        const preferred = proposalSet.candidates.find((candidate) => candidate.id === proposalSet!.preferredCandidateId);
        if (!preferred) throw new Error(`Model proposal set ${proposalSet.id} has no preferred organization candidate`);
        effects.push({ localId: `model:${hash(preferred.id).slice(0, 12)}`, phaseOffset: 7, action: preferred.input.action });
        effects.push({ localId: `model-record:${organization.id}`, phaseOffset: 9, action: { kind: "assert-fact", fact: { id: modelCallFactId, subjectId: organization.id, predicate: "bounded-model-proposal-selected", value: { proposalSetId: proposalSet.id, preferredCandidateId: preferred.id, boundaryId: context.boundary.id }, authority: "world-transition", provenance: [`invocation:${proposalSet.invocation.id}`, `mechanism:${this.id}`], epistemicScope: "world" } } });
        modelAlreadyProposed = true;
      }
      effects.push(marker(context, this, organization.id, { scarcity: rounded(scarcity), crisis, missionPracticeGap: gap, legitimacyFrom: legitimacy, legitimacyTo: nextLegitimacy, cohesionFrom: cohesion, cohesionTo: nextCohesion, capacityFrom: capacity, capacityTo: nextCapacity, status }));
    }
    return { triggerSummary: "Organizations adapt through separate legitimacy, cohesion, implementation capacity, formal mission, and actual practice; a model may propose one meso strategy but cannot commit it.", effects, ...(proposalSet ? { modelInvocationId: proposalSet.invocation.id, proposalSet } : {}) };
  },
};

export const saltWaterGovernanceMechanism: ExecutableWorldMechanism = {
  id: "process.salt-water-governance",
  mechanismId: "mechanism.salt-water-governance",
  version: "1",
  stage: 62,
  dimensions: ["world-specific", "resource", "organization", "institution", "population"],
  reads: ["resource", "population", "organization"],
  writes: ["world-specific", "institution", "organization"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    const freshwater = nodesOfType(context.snapshot, "resource-stock").find((node) => String(node.attributes.name).includes("淡水"));
    const scarcity = freshwater ? resourceScarcity(freshwater) : 0;
    for (const pan of nodesOfType(context.snapshot, "salt-pan")) {
      if (alreadyProcessed(context, this.id, pan.id)) continue;
      const current = numberAttribute(pan, "water-access");
      const next = rounded(clamp(current - Math.max(0, scarcity - 0.25) * 12));
      if (next !== current) effects.push({ localId: `water-access:${pan.id}`, action: { kind: "set-node-attribute", nodeId: pan.id, fieldId: "water-access", value: next } });
      effects.push({ localId: `allocation:${pan.id}`, action: { kind: "assert-fact", fact: { id: `fact:salt-allocation:${hash({ boundary: context.boundary.id, pan: pan.id }).slice(0, 18)}`, subjectId: pan.id, predicate: "water-rights-allocation", value: { physicalScarcity: rounded(scarcity), enforceableAccessFrom: current, enforceableAccessTo: next, claimHolders: pan.attributes["claim-holders"] }, authority: "world-transition", provenance: [`mechanism:${this.id}`, freshwater?.id ?? "no-local-stock"], epistemicScope: "world" } } });
      effects.push(marker(context, this, pan.id, { scarcity: rounded(scarcity), physicalQuantityKeptSeparate: true, accessFrom: current, accessTo: next }));
    }
    return { triggerSummary: "Salt rights alter enforceable access through institutions; they never create physical freshwater.", effects };
  },
};

export const sectLineageGovernanceMechanism: ExecutableWorldMechanism = {
  id: "process.sect-lineage-governance",
  mechanismId: "mechanism.sect-lineage-governance",
  version: "1",
  stage: 63,
  dimensions: ["world-specific", "organization", "institution", "resource", "economy", "conflict"],
  reads: ["resource", "economy", "conflict", "organization"],
  writes: ["world-specific", "institution", "organization"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const governance of Object.values(context.snapshot.edges).filter((edge) => edge.type === "governs" && context.snapshot.nodes[edge.to]?.type === "spirit-vein")) {
      const organization = context.snapshot.nodes[governance.from];
      const vein = context.snapshot.nodes[governance.to];
      if (organization?.type !== "organization" || !vein || alreadyProcessed(context, this.id, governance.id)) continue;
      const reserveRatio = numberAttribute(vein, "qi-reserve") / Math.max(1, numberAttribute(vein, "qi-capacity"));
      const stability = numberAttribute(vein, "stability");
      const quotaEdges = Object.values(context.snapshot.edges).filter((edge) => edge.type === "draws-from" && edge.from === organization.id && edge.to === vein.id);
      const curtail = reserveRatio < 0.5 || stability < 55;
      for (const quota of quotaEdges) {
        const current = edgeNumber(quota, "annual-quota");
        const next = curtail ? rounded(Math.max(0, current * 0.9)) : current;
        if (next !== current) effects.push({ localId: `quota:${quota.id}`, action: { kind: "set-edge-attribute", edgeId: quota.id, fieldId: "annual-quota", value: next } });
      }
      const practice = curtail
        ? "护域、传承与扩招目标发生冲突；暂时压低抽取配额并把派系争议送入长老议程"
        : "维持护域与传承配额，继续由长老、执事和峰系分别承担决策与执行";
      if (organization.attributes["actual-practice"] !== practice) effects.push({ localId: `practice:${organization.id}`, action: { kind: "set-node-attribute", nodeId: organization.id, fieldId: "actual-practice", value: practice } });
      effects.push(marker(context, this, organization.id, { governanceEdge: governance.id, reserveRatio: rounded(reserveRatio, 4), stability, quotaEdges: quotaEdges.map((edge) => edge.id), curtailed: curtail }, 8, governance.id));
    }
    return { triggerSummary: "Sect charter, factions, actual extraction, lineage control, and implementation are resolved as separate causal surfaces.", effects };
  },
};

export const institutionAdaptationMechanism: ExecutableWorldMechanism = {
  id: "process.institution-adaptation",
  mechanismId: "mechanism.institution-adaptation",
  version: "1",
  stage: 65,
  dimensions: ["institution", "organization", "resource", "population", "information"],
  reads: ["organization", "resource", "population", "information"],
  writes: ["institution", "organization"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const institution of nodesOfType(context.snapshot, "institution")) {
      if (alreadyProcessed(context, this.id, institution.id)) continue;
      const placeId = nodeLocation(context.snapshot, institution.id);
      const scarcity = localScarcity(context.snapshot, placeId);
      const localOrganizations = placeId ? nodesAt(context.snapshot, placeId, ["organization"]) : nodesOfType(context.snapshot, "organization");
      const organizationCapacity = localOrganizations.length ? localOrganizations.reduce((sum, node) => sum + numberAttribute(node, "capacity", 50), 0) / localOrganizations.length : 45;
      const current = numberAttribute(institution, "enforcement-capacity", 50);
      const next = rounded(clamp(current + (organizationCapacity - 50) * 0.04 - scarcity * 4));
      const practice = scarcity > 0.45
        ? "正式规则继续存在，但执行转向限额、复核、例外登记与地方担保并行"
        : "按正式程序执行，并保留地方解释、复核和申诉路径";
      if (next !== current) effects.push({ localId: `enforcement:${institution.id}`, action: { kind: "set-node-attribute", nodeId: institution.id, fieldId: "enforcement-capacity", value: next } });
      if (institution.attributes["rule-in-use"] !== practice) effects.push({ localId: `practice:${institution.id}`, action: { kind: "set-node-attribute", nodeId: institution.id, fieldId: "rule-in-use", value: practice } });
      effects.push(marker(context, this, institution.id, { scarcity: rounded(scarcity), organizationCapacity: rounded(organizationCapacity), enforcementFrom: current, enforcementTo: next }));
    }
    return { triggerSummary: "Institutions keep formal rules, rules-in-use, enforcement, jurisdictional support, and scarcity pressure separate.", effects };
  },
};

export const daoOathConsequenceMechanism: ExecutableWorldMechanism = {
  id: "process.dao-oath-consequence",
  mechanismId: "mechanism.dao-oath-consequence",
  version: "1",
  stage: 68,
  dimensions: ["world-specific", "institution", "information", "organization", "psychology"],
  reads: ["institution", "information", "organization"],
  writes: ["world-specific", "psychology", "information"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const oath of nodesOfType(context.snapshot, "dao-oath")) {
      if (!oath.attributes.active || alreadyProcessed(context, this.id, oath.id)) continue;
      const bound = Object.values(context.snapshot.edges).filter((edge) => edge.type === "bound-by-oath" && edge.to === oath.id);
      const qualifyingEvidence = Object.values(context.snapshot.facts).filter((fact) => fact.predicate === "intentional-obstruction" || fact.predicate === "knowingly-false-signature");
      const triggeredSubjects = bound.filter((edge) => qualifyingEvidence.some((fact) => fact.subjectId === edge.from)).map((edge) => edge.from);
      effects.push({ localId: `scope-check:${oath.id}`, action: { kind: "assert-fact", fact: { id: `fact:oath-evaluation:${hash({ boundary: context.boundary.id, oath: oath.id }).slice(0, 20)}`, subjectId: oath.id, predicate: "dao-oath-scope-evaluation", value: { boundSubjects: bound.map((edge) => edge.from), qualifyingEvidence: qualifyingEvidence.map((fact) => fact.id), triggeredSubjects, result: triggeredSubjects.length ? "declared-consequence-eligible" : "not-triggered" }, authority: "world-transition", provenance: [`mechanism:${this.id}`, ...qualifyingEvidence.map((fact) => fact.id)], epistemicScope: "world" } } });
      effects.push(marker(context, this, oath.id, { triggeredSubjects, cannotReadIntent: true, noRetroactiveScopeExpansion: true }));
    }
    return { triggerSummary: "Dao oaths evaluate only declared participants, clauses, accessible evidence, and trigger scope; absence of qualifying evidence produces no punishment.", effects };
  },
};

export const informationDiffusionMechanism: ExecutableWorldMechanism = {
  id: "process.information-diffusion",
  mechanismId: "mechanism.information-diffusion",
  version: "1",
  stage: 70,
  dimensions: ["information", "space", "organization", "psychology", "conflict", "hazard"],
  reads: ["organization", "space", "conflict", "hazard"],
  writes: ["information", "psychology"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    const events = boundaryEvents(context.snapshot, context.boundary);
    for (const subjectId of context.focusSubjectIds) {
      const subject = context.snapshot.nodes[subjectId];
      if (!subject || alreadyProcessed(context, this.id, subject.id)) continue;
      const subjectPlace = nodeLocation(context.snapshot, subject.id);
      const memberships = Object.values(context.snapshot.edges).filter((edge) => edge.type === "member-of" && edge.from === subject.id);
      const organizationSignals = memberships.flatMap((membership) => Object.values(context.snapshot.facts).filter((fact) => fact.subjectId === membership.to && fact.epistemicScope === "world" && ["mission-practice-gap", "institutional-decision", "hazard-occurrence"].includes(fact.predicate)));
      const accessibleEvents = events.filter((event) => {
        const location = typeof event.attributes["location-id"] === "string" ? event.attributes["location-id"] : undefined;
        if (!location || location === subjectPlace) return true;
        return Object.values(context.snapshot.edges).some((edge) => edge.type === "member-of" && edge.from === subject.id && nodeLocation(context.snapshot, edge.to) === location);
      });
      for (const event of accessibleEvents) {
        const factId = `fact:observation:${hash({ event: event.id, subject: subject.id }).slice(0, 20)}`;
        if (context.snapshot.facts[factId]) continue;
        effects.push({ localId: `observe:${event.id}:${subject.id}`, action: { kind: "assert-fact", fact: { id: factId, subjectId: subject.id, predicate: "accessible-observation", value: { eventId: event.id, summary: event.attributes.summary, channel: subjectPlace === event.attributes["location-id"] ? "local-perception" : "organizational-channel" }, authority: "world-transition", provenance: [`event:${event.id}`, `mechanism:${this.id}`], epistemicScope: [subject.id] } } });
      }
      for (const signal of organizationSignals) {
        const factId = `fact:organizational-observation:${hash({ signal: signal.id, subject: subject.id }).slice(0, 20)}`;
        if (context.snapshot.facts[factId]) continue;
        effects.push({ localId: `organization-signal:${signal.id}:${subject.id}`, action: { kind: "assert-fact", fact: { id: factId, subjectId: subject.id, predicate: "accessible-observation", value: { organizationId: signal.subjectId, sourceFactId: signal.id, content: signal.value, channel: "membership-and-role-access" }, authority: "world-transition", provenance: [signal.id, ...memberships.filter((edge) => edge.to === signal.subjectId).map((edge) => edge.id), `mechanism:${this.id}`], epistemicScope: [subject.id] } } });
      }
      effects.push(marker(context, this, subject.id, { accessibleEventIds: accessibleEvents.map((event) => event.id), organizationalSignalIds: organizationSignals.map((fact) => fact.id) }));
    }
    return { triggerSummary: "Events become subject knowledge only through spatial or organizational access paths.", effects };
  },
};

export const actorDeliberationMechanism: ExecutableWorldMechanism = {
  id: "process.actor-deliberation",
  mechanismId: "mechanism.actor-deliberation",
  version: "1",
  stage: 80,
  dimensions: ["psychology", "information", "relationship", "organization", "conflict"],
  reads: ["information", "relationship", "organization", "conflict", "psychology"],
  writes: ["psychology"],
  scales: ["meso", "micro"],
  async evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    let proposalSet: TransitionProposalSet | undefined;
    for (const subjectId of context.focusSubjectIds) {
      const subject = context.snapshot.nodes[subjectId];
      if (!subject || !["person", "cultivator"].includes(subject.type) || alreadyProcessed(context, this.id, subject.id)) continue;
      const observations = Object.values(context.snapshot.facts).filter((fact) => fact.subjectId === subject.id && fact.epistemicScope !== "world" && fact.epistemicScope.includes(subject.id));
      if (context.modelProposer) {
        proposalSet = await context.modelProposer.propose(context.compiled, context.snapshot, {
          subjectId: subject.id,
          purpose: "actor-deliberation",
          trigger: observations.length > 0 ? `Accessible observations require a response: ${observations.map((fact) => fact.id).join(", ")}` : "The current causal boundary requires the subject to reassess active commitments.",
          worldTime: context.boundary.worldTime,
          causalPhase: context.pass * 1000 + this.stage * 10,
          frameId: context.boundary.frameId,
          allowedMechanismIds: [this.mechanismId],
        });
        const preferred = proposalSet.candidates.find((candidate) => candidate.id === proposalSet!.preferredCandidateId);
        if (!preferred) throw new Error(`Model proposal set ${proposalSet.id} has no preferred candidate`);
        effects.push({ localId: `model:${hash(preferred.id).slice(0, 12)}`, action: preferred.input.action });
      } else {
        const traits = subject.attributes.traits && typeof subject.attributes.traits === "object" && !Array.isArray(subject.attributes.traits) ? subject.attributes.traits as Record<string, JsonValue> : {};
        const conscientiousness = typeof traits.conscientiousness === "number" ? traits.conscientiousness : 50;
        const neuroticism = typeof traits.neuroticism === "number" ? traits.neuroticism : 45;
        const priorStress = numberAttribute(subject, "stress", 35);
        const observedCrisis = observations.some((fact) => typeof fact.value === "object" && fact.value !== null);
        const stress = rounded(clamp(priorStress + (observedCrisis ? 12 : -2) + (neuroticism - 50) * 0.05));
        const plan = observedCrisis && conscientiousness >= 60
          ? "先保存可复核证据，核对自身信息边界，再通过可信关系提出可撤回的小步行动"
          : stress >= 70
            ? "暂缓不可逆承诺，优先保障自身与近邻安全并寻找更多信息"
            : "维持当前职责，同时观察资源、关系与制度反馈后再扩大行动";
        if (subject.attributes.stress !== stress) effects.push({ localId: `stress:${subject.id}`, action: { kind: "set-node-attribute", nodeId: subject.id, fieldId: "stress", value: stress } });
        if (subject.attributes["current-plan"] !== plan) effects.push({ localId: `plan:${subject.id}`, action: { kind: "set-node-attribute", nodeId: subject.id, fieldId: "current-plan", value: plan } });
        effects.push({ localId: `appraisal:${subject.id}`, action: { kind: "assert-fact", fact: { id: `fact:appraisal:${hash({ boundary: context.boundary.id, subject: subject.id }).slice(0, 20)}`, subjectId: subject.id, predicate: "subjective-appraisal", value: { observations: observations.map((fact) => fact.id), stress, plan, theoryBoundary: "traits bias appraisal; they do not determine behavior" }, authority: "world-transition", provenance: [`mechanism:${this.id}`, ...observations.map((fact) => fact.id)], epistemicScope: [subject.id] } } });
      }
      effects.push(marker(context, this, subject.id, { observations: observations.map((fact) => fact.id), proposer: context.modelProposer ? "bounded-model" : "deterministic-fallback" }));
    }
    return { triggerSummary: "Actors deliberate from perspective-accessible information, psychology, commitments, and current pressure; the model only proposes.", effects, ...(proposalSet ? { modelInvocationId: proposalSet.invocation.id, proposalSet } : {}) };
  },
};

export const cultivationBreakthroughMechanism: ExecutableWorldMechanism = {
  id: "process.cultivation-breakthrough",
  mechanismId: "mechanism.cultivation-breakthrough",
  version: "1",
  stage: 85,
  dimensions: ["world-specific", "psychology", "resource", "hazard"],
  reads: ["psychology", "resource", "hazard", "world-specific"],
  writes: ["world-specific", "resource", "psychology"],
  scales: ["meso", "micro"],
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const subjectId of context.focusSubjectIds) {
      const subject = context.snapshot.nodes[subjectId];
      if (subject?.type !== "cultivator" || alreadyProcessed(context, this.id, subject.id)) continue;
      const plan = String(subject.attributes["current-plan"] ?? "");
      const practice = Object.values(context.snapshot.edges).find((edge) => edge.type === "practices" && edge.from === subject.id);
      const proficiency = edgeNumber(practice, "proficiency");
      const qi = numberAttribute(subject, "qi-reserve");
      const meridian = subject.attributes["meridian-state"] && typeof subject.attributes["meridian-state"] === "object" && !Array.isArray(subject.attributes["meridian-state"]) ? subject.attributes["meridian-state"] as Record<string, JsonValue> : {};
      const integrity = typeof meridian.integrity === "number" ? meridian.integrity : 0;
      const attempts = plan.includes("突破");
      const eligible = attempts && qi >= 80 && integrity >= 65 && proficiency >= 50;
      const draw = stableRandom({ seed: context.seed, mechanismId: this.mechanismId, mechanismVersion: this.version, causalInstanceId: `${context.boundary.id}:${subject.id}`, purpose: "breakthrough-resolution", drawIndex: 0 });
      const success = eligible && draw.unitInterval < clamp((qi + integrity + proficiency - 150) / 150, 0.1, 0.85);
      if (eligible) {
        const qiCost = success ? Math.min(qi - 1, 48) : Math.min(qi - 1, 31);
        effects.push({ localId: `qi-cost:${subject.id}`, action: { kind: "adjust-node-number", nodeId: subject.id, fieldId: "qi-reserve", delta: -qiCost, unit: "qi-unit" } });
        if (success) effects.push({ localId: `stage:${subject.id}`, action: { kind: "set-node-attribute", nodeId: subject.id, fieldId: "cultivation-stage", value: "筑基中期" } });
      }
      effects.push({ localId: `evaluation:${subject.id}`, action: { kind: "assert-fact", fact: { id: `fact:breakthrough:${hash({ boundary: context.boundary.id, subject: subject.id }).slice(0, 20)}`, subjectId: subject.id, predicate: "breakthrough-evaluation", value: { attempts, eligible, success, qi, meridianIntegrity: integrity, proficiency, draw: draw.keyHash }, authority: "world-transition", provenance: [`mechanism:${this.id}`, ...(practice ? [practice.id] : [])], epistemicScope: [subject.id] } } });
      effects.push(marker(context, this, subject.id, { attempts, eligible, success }));
    }
    return { triggerSummary: "Cultivation advances only after an actor attempts it and resource, meridian, art, experience, risk, and stable stochastic gates are satisfied.", effects };
  },
};

export const relationshipDynamicsMechanism: ExecutableWorldMechanism = {
  id: "process.relationship-dynamics",
  mechanismId: "mechanism.relationship-dynamics",
  version: "1",
  stage: 90,
  dimensions: ["relationship", "psychology", "information", "organization", "conflict"],
  reads: ["psychology", "information", "organization", "conflict"],
  writes: ["relationship"],
  scales: ["meso", "micro"],
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const edge of Object.values(context.snapshot.edges).filter((candidate) => ["related-to", "master-disciple"].includes(candidate.type)).sort((a, b) => a.id.localeCompare(b.id))) {
      if (typeof edge.attributes.trust !== "number" || alreadyProcessed(context, this.id, edge.id)) continue;
      const from = context.snapshot.nodes[edge.from];
      const to = context.snapshot.nodes[edge.to];
      const fromPlan = String(from?.attributes["current-plan"] ?? "");
      const toGap = Object.values(context.snapshot.facts).some((fact) => fact.subjectId === to?.id && fact.predicate === "mission-practice-gap" && fact.value === true);
      const transparent = fromPlan.includes("复核") || fromPlan.includes("可信关系");
      const current = edgeNumber(edge, "trust");
      const delta = (transparent ? 2 : 0) - (toGap ? 2 : 0) - (boundaryEvents(context.snapshot, context.boundary).length > 0 ? 1 : 0);
      const next = rounded(clamp(current + delta));
      if (next !== current) effects.push({ localId: `trust:${edge.id}`, action: { kind: "set-edge-attribute", edgeId: edge.id, fieldId: "trust", value: next } });
      effects.push(marker(context, this, edge.from, { edgeId: edge.id, trustFrom: current, trustTo: next, transparentAction: transparent, counterpartPracticeGap: toGap }, 8, edge.id));
    }
    return { triggerSummary: "Directional trust responds to observed conduct and accessible practice gaps; relationships do not update symmetrically by default.", effects };
  },
};

export const conflictDynamicsMechanism: ExecutableWorldMechanism = {
  id: "process.conflict-dynamics",
  mechanismId: "mechanism.conflict-dynamics",
  version: "1",
  stage: 95,
  dimensions: ["conflict", "organization", "resource", "economy", "relationship", "institution"],
  reads: ["organization", "resource", "economy", "relationship", "institution"],
  writes: ["conflict", "organization", "institution"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const edge of Object.values(context.snapshot.edges).filter((candidate) => candidate.type === "related-to").sort((a, b) => a.id.localeCompare(b.id))) {
      const from = context.snapshot.nodes[edge.from];
      const to = context.snapshot.nodes[edge.to];
      if (from?.type !== "organization" || to?.type !== "organization" || alreadyProcessed(context, this.id, edge.id)) continue;
      const trust = edgeNumber(edge, "trust", 50);
      const scarcity = Math.max(localScarcity(context.snapshot, nodeLocation(context.snapshot, from.id)), localScarcity(context.snapshot, nodeLocation(context.snapshot, to.id)));
      if (trust < 45 && scarcity > 0.25) {
        const eventId = `event:conflict:${hash({ boundary: context.boundary.id, edge: edge.id }).slice(0, 18)}`;
        const intensity = rounded(clamp((45 - trust) * 2 + scarcity * 55));
        const placeId = nodeLocation(context.snapshot, from.id) ?? nodeLocation(context.snapshot, to.id);
        effects.push({ localId: `event:${edge.id}`, action: { kind: "create-node", node: eventNode(eventId, `${String(from.attributes.name)}与${String(to.attributes.name)}的利益冲突公开化`, "conflict", context.boundary, intensity, "低信任与资源压力使既有合作关系转为公开争执；后续结果仍取决于制度、联盟和执行能力。", this.dimensions, placeId) } });
        effects.push({ localId: `from:${edge.id}`, phaseOffset: 1, action: { kind: "create-edge", edge: { id: `edge:affected:${hash({ eventId, subject: from.id }).slice(0, 18)}`, type: "affected-by", from: from.id, to: eventId, attributes: { impact: intensity, channel: edge.id } } } });
        effects.push({ localId: `to:${edge.id}`, phaseOffset: 1, action: { kind: "create-edge", edge: { id: `edge:affected:${hash({ eventId, subject: to.id }).slice(0, 18)}`, type: "affected-by", from: to.id, to: eventId, attributes: { impact: intensity, channel: edge.id } } } });
      }
      effects.push(marker(context, this, edge.from, { edgeId: edge.id, trust, scarcity: rounded(scarcity), escalated: trust < 45 && scarcity > 0.25 }, 8, edge.id));
    }
    return { triggerSummary: "Conflict emerges when incompatible organizational relations meet resource pressure; it is an event, not a scripted plot beat.", effects };
  },
};

export const settlementFormationMechanism: ExecutableWorldMechanism = {
  id: "process.settlement-formation",
  mechanismId: "mechanism.world-evolution",
  version: "1",
  stage: 100,
  dimensions: ["population", "space", "resource", "economy", "organization", "institution", "cross-scale"],
  reads: ["population", "space", "resource", "economy"],
  writes: ["population", "space", "organization", "institution", "cross-scale"],
  scales: ["macro", "meso"],
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const group of nodesOfType(context.snapshot, "population-group")) {
      if (alreadyProcessed(context, this.id, group.id)) continue;
      const population = numberAttribute(group, "population");
      const readiness = numberAttribute(group, "settlement-readiness");
      const placeId = typeof group.attributes["current-place"] === "string" ? String(group.attributes["current-place"]) : nodeLocation(context.snapshot, group.id);
      const scarcity = localScarcity(context.snapshot, placeId);
      const existingOrigin = Object.values(context.snapshot.edges).some((edge) => edge.type === "originates-from" && edge.to === group.id);
      const forms = Boolean(placeId) && population >= 200 && readiness >= 60 && scarcity <= 0.65 && !existingOrigin;
      if (forms) {
        const settledPopulation = Math.max(120, Math.min(2500, Math.round(population * 0.62)));
        const settlementId = `settlement:formed:${hash({ group: group.id, place: placeId }).slice(0, 14)}`;
        const name = typeof group.attributes["settlement-name"] === "string" ? String(group.attributes["settlement-name"]) : `${String(group.attributes.name)}定居点`;
        effects.push({ localId: `settlement:${group.id}`, action: { kind: "create-node", node: { id: settlementId, type: "settlement", attributes: { name, population: settledPopulation, "founded-year": context.boundary.calendarYear ?? context.boundary.worldTime, role: String(group.attributes.livelihood ?? "local exchange and subsistence"), "infrastructure-state": "由季居设施、共同劳动与临时道路逐步形成", "food-security": rounded((1 - scarcity) * 100), "migration-pressure": 25 } } } });
        effects.push({ localId: `group-remainder:${group.id}`, action: { kind: "adjust-node-number", nodeId: group.id, fieldId: "population", delta: -settledPopulation, unit: "person" } });
        effects.push({ localId: `locate:${group.id}`, phaseOffset: 1, action: { kind: "create-edge", edge: { id: `edge:located:${hash({ settlementId, placeId }).slice(0, 16)}`, type: "located-in", from: settlementId, to: placeId!, attributes: {} } } });
        effects.push({ localId: `origin:${group.id}`, phaseOffset: 1, action: { kind: "create-edge", edge: { id: `edge:origin:${hash({ settlementId, group: group.id }).slice(0, 16)}`, type: "originates-from", from: settlementId, to: group.id, attributes: { share: rounded(settledPopulation / population), reason: "resource access, accumulated population, exchange opportunity, and settlement readiness" } } } });
      }
      effects.push(marker(context, this, group.id, { population, readiness, placeId: placeId ?? null, scarcity: rounded(scarcity), formed: forms }));
    }
    return { triggerSummary: "Settlements form from population concentration, place, resources, livelihood, and readiness; no settlement node is authored as an outcome.", effects };
  },
};

export const organizationFormationMechanism: ExecutableWorldMechanism = {
  id: "process.organization-formation",
  mechanismId: "mechanism.world-evolution",
  version: "1",
  stage: 105,
  dimensions: ["organization", "institution", "relationship", "population", "resource", "space"],
  reads: ["population", "resource", "space", "institution"],
  writes: ["organization", "institution", "relationship"],
  scales: ["macro", "meso"],
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const settlement of nodesOfType(context.snapshot, "settlement").filter((node) => node.id.startsWith("settlement:formed:"))) {
      const placeId = nodeLocation(context.snapshot, settlement.id);
      if (!placeId || alreadyProcessed(context, this.id, settlement.id)) continue;
      const alreadyGoverned = Object.values(context.snapshot.edges).some((edge) => edge.type === "governs" && edge.to === settlement.id);
      if (!alreadyGoverned) {
        const organizationId = `organization:formed:${hash({ settlement: settlement.id }).slice(0, 14)}`;
        effects.push({
          localId: `organization:${settlement.id}`,
          action: {
            kind: "create-node",
            node: {
              id: organizationId,
              type: "organization",
              attributes: {
                name: `${String(settlement.attributes.name)}共同议事会`,
                "declared-goal": "维护定居点的基础设施、交换秩序与共同安全",
                "actual-practice": "由出资者、劳动组织者与旧关系网络共同议事，执行权仍不均等",
                resources: ["共同劳动", "初始账册", "地方关系"],
                culture: ["互助", "资格争议", "公开协商"],
                "internal-coalitions": ["先居者", "运输与交换组织者", "依附家庭"],
                legitimacy: 58,
                cohesion: 62,
                capacity: 42,
                status: "forming",
              },
            },
          },
        });
        effects.push({ localId: `locate:${settlement.id}`, phaseOffset: 1, action: { kind: "create-edge", edge: { id: `edge:located:${hash({ organizationId, placeId }).slice(0, 16)}`, type: "located-in", from: organizationId, to: placeId, attributes: {} } } });
        effects.push({ localId: `govern:${settlement.id}`, phaseOffset: 1, action: { kind: "create-edge", edge: { id: `edge:governs:${hash({ organizationId, settlement: settlement.id }).slice(0, 16)}`, type: "governs", from: organizationId, to: settlement.id, attributes: { basis: "形成期共同劳动、资源记录与实际协调能力" } } } });
        const incumbent = nodesOfType(context.snapshot, "organization").find((organization) => organization.id !== organizationId && organization.attributes.status !== "dissolved");
        if (incumbent) effects.push({
          localId: `recognition:${settlement.id}`,
          phaseOffset: 1,
          action: {
            kind: "create-edge",
            edge: {
              id: `edge:recognition:${hash({ organizationId, incumbent: incumbent.id }).slice(0, 16)}`,
              type: "related-to",
              from: organizationId,
              to: incumbent.id,
              attributes: { relation: "新组织寻求承认、道路与资源接入；双方在授权边界上仍有分歧", trust: 48 },
            },
          },
        });
      }
      effects.push(marker(context, this, settlement.id, { alreadyGoverned, placeId }));
    }
    return { triggerSummary: "Organizations form after a coordination problem, members, resources, place, and practical authority exist.", effects };
  },
};

export const organizationLifecycleMechanism: ExecutableWorldMechanism = {
  id: "process.organization-lifecycle",
  mechanismId: "mechanism.world-evolution",
  version: "1",
  stage: 106,
  dimensions: ["organization", "institution", "relationship", "population", "resource", "cross-scale"],
  reads: ["organization", "institution", "relationship", "population", "resource"],
  writes: ["organization", "institution", "relationship", "cross-scale"],
  scales: ["macro", "meso"],
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    for (const organization of nodesOfType(context.snapshot, "organization").filter((node) => node.attributes.status === "dissolving")) {
      if (alreadyProcessed(context, this.id, organization.id)) continue;
      const successorId = `organization:successor:${hash({ predecessor: organization.id, boundary: context.boundary.id }).slice(0, 16)}`;
      effects.push({ localId: `dissolve:${organization.id}`, action: { kind: "set-node-attribute", nodeId: organization.id, fieldId: "status", value: "dissolved" } });
      effects.push({
        localId: `successor:${organization.id}`,
        action: {
          kind: "create-node",
          node: {
            id: successorId,
            type: "organization",
            attributes: {
              name: `${String(organization.attributes.name)}重组委员会`,
              "declared-goal": String(organization.attributes["declared-goal"]),
              "actual-practice": "在前组织失去合法性后，由剩余执行者、受影响成员与资源保管者临时重组",
              resources: organization.attributes.resources ?? [],
              culture: organization.attributes.culture ?? [],
              "internal-coalitions": ["连续履职者", "改革成员", "受影响群体代表"],
              legitimacy: 43,
              cohesion: 48,
              capacity: Math.max(20, rounded(numberAttribute(organization, "capacity", 40) * 0.72)),
              status: "forming",
            },
          },
        },
      });
      effects.push({ localId: `succession:${organization.id}`, phaseOffset: 1, action: { kind: "create-edge", edge: { id: `edge:succession:${hash({ successorId, predecessor: organization.id }).slice(0, 16)}`, type: "succeeds", from: successorId, to: organization.id, attributes: { mode: "reorganization-after-legitimacy-and-cohesion-failure", continuity: { resources: true, liabilities: true, formalIdentity: false } } } } });
      for (const governance of Object.values(context.snapshot.edges).filter((edge) => edge.type === "governs" && edge.from === organization.id)) {
        effects.push({ localId: `governance:${governance.id}`, phaseOffset: 1, action: { kind: "create-edge", edge: { ...governance, id: `edge:successor-governs:${hash({ successorId, target: governance.to }).slice(0, 16)}`, from: successorId, attributes: { ...governance.attributes, basis: `临时承接：${String(governance.attributes.basis)}` } } } });
      }
      for (const membership of Object.values(context.snapshot.edges).filter((edge) => edge.type === "member-of" && edge.to === organization.id)) {
        effects.push({ localId: `membership:${membership.id}`, phaseOffset: 1, action: { kind: "create-edge", edge: { ...membership, id: `edge:successor-member:${hash({ successorId, member: membership.from }).slice(0, 16)}`, to: successorId, attributes: { ...membership.attributes, role: `${String(membership.attributes.role)}（重组期）` } } } });
      }
      effects.push(marker(context, this, organization.id, { successorId, cause: "legitimacy-or-cohesion-below-contract-threshold", obligationsTransferred: true }));
    }
    return { triggerSummary: "Organizational decline changes status and may create a traceable successor with explicit resource, liability, membership, and authority continuity.", effects };
  },
};

export const crossScaleReconciliationMechanism: ExecutableWorldMechanism = {
  id: "process.cross-scale-reconciliation",
  mechanismId: "mechanism.world-evolution",
  version: "1",
  stage: 110,
  dimensions: ["cross-scale", "environment", "space", "resource", "economy", "population", "organization", "institution", "information", "psychology", "relationship", "conflict", "hazard", "world-specific"],
  reads: ["environment", "resource", "economy", "population", "organization", "institution", "relationship", "conflict"],
  writes: ["cross-scale"],
  scales: allScales,
  evaluate(context) {
    const effects: ProposedWorldEffect[] = [];
    const existing = nodesOfType(context.snapshot, "world-indicator")[0];
    const resources = nodesOfType(context.snapshot, "resource-stock", "spirit-vein");
    const routes = nodesOfType(context.snapshot, "route");
    const settlements = nodesOfType(context.snapshot, "settlement");
    const organizations = nodesOfType(context.snapshot, "organization");
    const institutions = nodesOfType(context.snapshot, "institution");
    const relations = Object.values(context.snapshot.edges).filter((edge) => edge.type === "related-to" && typeof edge.attributes.trust === "number");
    const environments = nodesOfType(context.snapshot, "place");
    const resourceSecurity = rounded(resources.length ? (1 - resources.reduce((sum, node) => sum + resourceScarcity(node), 0) / resources.length) * 100 : 55);
    const ecologicalHealth = rounded(100 - (environments.length ? environments.reduce((sum, node) => sum + numberAttribute(node, "environmental-stress", 30), 0) / environments.length : 30));
    const economicConnectivity = rounded(routes.length ? routes.reduce((sum, node) => sum + numberAttribute(node, "reliability", 60), 0) / routes.length : 50);
    const populationStability = rounded(settlements.length ? settlements.reduce((sum, node) => sum + (100 - numberAttribute(node, "migration-pressure", 35)), 0) / settlements.length : 50);
    const governanceLegitimacy = rounded(organizations.length ? organizations.reduce((sum, node) => sum + numberAttribute(node, "legitimacy", 50), 0) / organizations.length : 50);
    const institutionalCapacity = institutions.length ? institutions.reduce((sum, node) => sum + numberAttribute(node, "enforcement-capacity", 50), 0) / institutions.length : 50;
    const socialCohesion = rounded((organizations.length ? organizations.reduce((sum, node) => sum + numberAttribute(node, "cohesion", 50), 0) / organizations.length : 50) * 0.7 + (relations.length ? relations.reduce((sum, edge) => sum + edgeNumber(edge, "trust", 50), 0) / relations.length : 50) * 0.3);
    const conflictPressure = rounded(clamp((100 - resourceSecurity) * 0.35 + (100 - governanceLegitimacy) * 0.25 + (100 - socialCohesion) * 0.25 + (100 - institutionalCapacity) * 0.15));
    const values = {
      "ecological-health": ecologicalHealth,
      "resource-security": resourceSecurity,
      "economic-connectivity": economicConnectivity,
      "population-stability": populationStability,
      "governance-legitimacy": governanceLegitimacy,
      "social-cohesion": socialCohesion,
      "conflict-pressure": conflictPressure,
      "last-reconciled-time": context.boundary.worldTime,
    } as const;
    if (!existing) {
      effects.push({ localId: "create-indicator", action: { kind: "create-node", node: { id: "indicator:world-system", type: "world-indicator", attributes: { name: "世界系统综合状态", ...values } } } });
    } else if (!alreadyProcessed(context, this.id, existing.id)) {
      for (const [fieldId, value] of Object.entries(values)) if (existing.attributes[fieldId] !== value) effects.push({ localId: `indicator:${fieldId}`, action: { kind: "set-node-attribute", nodeId: existing.id, fieldId, value } });
      effects.push(marker(context, this, existing.id, values));
    }
    return { triggerSummary: "Fine outcomes are reconciled into inspectable cross-scale indicators that feed later boundaries without replacing detailed state.", effects };
  },
};

export const executableMechanismLibrary: readonly ExecutableWorldMechanism[] = [
  creatorWorldLawMechanism,
  environmentCycleMechanism,
  routeDynamicsMechanism,
  resourceBalanceMechanism,
  spiritVeinCirculationMechanism,
  hazardImpactMechanism,
  spiritVeinThresholdMechanism,
  populationDynamicsMechanism,
  exchangeNetworkMechanism,
  organizationAdaptationMechanism,
  saltWaterGovernanceMechanism,
  sectLineageGovernanceMechanism,
  institutionAdaptationMechanism,
  daoOathConsequenceMechanism,
  informationDiffusionMechanism,
  actorDeliberationMechanism,
  cultivationBreakthroughMechanism,
  relationshipDynamicsMechanism,
  conflictDynamicsMechanism,
  settlementFormationMechanism,
  organizationFormationMechanism,
  organizationLifecycleMechanism,
  crossScaleReconciliationMechanism,
];
