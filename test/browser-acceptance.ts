import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createStudioServer } from "../src/studio/server.ts";

const CHROME_CANDIDATES = [
  process.env.WORLD_STUDIO_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((candidate): candidate is string => Boolean(candidate));

interface CdpResponse {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: { readonly message: string };
  readonly params?: unknown;
}

class CdpClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly #events = new Map<string, unknown[]>();
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse;
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (message.method) this.#events.set(message.method, [...(this.#events.get(message.method) ?? []), message.params]);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) pending.reject(new Error("Chrome DevTools connection closed"));
      this.#pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Cannot connect to Chrome DevTools at ${url}`)), { once: true });
    });
    return new CdpClient(socket);
  }

  async command(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  events(method: string): readonly unknown[] { return this.#events.get(method) ?? []; }
  close(): void { this.#socket.close(); }
}

function chromeExecutable(): string {
  const executable = CHROME_CANDIDATES.find(existsSync);
  if (!executable) throw new Error("Chrome or Chromium is required. Set WORLD_STUDIO_CHROME to its executable path.");
  return executable;
}

async function devtoolsUrl(process: ChildProcess, timeoutMs = 15_000): Promise<string> {
  let output = "";
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Chrome did not expose DevTools within ${timeoutMs}ms\n${output}`)), timeoutMs);
    const consume = (chunk: Buffer | string) => {
      output += String(chunk);
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    process.stdout?.on("data", consume);
    process.stderr?.on("data", consume);
    process.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before DevTools was ready (code ${code})\n${output}`));
    });
  });
}

async function pageSocket(browserSocket: string, expectedUrl: string): Promise<string> {
  const endpoint = new URL(browserSocket);
  const origin = `http://${endpoint.hostname}:${endpoint.port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pages = await fetch(`${origin}/json/list`).then((response) => response.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
    const page = pages.find((candidate) => candidate.type === "page" && candidate.url.startsWith(expectedUrl));
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome did not open ${expectedUrl}`);
}

async function evaluate(client: CdpClient, expression: string): Promise<any> {
  const response = await client.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Browser evaluation failed");
  return response.result?.value;
}

