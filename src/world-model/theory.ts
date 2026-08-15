import type {
  CompilationFinding,
  TheoryPackDefinition,
  TheoryPackSelection,
  WorldBlueprint,
} from "./types.ts";

export function theoryPackRef(value: Pick<TheoryPackDefinition | TheoryPackSelection, "id" | "version">): string {
  return `${value.id}@${value.version}`;
}

/**
 * This is a prompt-and-applicability library, not a universal law table. A
 * World opts in, parameters may narrow a pack, and incompatible premises block
 * compilation instead of being silently bent toward Earth defaults.
 */
export const theoryPackLibrary: readonly TheoryPackDefinition[] = [
  {
    id: "theory.psychology.big-five",
    version: "1",
    domain: "psychology",
    title: "Big Five trait vocabulary",
    summary: "A descriptive trait vocabulary for persistent behavioural tendencies; it does not determine a choice by itself.",
    constructs: ["openness", "conscientiousness", "extraversion", "agreeableness", "negative-emotionality"],
    requiredAssumptions: ["agents.trait-psychology-applicable"],
    prohibitedAssumptions: ["agents.no-persistent-dispositions"],
    promptGuidance: [
      "Treat traits as probabilistic tendencies conditional on situation, role, learning, incentives, and available information.",
      "Do not infer moral worth, competence, or one inevitable action from a score.",
    ],
    sourceRefs: ["Costa & McCrae — Five-Factor Model", "John, Naumann & Soto — Big Five taxonomy"],
    evidenceMaturity: "evidence-supported",
  },
  {
    id: "theory.psychology.bounded-cognition",
    version: "1",
    domain: "psychology",
    title: "Bounded cognition and satisficing",
    summary: "Subjects decide through limited information, attention, time, and computational capacity.",
    constructs: ["attention", "aspiration-level", "search-cost", "satisficing", "framing"],
    requiredAssumptions: ["agents.bounded-information-processing"],
    prohibitedAssumptions: ["agents.omniscient-perfect-optimization"],
    promptGuidance: [
      "Reason from the subject's accessible evidence rather than the audit view.",
      "Generate a small feasible consideration set before choosing; include delay, investigation, avoidance, or hedging when plausible.",
    ],
    sourceRefs: ["Herbert Simon — Models of bounded rationality"],
    evidenceMaturity: "evidence-supported",
  },
  {
    id: "theory.social.social-identity",
    version: "1",
    domain: "social-psychology",
    title: "Conditional social identity dynamics",
    summary: "Group categories may shape self-understanding and intergroup behaviour when they are salient and institutionally meaningful.",
    constructs: ["categorization", "identification", "salience", "in-group", "out-group", "status"],
    requiredAssumptions: ["groups.social-categorization-possible"],
    prohibitedAssumptions: ["agents.no-group-identification"],
    promptGuidance: [
      "Check whether a category is salient in this situation instead of assuming every label drives behaviour.",
      "Separate public category, private identification, perceived norms, and material interest.",
    ],
    sourceRefs: ["Tajfel & Turner — Social identity theory"],
    evidenceMaturity: "evidence-supported",
  },
  {
    id: "theory.organization.principal-agent",
    version: "1",
    domain: "organization",
    title: "Delegation and hidden-interest analysis",
    summary: "A lens for divergence between declared organizational goals, delegated action, information, incentives, and actual beneficiaries.",
    constructs: ["principal", "agent", "delegation", "information-asymmetry", "monitoring", "private-benefit"],
    requiredAssumptions: ["organizations.delegated-authority"],
    prohibitedAssumptions: ["organizations.perfect-interest-alignment"],
    promptGuidance: [
      "Model charter, leaders' interests, implementers' incentives, informal coalitions, and observed outcomes separately.",
      "Do not assume an official mission explains actual behaviour.",
    ],
    sourceRefs: ["Jensen & Meckling — Theory of the firm", "Michels — Political parties and oligarchy"],
    evidenceMaturity: "evidence-supported",
  },
  {
    id: "theory.institution.rules-in-use",
    version: "1",
    domain: "institution",
    title: "Rules-in-use and institutional adaptation",
    summary: "Formal law, local custom, enforcement practice, and actual rules-in-use may diverge across jurisdictions and groups.",
    constructs: ["formal-rule", "custom", "jurisdiction", "monitoring", "sanction", "rules-in-use"],
    requiredAssumptions: ["institutions.rules-and-practices"],
    prohibitedAssumptions: [],
    promptGuidance: [
      "Bind laws and customs to jurisdiction, population, period, enforcement capacity, and exceptions.",
      "Track how repeated workarounds can become custom or institutional change without assuming progress.",
    ],
    sourceRefs: ["Elinor Ostrom — Institutional analysis and development"],
    evidenceMaturity: "evidence-supported",
  },
  {
    id: "theory.economy.stock-flow-claims",
    version: "1",
    domain: "economy",
    title: "Stocks, flows, access, and claims",
    summary: "Resources are distinguished from legal claims, practical access, production flows, reserves, and distribution institutions.",
    constructs: ["stock", "flow", "capacity", "claim", "access", "reserve", "distribution"],
    requiredAssumptions: ["resources.quantified"],
    prohibitedAssumptions: ["resources.non-quantifiable-by-world-law"],
    promptGuidance: [
      "Never equate physical abundance with equal access, ownership, political control, or absence of status competition.",
      "State units, time bases, losses, bottlenecks, rival claims, and who can enforce a claim.",
    ],
    sourceRefs: ["Stock-flow consistent accounting traditions", "Institutional resource governance literature"],
    evidenceMaturity: "evidence-supported",
  },
  {
    id: "theory.history.path-dependence",
    version: "1",
    domain: "history",
    title: "Path dependence and critical junctures",
    summary: "Earlier choices, infrastructures, and coalitions may alter later option costs without making history deterministic.",
    constructs: ["critical-juncture", "increasing-return", "switching-cost", "institutional-layering", "contingency"],
    requiredAssumptions: ["history.investments-can-constrain-later-options"],
    prohibitedAssumptions: ["history.fully-memoryless"],
    promptGuidance: [
      "Preserve contingency: identify both inherited constraints and still-reachable alternatives.",
      "When a new input changes an earlier causal premise, branch from the earliest affected point.",
    ],
    sourceRefs: ["Paul Pierson — Increasing returns and path dependence", "Historical institutionalism"],
    evidenceMaturity: "evidence-supported",
  },
  {
    id: "theory.ecology.coupled-systems",
    version: "1",
    domain: "ecology",
    title: "Coupled environment and settlement dynamics",
    summary: "Population, settlement, production, hazards, and ecosystems interact across multiple temporal scales.",
    constructs: ["carrying-capacity", "disturbance", "resilience", "feedback", "migration", "land-use"],
    requiredAssumptions: ["ecology.environment-affects-settlement"],
    prohibitedAssumptions: ["ecology.environment-causally-inert"],
    promptGuidance: [
      "Separate slow environmental change from medium institutional adaptation and short-lived local events.",
      "Treat disaster impact as hazard multiplied by exposure and vulnerability, not as a random spectacle.",
    ],
    sourceRefs: ["Coupled human and natural systems literature", "Resilience ecology"],
    evidenceMaturity: "evidence-supported",
  },
];

