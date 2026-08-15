#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { hash } from "../kernel/stable.ts";
import { createStudioServer, type StudioServerHandle } from "./server.ts";
import type { CreatorWorldDefinition, StudioBranchRequest } from "./types.ts";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function absolute(value: string): string { return isAbsolute(value) ? value : resolve(value); }

const outputDirectory = absolute(flag("--output") ?? `runs/acceptance-fresh-${Date.now()}`);
const browserProofPath = flag("--browser-proof") ? absolute(flag("--browser-proof")!) : undefined;
const browserProof = browserProofPath ? JSON.parse(readFileSync(browserProofPath, "utf8")) as { status?: string; worldId?: string; screenshots?: readonly unknown[] } : undefined;
if (browserProof && (browserProof.status !== "PASS" || !browserProof.worldId || !browserProof.screenshots?.length)) throw new Error(`Browser proof ${browserProofPath} is incomplete`);
mkdirSync(dirname(outputDirectory), { recursive: true });
mkdirSync(outputDirectory);
const database = resolve(outputDirectory, "world-studio.sqlite");

function saveJson(name: string, value: unknown): string {
  const path = resolve(outputDirectory, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

async function request<T>(handle: StudioServerHandle, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${handle.url}${path}`, { headers: { "Content-Type": "application/json", ...(options.headers ?? {}) }, ...options });
  const payload = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} failed (${response.status}): ${payload.error?.message ?? JSON.stringify(payload)}`);
  return payload;
}

async function completeRun(handle: StudioServerHandle, worldId: string, seed: string, options: { readonly pauseResume?: boolean; readonly controlId: string }) {
  const started = await request<any>(handle, `/api/worlds/${worldId}/runs`, { method: "POST", body: JSON.stringify({ seed, controlId: options.controlId }) });
  let control = started;
  if (options.pauseResume) {
    control = await request<any>(handle, `/api/worlds/${worldId}/controls/${encodeURIComponent(control.id)}/actions`, { method: "POST", body: JSON.stringify({ action: "advance" }) });
    control = await request<any>(handle, `/api/worlds/${worldId}/controls/${encodeURIComponent(control.id)}/actions`, { method: "POST", body: JSON.stringify({ action: "pause" }) });
    if (control.status !== "paused") throw new Error(`${worldId} did not pause at its committed boundary`);
    control = await request<any>(handle, `/api/worlds/${worldId}/controls/${encodeURIComponent(control.id)}/actions`, { method: "POST", body: JSON.stringify({ action: "resume" }) });
  }
  control = await request<any>(handle, `/api/worlds/${worldId}/controls/${encodeURIComponent(control.id)}/actions`, { method: "POST", body: JSON.stringify({ action: "run-to-complete" }) });
  if (control.status !== "complete" || !control.finalRunId) throw new Error(`${worldId} did not complete: ${JSON.stringify(control.failure ?? control.status)}`);
  const workspace = await request<any>(handle, `/api/worlds/${worldId}/workspace?run=${encodeURIComponent(control.finalRunId)}`);
  if (workspace.run?.closure?.status !== "closed") throw new Error(`${worldId} causal closure is not closed`);
  return { control, workspace };
}

let handle: StudioServerHandle | undefined;
try {
  handle = await createStudioServer({ database, port: 0 });
  const initialHealth = await request<any>(handle, "/api/health");
  if (initialHealth.worlds !== 2) throw new Error(`Fresh demo seed expected 2 Worlds, found ${initialHealth.worlds}`);

  const definition = JSON.parse(readFileSync(new URL("../../test/fixtures/lantern-delta.world.json", import.meta.url), "utf8")) as CreatorWorldDefinition;
  const incomplete = structuredClone(definition) as CreatorWorldDefinition & { temporal?: CreatorWorldDefinition["temporal"] };
  delete incomplete.temporal;
  const inspection = await request<any>(handle, "/api/worlds/inspect", { method: "POST", body: JSON.stringify({ definition: incomplete }) });
  if (!inspection.questions.some((question: any) => question.code === "temporal-profile-missing")) throw new Error("Missing temporal premise did not produce a structured question");
  const draft = await request<any>(handle, `/api/worlds/${definition.worldId}/drafts/${definition.draftId}`, { method: "PUT", body: JSON.stringify({ definition, expectedRevision: 0 }) });
  const accepted = await request<any>(handle, `/api/worlds/${definition.worldId}/drafts/${definition.draftId}/compile`, { method: "POST", body: "{}" });
  const worlds = await request<any>(handle, "/api/worlds");
  if (worlds.worlds.length !== 3) throw new Error("Authored acceptance World was not isolated beside both demos");

  await request(handle, `/api/worlds/${definition.worldId}/wiki/western-gates`, { method: "PUT", body: JSON.stringify({ title: "Western Gates", markdown: "# Western Gates\n\nInspection confidence is bounded. #infrastructure #uncertainty", expectedRevision: 0 }) });
  await request(handle, `/api/worlds/${definition.worldId}/wiki/repair-compact`, { method: "PUT", body: JSON.stringify({ title: "Repair Compact", markdown: "# Repair Compact\n\nCoordinates public work on [[Western Gates]]. #institution", expectedRevision: 0 }) });
  const backlinks = await request<any>(handle, `/api/worlds/${definition.worldId}/wiki/western-gates`);
  const search = await request<any>(handle, `/api/worlds/${definition.worldId}/wiki?q=${encodeURIComponent("public institution")}`);

  const salt = await completeRun(handle, "world.salt-marsh", "fresh:salt", { controlId: "control:fresh:salt" });
  const xuanxiao = await completeRun(handle, "world.xuanxiao-nine-realms", "fresh:xuanxiao", { controlId: "control:fresh:xuanxiao" });
  const lantern = await completeRun(handle, definition.worldId, "fresh:lantern", { pauseResume: true, controlId: "control:fresh:lantern" });
  const parentRunId = lantern.control.finalRunId as string;

  const positiveRequest: StudioBranchRequest = {
    worldId: definition.worldId, id: "request:acceptance:route-maintenance", parentRunId, mode: "intervention",
    target: { kind: "node", id: "route:lantern-causeway", fieldId: "maintenance", worldTime: 1100 },
    reason: "Acceptance tests a causal upstream maintenance commitment.",
    action: { kind: "set-node-attribute", nodeId: "route:lantern-causeway", fieldId: "maintenance", value: 92 },
  };
  const negativeRequest: StudioBranchRequest = {
    worldId: definition.worldId, id: "request:acceptance:display-name", parentRunId, mode: "intervention",
    target: { kind: "node", id: "person:ilyra-veen", fieldId: "name", worldTime: 1100 },
    reason: "Acceptance negative control changes a display-only field.",
    action: { kind: "set-node-attribute", nodeId: "person:ilyra-veen", fieldId: "name", value: "Ilyra Veen — archive alias" },
  };
  const guidanceRequest: StudioBranchRequest = {
    worldId: definition.worldId, id: "request:acceptance:resilience-guidance", parentRunId, mode: "soft-guidance",
    target: { kind: "node", id: "organization:tide-registry", worldTime: 1100 },
    reason: "Acceptance explores resilience without prescribing an outcome.",
    prompt: "Prefer plausible paths that reveal whether distributed maintenance authority becomes resilient.",
    permittedLevers: ["organization strategy", "information sharing"], protectedFacts: ["fact:western-gate-wear"], forbiddenEffects: ["guaranteed success", "unearned consensus"],
  };
  const positive = await request<any>(handle, `/api/worlds/${definition.worldId}/branches`, { method: "POST", body: JSON.stringify({ request: positiveRequest }) });
  const negative = await request<any>(handle, `/api/worlds/${definition.worldId}/branches`, { method: "POST", body: JSON.stringify({ request: negativeRequest }) });
  const guidance = await request<any>(handle, `/api/worlds/${definition.worldId}/branches`, { method: "POST", body: JSON.stringify({ request: guidanceRequest }) });
  if (!positive.comparison.protectedPrefixVerified || positive.comparison.changedPaths.length === 0 || positive.impact.emissionIds.length === 0) throw new Error("Positive branch lacks protected-prefix causal impact");
  if (JSON.stringify(negative.comparison.changedPaths) !== JSON.stringify(["/nodes/person%3Ailyra-veen/attributes/name"]) || negative.comparison.impactedEmissionIds.length !== 0) throw new Error("Irrelevant-input negative control produced causal descendants");
  if (guidance.interventionInputIds.length !== 0 || !guidance.unresolvedUncertainty.some((value: string) => value.includes("does not guarantee"))) throw new Error("Soft guidance acquired state authority or hid its uncertainty");

  const explanation = await request<any>(handle, `/api/worlds/${definition.worldId}/explain`, { method: "POST", body: JSON.stringify({ runId: positive.candidateRunId, target: { kind: "node", id: "route:lantern-causeway", fieldId: "maintenance" } }) });
  const impact = await request<any>(handle, `/api/worlds/${definition.worldId}/impact`, { method: "POST", body: JSON.stringify({ runId: positive.candidateRunId, inputIds: positive.interventionInputIds }) });
  const comparison = await request<any>(handle, `/api/worlds/${definition.worldId}/compare`, { method: "POST", body: JSON.stringify({ parentRunId, candidateRunId: positive.candidateRunId }) });
  const exported = await request<any>(handle, `/api/worlds/${definition.worldId}/exports`, { method: "POST", body: JSON.stringify({ runId: positive.candidateRunId }) });
  const settingBookPath = resolve(outputDirectory, exported.filename);
  writeFileSync(settingBookPath, exported.markdown);

  await handle.close();
  handle = await createStudioServer({ database, port: 0 });
  const reopenedHealth = await request<any>(handle, "/api/health");
  const reopened = await request<any>(handle, `/api/worlds/${definition.worldId}/workspace?run=${encodeURIComponent(positive.candidateRunId)}`);
  if (!reopened.historyEvidence.some((item: any) => item.evidenceHash === positive.evidenceHash)) throw new Error("History evidence did not survive restart");
  if (!reopened.wiki.some((page: any) => page.slug === "western-gates")) throw new Error("Wiki did not survive restart");
  if (hash(exported.markdown) !== exported.contentHash) throw new Error("Export content hash is invalid");

  const evidencePaths = {
    definition: saveJson("creator-definition.json", definition),
    structuredQuestions: saveJson("structured-questions.json", inspection),
    acceptedWorld: saveJson("accepted-world.json", { draft, contract: accepted.contract, instance: accepted.instance }),
    threeWorldRuns: saveJson("three-world-runs.json", [salt, xuanxiao, lantern].map(({ workspace }) => ({ world: workspace.world, contract: workspace.contract, instance: workspace.instance, run: workspace.run, boundaryCount: workspace.boundaries.length }))),
    positiveBranch: saveJson("positive-branch.json", positive),
    negativeControl: saveJson("negative-control.json", negative),
    guidanceBranch: saveJson("guidance-branch.json", guidance),
    queries: saveJson("causal-queries.json", { explanation, impact, comparison }),
    wiki: saveJson("wiki-readback.json", { backlinks, search }),
    restart: saveJson("restart-readback.json", { health: reopenedHealth, world: reopened.world, contract: reopened.contract, instance: reopened.instance, run: reopened.run, runs: reopened.runs, branches: reopened.branches, historyEvidenceHashes: reopened.historyEvidence.map((item: any) => item.evidenceHash), wiki: reopened.wiki }),
    settingBook: settingBookPath,
    database,
  };
  const manifestCore = {
    status: "accepted",
    generatedBy: "World Studio fresh acceptance v1",
    serverUrlForBrowser: handle.url,
    schemaVersion: reopenedHealth.schemaVersion,
    worlds: worlds.worlds.map((world: any) => world.worldId),
    criteria: {
      authorableGenericWorld: { pass: true, worldId: definition.worldId, questionCount: inspection.questions.length, contractHash: accepted.contract.hash, instanceId: accepted.instance.id },
      rigorousEngineClosure: { pass: true, runs: [salt, xuanxiao, lantern].map(({ workspace }) => ({ worldId: workspace.world.worldId, runId: workspace.run.id, stateHash: workspace.run.stateHash, auditHash: workspace.run.closure.auditHash, dimensions: workspace.run.closure.activatedDimensions.length, scales: workspace.run.closure.scalesActivated.length, feedbackFamilies: workspace.run.closure.loops.filter((loop: any) => loop.closed).length })) },
      richHybridEvolution: { pass: true, pausedAndResumed: true, boundaryCount: lantern.workspace.boundaries.length, modelAuthority: "proposal-only with deterministic fallback/replay" },
      branchableExplainableHistory: { pass: true, parentRunId, positiveRunId: positive.candidateRunId, negativeRunId: negative.candidateRunId, guidanceRunId: guidance.candidateRunId, protectedPrefix: comparison.protectedPrefixVerified, positiveImpactedEmissions: impact.emissionIds.length, negativeImpactedEmissions: negative.comparison.impactedEmissionIds.length },
      completeCreatorWorkspace: {
        pass: true,
        health: reopenedHealth.status,
        wikiBacklinks: backlinks.backlinks.length,
        wikiSearchResults: search.pages.length,
        exportId: exported.id,
        exportHash: exported.contentHash,
        browserProof: browserProofPath ? { status: "verified", path: browserProofPath, proofHash: hash(browserProof), worldId: browserProof!.worldId, screenshotCount: browserProof!.screenshots!.length } : { status: "separate-command", command: "npm run test:browser" },
      },
    },
    evidencePaths,
  } as const;
  const manifest = { ...manifestCore, manifestHash: hash(manifestCore) };
  const manifestPath = saveJson("acceptance-manifest.json", manifest);
  console.log(JSON.stringify({ status: "accepted", outputDirectory, manifestPath, database, browserUrl: handle.url, manifestHash: manifest.manifestHash }, null, 2));
} catch (error) {
  saveJson("acceptance-failure.json", { status: "failed", error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) });
  throw error;
} finally {
  if (handle) await handle.close().catch(() => undefined);
}