async function waitFor(client: CdpClient, expression: string, label: string, timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await evaluate(client, expression);
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diagnostic = await evaluate(client, `({
    busy: !document.querySelector('#busy')?.classList.contains('hidden'),
    toast: document.querySelector('#toast')?.textContent,
    toastClass: document.querySelector('#toast')?.className,
    view: document.querySelector('.tab.active')?.dataset.view,
    world: document.querySelector('[data-world].active')?.dataset.world,
    wikiTitle: document.querySelector('#wiki-title')?.value,
    wikiSlug: document.querySelector('#wiki-slug')?.value,
    wikiRevision: document.querySelector('#wiki-revision')?.textContent,
  })`);
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)}; browser: ${JSON.stringify(diagnostic)}`);
}

async function click(client: CdpClient, selector: string): Promise<void> {
  const clicked = await evaluate(client, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; if (typeof element.click === 'function') element.click(); else element.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  assert.equal(clicked, true, `missing browser control ${selector}`);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function capture(client: CdpClient, path: string): Promise<{ path: string; sha256: string }> {
  const screenshot = await client.command("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  const bytes = Buffer.from(screenshot.data, "base64");
  writeFileSync(path, bytes);
  return { path, sha256: sha256(bytes) };
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "world-studio-browser-"));
const database = join(temporaryRoot, "studio.sqlite");
const artifactRoot = resolve(flag("--output") ?? "runs/browser-acceptance-latest");
mkdirSync(artifactRoot, { recursive: true });
let server = await createStudioServer({ database, port: 0 });
let chrome: ChildProcess | undefined;
let client: CdpClient | undefined;

try {
  const profile = join(temporaryRoot, "chrome-profile");
  chrome = spawn(chromeExecutable(), [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-features=Translate,OptimizationHints",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    server.url,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const browserSocket = await devtoolsUrl(chrome);
  client = await CdpClient.connect(await pageSocket(browserSocket, server.url));
  await client.command("Runtime.enable");
  await client.command("Page.enable");
  await client.command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  await waitFor(client, "document.readyState === 'complete' && document.querySelectorAll('[data-world]').length >= 2", "seeded World list");
  assert.equal(await evaluate(client, "document.documentElement.lang"), "zh-CN");
  assert.ok(await evaluate(client, "document.querySelector('#graph svg')?.childElementCount > 0"), "graph should render real World data");
  assert.ok(await evaluate(client, "document.querySelector('#map svg')?.childElementCount > 0"), "map should render real World data");

  const initialIdentity = await evaluate(client, "({ worldId: document.querySelector('[data-world].active')?.dataset.world, contract: document.querySelector('#world-kicker')?.textContent })");
  const alternateWorld = await evaluate(client, "Array.from(document.querySelectorAll('[data-world]')).find((element) => element.dataset.world !== document.querySelector('[data-world].active')?.dataset.world)?.dataset.world");
  assert.ok(alternateWorld);
  await click(client, `[data-world=${JSON.stringify(alternateWorld)}]`);
  await waitFor(client, `document.querySelector('[data-world].active')?.dataset.world === ${JSON.stringify(alternateWorld)}`, "alternate World selection");
  assert.notEqual(await evaluate(client, "document.querySelector('#world-kicker')?.textContent"), initialIdentity.contract);
  await click(client, `[data-world=${JSON.stringify(initialIdentity.worldId)}]`);
  await waitFor(client, `document.querySelector('[data-world].active')?.dataset.world === ${JSON.stringify(initialIdentity.worldId)}`, "original World restoration");

  await click(client, "#locale-en");
  await waitFor(client, "document.documentElement.lang === 'en' && localStorage.getItem('world-studio.locale') === 'en'", "persistent English locale");
  await client.command("Page.reload", { ignoreCache: true });
  await waitFor(client, "document.readyState === 'complete' && document.documentElement.lang === 'en' && document.querySelectorAll('[data-world]').length >= 2", "English locale after reload");
  await click(client, "#locale-zh");
  await waitFor(client, "document.documentElement.lang === 'zh-CN'", "Chinese locale restoration");
  await client.command("Page.reload", { ignoreCache: true });
  await waitFor(client, "document.readyState === 'complete' && document.documentElement.lang === 'zh-CN' && document.querySelectorAll('[data-world]').length >= 2", "Chinese locale after reload");

  for (const view of ["timeline", "wiki", "evolve", "history", "author", "explore"]) {
    await click(client, `[data-view=${JSON.stringify(view)}]`);
    await waitFor(client, `!document.querySelector('#view-${view}').classList.contains('hidden')`, `${view} workspace`);
  }

  const definition = JSON.parse(readFileSync(new URL("./fixtures/lantern-delta.world.json", import.meta.url), "utf8"));
  definition.worldId = `world.browser-${Date.now()}`;
  definition.draftId = "draft.browser-acceptance";
  definition.metadata.title = "Browser Acceptance Delta";
  await click(client, "[data-view=\"author\"]");
  await evaluate(client, `(() => { const editor = document.querySelector('#author-json'); editor.value = ${JSON.stringify(JSON.stringify(definition, null, 2))}; editor.dispatchEvent(new Event('input', { bubbles: true })); return editor.value.length; })()`);
  await click(client, "#author-inspect");
  await waitFor(client, "document.querySelector('#author-results .success-card')?.textContent.length > 0", "authoring validation");
  await click(client, "#author-save");
  await waitFor(client, "document.querySelector('#toast')?.textContent.includes('修订')", "draft persistence");
  const savedDrafts = await evaluate(client, `(async () => (await fetch('/api/worlds/${definition.worldId}/drafts')).json())()`);
  assert.equal(savedDrafts.drafts[0].definition.worldId, definition.worldId);
  assert.equal(savedDrafts.drafts[0].revision, 1);
  await click(client, "#author-compile");
  await waitFor(client, `Array.from(document.querySelectorAll('[data-world]')).some((element) => element.dataset.world === ${JSON.stringify(definition.worldId)})`, "compiled World in switcher", 60_000);
  let compiledWorkspace = await evaluate(client, `(async () => (await fetch('/api/worlds/${definition.worldId}/workspace')).json())()`);
  assert.equal(compiledWorkspace.world.worldId, definition.worldId);
  assert.ok(compiledWorkspace.contract.hash, "compiled World should expose an immutable Contract hash");
  const acceptedContractHash = compiledWorkspace.contract.hash;

  const restartPort = Number(new URL(server.url).port);
  await server.close();
  server = await createStudioServer({ database, port: restartPort });
  await client.command("Page.reload", { ignoreCache: true });
  await waitFor(client, `document.readyState === 'complete' && Array.from(document.querySelectorAll('[data-world]')).some((element) => element.dataset.world === ${JSON.stringify(definition.worldId)})`, "compiled World after store restart", 30_000);
  await click(client, `[data-world=${JSON.stringify(definition.worldId)}]`);
  await waitFor(client, `document.querySelector('[data-world].active')?.dataset.world === ${JSON.stringify(definition.worldId)}`, "restarted World selection");
  compiledWorkspace = await evaluate(client, `(async () => (await fetch('/api/worlds/${definition.worldId}/workspace')).json())()`);
  assert.equal(compiledWorkspace.contract.hash, acceptedContractHash);

  await click(client, "[data-view=\"explore\"]");
  await click(client, "#graph [data-entity]");
  await waitFor(client, "document.querySelector('#inspector .attribute-list')?.textContent.length > 0", "entity inspector");

  await click(client, "[data-view=\"wiki\"]");
  await click(client, "#wiki-new");
  await evaluate(client, `(() => {
    document.querySelector('#wiki-title').value = 'Acceptance Notes';
    document.querySelector('#wiki-slug').value = 'acceptance-notes';
    document.querySelector('#wiki-tags').value = 'browser-tag, qa';
    document.querySelector('#wiki-markdown').value = '# Acceptance Notes\\n\\nSee [[World Overview]]. #browser-tag';
    document.querySelector('#wiki-markdown').dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await click(client, "#wiki-save");
  const wikiUiState = await waitFor(client, `(() => {
    const revision = document.querySelector('#wiki-revision')?.textContent ?? '';
    const toast = document.querySelector('#toast');
    if (toast?.classList.contains('error') && !toast.classList.contains('hidden')) return { done: false, error: toast.textContent, revision, slug: document.querySelector('#wiki-slug')?.value };
    return revision.includes('1') ? { done: true, error: '', revision, slug: document.querySelector('#wiki-slug')?.value } : false;
  })()`, "Wiki revision persistence");
  assert.equal(wikiUiState.error, "", `Wiki save failed: ${JSON.stringify(wikiUiState)}`);
  const wikiReadback = await evaluate(client, `(async () => (await fetch('/api/worlds/${definition.worldId}/wiki/acceptance-notes')).json())()`);
  assert.ok(wikiReadback.tags.includes("browser-tag"));
  assert.ok(wikiReadback.links.includes("World Overview"));
  await evaluate(client, `(() => { const input = document.querySelector('#wiki-search'); input.value = 'browser-tag'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await waitFor(client, "document.querySelector('[data-wiki=\"acceptance-notes\"]')", "Wiki tag search");
  await evaluate(client, `(() => { const input = document.querySelector('#wiki-search'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await waitFor(client, "document.querySelector('[data-wiki=\"world-overview\"]')", "Wiki search reset");
  await click(client, "[data-wiki=\"world-overview\"]");
  await waitFor(client, "document.querySelector('#wiki-backlinks')?.textContent.includes('Acceptance Notes')", "Wiki backlink readback");

  await click(client, "[data-view=\"evolve\"]");
  await click(client, "#run-start");
  await waitFor(client, "document.querySelector('#run-status')?.dataset.status === 'running'", "running control");
  await click(client, "#run-step");
  await waitFor(client, "document.querySelector('#run-progress')?.textContent.includes('1 / 7')", "one committed boundary");
  await click(client, "#run-pause");
  await waitFor(client, "document.querySelector('#run-status')?.dataset.status === 'paused'", "safe pause");
  await click(client, "#run-resume");
  await waitFor(client, "document.querySelector('#run-status')?.dataset.status === 'running'", "safe resume");
  await click(client, "#run-complete");
  await waitFor(client, "document.querySelector('#run-status')?.dataset.status === 'complete'", "completed multi-scale run", 90_000);
  assert.ok(await evaluate(client, "document.querySelector('#closure')?.textContent.includes('4/4')"), "four feedback families should close in the rendered workspace");

  await click(client, "[data-view=\"history\"]");
  await evaluate(client, `(() => {
    const object = document.querySelector('#history-object');
    object.value = 'organization:tide-registry';
    object.dispatchEvent(new Event('change', { bubbles: true }));
    const field = document.querySelector('#history-field');
    field.value = 'legitimacy';
    field.dispatchEvent(new Event('change', { bubbles: true }));
    const current = Number(JSON.parse(document.querySelector('#history-value').value));
    document.querySelector('#history-value').value = JSON.stringify(Math.min(100, current + 1));
    return true;
  })()`);
  const completedWorkspace = await evaluate(client, `(async () => (await fetch('/api/worlds/${definition.worldId}/workspace')).json())()`);
  const anchor = completedWorkspace.boundaries[Math.floor(completedWorkspace.boundaries.length / 2)].boundary.worldTime;
  await evaluate(client, `(() => { document.querySelector('#history-time').value = ${JSON.stringify(String(anchor))}; window.__browserAcceptanceResponses = []; const originalFetch = window.fetch.bind(window); window.fetch = async (...args) => { const response = await originalFetch(...args); try { const payload = await response.clone().json(); window.__browserAcceptanceResponses.push({ url: String(args[0]), status: response.status, payload }); } catch {} return response; }; return true; })()`);
  await click(client, "#history-branch");
  await waitFor(client, "document.querySelector('#history-result')?.textContent.includes('因果前缀') && window.__browserAcceptanceResponses.some((item) => item.url.endsWith('/branches') && item.status === 201)", "arbitrary-anchor branch comparison", 90_000);
  const branchEvidence = await evaluate(client, "window.__browserAcceptanceResponses.find((item) => item.url.endsWith('/branches') && item.status === 201).payload");
  assert.equal(branchEvidence.comparison.protectedPrefixVerified, true);
  assert.ok(branchEvidence.comparison.changedPaths.length > 0);
  assert.ok(branchEvidence.impact.emissionIds.length > 0);
  const branchScreenshot = await capture(client, join(artifactRoot, "history-branch.png"));
  await click(client, "#history-explain");
  await waitFor(client, "document.querySelector('#history-result .evidence-block')?.textContent.length > 0", "backward explanation");

  const queryReadback = await evaluate(client, `(async () => {
    const headers = { 'Content-Type': 'application/json' };
    const compare = await fetch('/api/worlds/${definition.worldId}/compare', { method: 'POST', headers, body: JSON.stringify({ parentRunId: ${JSON.stringify(branchEvidence.request.parentRunId)}, candidateRunId: ${JSON.stringify(branchEvidence.candidateRunId)} }) }).then((response) => response.json());
    const impact = await fetch('/api/worlds/${definition.worldId}/impact', { method: 'POST', headers, body: JSON.stringify({ runId: ${JSON.stringify(branchEvidence.candidateRunId)}, inputIds: ${JSON.stringify(branchEvidence.comparison.newExternalInputIds)} }) }).then((response) => response.json());
    const explain = await fetch('/api/worlds/${definition.worldId}/explain', { method: 'POST', headers, body: JSON.stringify({ runId: ${JSON.stringify(branchEvidence.candidateRunId)}, target: { kind: 'node', id: 'organization:tide-registry', fieldId: 'legitimacy' } }) }).then((response) => response.json());
    return { compare, impact, explain };
  })()`);
  assert.equal(queryReadback.compare.protectedPrefixVerified, true);
  assert.ok(queryReadback.impact.emissionIds.length > 0);
  assert.match(decodeURIComponent(queryReadback.explain.targetPath), /organization:tide-registry/);

  const foreignWorld = initialIdentity.worldId === definition.worldId ? alternateWorld : initialIdentity.worldId;
  const isolation = await evaluate(client, `(async () => {
    const run = encodeURIComponent(${JSON.stringify(branchEvidence.candidateRunId)});
    const response = await fetch('/api/worlds/${foreignWorld}/workspace?run=' + run);
    const payload = await response.json();
    return { status: response.status, payload };
  })()`);
  assert.equal(isolation.status, 404);
  assert.match(isolation.payload.error.message, /No autonomous Run/);

  const exported = await evaluate(client, `(async () => { const response = await fetch('/api/worlds/${definition.worldId}/exports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); return response.json(); })()`);
  assert.match(exported.filename, /\.md$/);
  assert.match(exported.markdown, /Browser Acceptance Delta/);

  const screenshots = [];
  for (const view of ["explore", "timeline", "wiki", "evolve", "history", "author"]) {
    await click(client, `[data-view=${JSON.stringify(view)}]`);
    await waitFor(client, `!document.querySelector('#view-${view}').classList.contains('hidden')`, `${view} screenshot view`);
    if (view === "author") {
      await click(client, "#author-load");
      await waitFor(client, "document.querySelector('#author-json')?.value.includes('draft.browser-acceptance')", "saved author draft screenshot");
    }
    screenshots.push(await capture(client, join(artifactRoot, `${view}.png`)));
  }
  screenshots.push(branchScreenshot);

  const exceptions = client.events("Runtime.exceptionThrown");
  assert.deepEqual(exceptions, [], `uncaught browser exceptions: ${JSON.stringify(exceptions)}`);
  const proof = {
    status: "PASS",
    browser: chromeExecutable(),
    worldId: definition.worldId,
    contractHash: compiledWorkspace.contract.hash,
    draftRevision: savedDrafts.drafts[0].revision,
    restartReadback: true,
    runStatus: "complete",
    feedbackFamilies: "4/4",
    branchEvidenceHash: branchEvidence.evidenceHash,
    branchAnchorWorldTime: branchEvidence.anchorWorldTime,
    protectedPrefixVerified: branchEvidence.comparison.protectedPrefixVerified,
    wiki: { slug: wikiReadback.slug, tags: wikiReadback.tags, links: wikiReadback.links, backlinkVerified: true },
    isolationStatus: isolation.status,
    primaryViews: ["explore", "timeline", "wiki", "evolve", "history", "author"],
    screenshots,
  };
  const proofJson = JSON.stringify(proof, null, 2);
  writeFileSync(join(artifactRoot, "browser-proof.json"), `${proofJson}\n`);
  console.log(proofJson);
} finally {
  client?.close();
  if (chrome && chrome.exitCode === null) {
    await new Promise<void>((resolveExit) => {
      const force = setTimeout(() => chrome?.kill("SIGKILL"), 2_000);
      chrome!.once("exit", () => { clearTimeout(force); resolveExit(); });
      chrome!.kill("SIGTERM");
    });
  }
  await server.close();
  rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
