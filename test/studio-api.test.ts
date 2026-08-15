import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStudioServer, type StudioServerHandle } from "../src/studio/server.ts";
import type { CreatorWorldDefinition } from "../src/studio/types.ts";

function definition(): CreatorWorldDefinition {
  return JSON.parse(readFileSync(new URL("./fixtures/lantern-delta.world.json", import.meta.url), "utf8")) as CreatorWorldDefinition;
}

async function request<T>(handle: StudioServerHandle, path: string, options: RequestInit = {}): Promise<{ status: number; value: T }> {
  const response = await fetch(`${handle.url}${path}`, { headers: { "Content-Type": "application/json", ...(options.headers ?? {}) }, ...options });
  const value = await response.json() as T;
  return { status: response.status, value };
}

test("the loopback public API completes authoring, restart, Wiki, run control, branch queries, and export", async () => {
  const directory = mkdtempSync(join(tmpdir(), "world-studio-api-"));
  const database = join(directory, "world-studio.sqlite");
  let handle: StudioServerHandle | undefined;
  try {
    handle = await createStudioServer({ database, port: 0 });
    assert.equal((await request<{ status: string; worlds: number }>(handle, "/api/health")).value.status, "ready");
    const page = await fetch(`${handle.url}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /World Studio/);

    const incomplete = structuredClone(definition()) as CreatorWorldDefinition & { temporal?: CreatorWorldDefinition["temporal"] };
    delete incomplete.temporal;
    const inspected = await request<{ ready: boolean; questions: { code: string }[] }>(handle, "/api/worlds/inspect", { method: "POST", body: JSON.stringify({ definition: incomplete }) });
    assert.equal(inspected.value.ready, false);
    assert.ok(inspected.value.questions.some((question) => question.code === "temporal-profile-missing"));

    const authored = definition();
    const draft = await request<{ revision: number; status: string }>(handle, `/api/worlds/${authored.worldId}/drafts/${authored.draftId}`, { method: "PUT", body: JSON.stringify({ definition: authored, expectedRevision: 0 }) });
    assert.equal(draft.value.status, "ready");
    const compiled = await request<{ contract: { authority: string; hash: string }; instance: { id: string } }>(handle, `/api/worlds/${authored.worldId}/drafts/${authored.draftId}/compile`, { method: "POST", body: "{}" });
    assert.equal(compiled.value.contract.authority, "accepted");
    const worlds = await request<{ worlds: { worldId: string }[] }>(handle, "/api/worlds");
    assert.deepEqual(worlds.value.worlds.map((world) => world.worldId), ["world.lantern-delta", "world.salt-marsh", "world.xuanxiao-nine-realms"]);

    await handle.close();
    handle = await createStudioServer({ database, port: 0 });
    const initial = await request<{ graph: { nodes: { id: string }[] }; run?: unknown }>(handle, `/api/worlds/${authored.worldId}/workspace`);
    assert.ok(initial.value.graph.nodes.some((node) => node.id === "person:ilyra-veen"));
    assert.equal(initial.value.run, undefined);
    const drafts = await request<{ drafts: { revision: number; definitionHash: string }[] }>(handle, `/api/worlds/${authored.worldId}/drafts`);
    assert.equal(drafts.value.drafts[0]?.revision, 1);

    const gates = await request<{ revision: number }>(handle, `/api/worlds/${authored.worldId}/wiki/western-gates`, { method: "PUT", body: JSON.stringify({ title: "Western Gates", markdown: "# Western Gates\n\nHinge evidence remains uncertain. #risk", expectedRevision: 0 }) });
    assert.equal(gates.value.revision, 1);
    await request(handle, `/api/worlds/${authored.worldId}/wiki/repair-compact`, { method: "PUT", body: JSON.stringify({ title: "Repair Compact", markdown: "# Repair Compact\n\nCoordinates work on [[Western Gates]]. #institution", expectedRevision: 0 }) });
    const gatePage = await request<{ backlinks: { title: string }[] }>(handle, `/api/worlds/${authored.worldId}/wiki/western-gates`);
    assert.deepEqual(gatePage.value.backlinks.map((item) => item.title), ["Repair Compact"]);
    const searched = await request<{ pages: { title: string }[] }>(handle, `/api/worlds/${authored.worldId}/wiki?q=${encodeURIComponent("coordinates institution")}`);
    assert.deepEqual(searched.value.pages.map((item) => item.title), ["Repair Compact"]);

    const started = await request<{ id: string; status: string; revision: number }>(handle, `/api/worlds/${authored.worldId}/runs`, { method: "POST", body: JSON.stringify({ seed: "fresh-api-acceptance", controlId: "control:fresh-api" }) });
    assert.equal(started.value.status, "running");
    const advanced = await request<{ status: string; nextBoundaryIndex: number }>(handle, `/api/worlds/${authored.worldId}/controls/${encodeURIComponent(started.value.id)}/actions`, { method: "POST", body: JSON.stringify({ action: "advance" }) });
    assert.equal(advanced.value.nextBoundaryIndex, 1);
    const paused = await request<{ status: string }>(handle, `/api/worlds/${authored.worldId}/controls/${encodeURIComponent(started.value.id)}/actions`, { method: "POST", body: JSON.stringify({ action: "pause" }) });
    assert.equal(paused.value.status, "paused");
    const resumed = await request<{ status: string }>(handle, `/api/worlds/${authored.worldId}/controls/${encodeURIComponent(started.value.id)}/actions`, { method: "POST", body: JSON.stringify({ action: "resume" }) });
    assert.equal(resumed.value.status, "running");
    const completed = await request<{ status: string; finalRunId: string }>(handle, `/api/worlds/${authored.worldId}/controls/${encodeURIComponent(started.value.id)}/actions`, { method: "POST", body: JSON.stringify({ action: "run-to-complete" }) });
    assert.equal(completed.value.status, "complete");

    const evolved = await request<{ run: { id: string; closure: { status: string } }; boundaries: unknown[] }>(handle, `/api/worlds/${authored.worldId}/workspace`);
    assert.equal(evolved.value.run.closure.status, "closed");
    assert.equal(evolved.value.boundaries.length, 7);
    const explanation = await request<{ status: string; explanationHash: string }>(handle, `/api/worlds/${authored.worldId}/explain`, { method: "POST", body: JSON.stringify({ runId: completed.value.finalRunId, target: { kind: "node", id: "route:lantern-causeway", fieldId: "maintenance" } }) });
    assert.ok(explanation.value.explanationHash);

    const branchRequest = {
      worldId: authored.worldId,
      id: "request:fresh-api-route",
      parentRunId: completed.value.finalRunId,
      mode: "intervention",
      target: { kind: "node", id: "route:lantern-causeway", fieldId: "maintenance", worldTime: 1100 },
      reason: "Fresh API acceptance changes a causal upstream route field.",
      action: { kind: "set-node-attribute", nodeId: "route:lantern-causeway", fieldId: "maintenance", value: 92 },
    } as const;
    const branched = await request<{ candidateRunId: string; evidenceHash: string; comparison: { protectedPrefixVerified: boolean; changedPaths: string[]; auditChangedPaths: string[] }; interventionInputIds: string[] }>(handle, `/api/worlds/${authored.worldId}/branches`, { method: "POST", body: JSON.stringify({ request: branchRequest }) });
    assert.equal(branched.status, 201);
    assert.equal(branched.value.comparison.protectedPrefixVerified, true);
    assert.ok(branched.value.comparison.changedPaths.length > 0);
    assert.ok(branched.value.comparison.auditChangedPaths.length > 0);
    const impact = await request<{ emissionIds: string[] }>(handle, `/api/worlds/${authored.worldId}/impact`, { method: "POST", body: JSON.stringify({ runId: branched.value.candidateRunId, inputIds: branched.value.interventionInputIds }) });
    assert.ok(impact.value.emissionIds.length > 0);
    const compared = await request<{ protectedPrefixVerified: boolean }>(handle, `/api/worlds/${authored.worldId}/compare`, { method: "POST", body: JSON.stringify({ parentRunId: completed.value.finalRunId, candidateRunId: branched.value.candidateRunId }) });
    assert.equal(compared.value.protectedPrefixVerified, true);

    const exported = await request<{ id: string; filename: string; markdown: string; manifest: { sourceStateHash: string } }>(handle, `/api/worlds/${authored.worldId}/exports`, { method: "POST", body: JSON.stringify({ runId: branched.value.candidateRunId }) });
    assert.match(exported.value.markdown, /# Lantern Delta/);
    assert.match(exported.value.markdown, /## Provenance manifest/);
    const download = await fetch(`${handle.url}/api/worlds/${authored.worldId}/exports/${encodeURIComponent(exported.value.id)}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /attachment/);
    assert.equal(await download.text(), exported.value.markdown);

    const crossWorld = await request<{ error: { message: string } }>(handle, `/api/worlds/world.salt-marsh/branches`, { method: "POST", body: JSON.stringify({ request: branchRequest }) });
    assert.equal(crossWorld.status, 404);
    assert.match(crossWorld.value.error.message, /world scope|parent autonomous run/i);

    await handle.close();
    handle = await createStudioServer({ database, port: 0 });
    const reopened = await request<{ runs: { runId: string }[]; historyEvidence: { evidenceHash: string }[]; wiki: { slug: string }[] }>(handle, `/api/worlds/${authored.worldId}/workspace`);
    assert.ok(reopened.value.runs.some((run) => run.runId === branched.value.candidateRunId));
    assert.ok(reopened.value.historyEvidence.some((item) => item.evidenceHash === branched.value.evidenceHash));
    assert.ok(reopened.value.wiki.some((page) => page.slug === "western-gates"));
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});
