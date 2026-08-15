import { hash } from "../kernel/stable.ts";
import { projectSettingBook } from "../world-model/projections.ts";
import type { AutonomousWorldRun, CompiledWorldPackage } from "../world-model/types.ts";
import type { StudioHistoryEvidence, StudioSettingBookExport } from "./types.ts";

function safeFilename(value: string): string {
  return value.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "world";
}

export function exportSettingBook(
  compiled: CompiledWorldPackage,
  autonomous: AutonomousWorldRun,
  historyEvidence: readonly StudioHistoryEvidence[] = [],
): StudioSettingBookExport {
  if (compiled.worldId !== autonomous.worldId) throw new Error("Setting-book export cannot cross World scope");
  const projection = projectSettingBook(compiled, autonomous.run);
  const unresolvedUncertainty = [...new Set([
    ...Object.values(autonomous.run.finalSnapshot.facts).filter((fact) => fact.uncertainty).map((fact) => `${fact.id}: ${fact.uncertainty}`),
    ...historyEvidence.filter((item) => item.candidateRunId === autonomous.run.manifest.runId).flatMap((item) => item.unresolvedUncertainty),
  ])].sort();
  const lines = [
    `# ${projection.title}`,
    "",
    projection.summary,
    "",
    `> World: \`${compiled.worldId}\`  `,
    `> Contract: \`${compiled.contract.hash}\`  `,
    `> Run: \`${autonomous.run.manifest.runId}\`  `,
    `> State: \`${autonomous.run.finalStateHash}\``,
    "",
    ...projection.sections.flatMap((section) => [
      `## ${section.heading}`,
      "",
      ...section.paragraphs.flatMap((paragraph) => [paragraph, ""]),
      ...(section.sourceRefs.length ? [`Sources: ${section.sourceRefs.map((ref) => `\`${ref}\``).join(", ")}`, ""] : []),
    ]),
    "## Unresolved uncertainty",
    "",
    ...(unresolvedUncertainty.length ? unresolvedUncertainty.map((item) => `- ${item}`) : ["- No explicit unresolved uncertainty was recorded for this selected history."]),
    "",
    "## Provenance manifest",
    "",
    `- Contract hash: \`${compiled.contract.hash}\``,
    `- Initial state hash: \`${compiled.instance.initialStateHash}\``,
    `- Final state hash: \`${autonomous.run.finalStateHash}\``,
    `- Input hash: \`${autonomous.run.manifest.inputHash}\``,
    `- Trace hash: \`${autonomous.run.traceHash}\``,
    `- Guidance ids: ${autonomous.run.manifest.guidanceIds.length ? autonomous.run.manifest.guidanceIds.map((id) => `\`${id}\``).join(", ") : "none"}`,
    "",
  ];
  const markdown = lines.join("\n");
  const projectionHash = hash(projection);
  const core = {
    worldId: compiled.worldId,
    id: `export:${compiled.worldId}:${hash({ runId: autonomous.run.manifest.runId, projectionHash, markdown }).slice(0, 20)}`,
    runId: autonomous.run.manifest.runId,
    contractHash: compiled.contract.hash,
    filename: `${safeFilename(projection.title)}-${autonomous.run.manifest.runId.slice(-8)}.md`,
    markdown,
    contentHash: hash(markdown),
    manifest: {
      sourceStateHash: autonomous.run.finalStateHash,
      ...(autonomous.run.manifest.branchId ? { branchId: autonomous.run.manifest.branchId } : {}),
      guidanceIds: autonomous.run.manifest.guidanceIds,
      unresolvedUncertainty,
      projectionHash,
    },
  } as const;
  return Object.freeze(core);
}