export function validateTheorySelections(
  blueprint: WorldBlueprint,
  library: readonly TheoryPackDefinition[] = theoryPackLibrary,
): CompilationFinding[] {
  const findings: CompilationFinding[] = [];
  const byRef = new Map(library.map((pack) => [theoryPackRef(pack), pack]));
  const counts = new Map<string, number>();
  for (const selection of blueprint.theoryPacks) {
    const ref = theoryPackRef(selection);
    counts.set(ref, (counts.get(ref) ?? 0) + 1);
    const pack = byRef.get(ref);
    if (!pack) {
      findings.push({ code: "unknown-theory-pack", severity: "error", message: `Theory Pack ${ref} is not available.`, refs: [ref] });
      continue;
    }
    if (selection.mode === "disabled") continue;
    for (const assumption of pack.requiredAssumptions) {
      if (!blueprint.assumptions.includes(assumption)) {
        findings.push({
          code: "unsatisfied-theory-applicability",
          severity: "error",
          message: `Theory Pack ${ref} requires assumption ${assumption}.`,
          refs: [ref, assumption],
        });
      }
    }
    for (const assumption of pack.prohibitedAssumptions) {
      if (blueprint.assumptions.includes(assumption)) {
        findings.push({
          code: "prohibited-theory-assumption",
          severity: "error",
          message: `Theory Pack ${ref} is incompatible with assumption ${assumption}.`,
          refs: [ref, assumption],
        });
      }
    }
    if (selection.mode === "parameterized" && Object.keys(selection.parameters).length === 0) {
      findings.push({
        code: "empty-theory-parameters",
        severity: "warning",
        message: `Theory Pack ${ref} is marked parameterized but declares no parameters.`,
        refs: [ref],
      });
    }
  }
  for (const [ref, count] of counts) {
    if (count > 1) findings.push({ code: "duplicate-theory-pack", severity: "error", message: `Theory Pack ${ref} is selected more than once.`, refs: [ref] });
  }
  return findings;
}

export function selectedTheoryDefinitions(
  selections: readonly TheoryPackSelection[],
  library: readonly TheoryPackDefinition[] = theoryPackLibrary,
): TheoryPackDefinition[] {
  const byRef = new Map(library.map((pack) => [theoryPackRef(pack), pack]));
  return selections
    .filter((selection) => selection.mode !== "disabled")
    .map((selection) => {
      const ref = theoryPackRef(selection);
      const pack = byRef.get(ref);
      if (!pack) throw new Error(`Unknown Theory Pack ${ref}`);
      return structuredClone(pack);
    })
    .sort((left, right) => theoryPackRef(left).localeCompare(theoryPackRef(right)));
}
