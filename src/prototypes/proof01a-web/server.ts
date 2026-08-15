#!/usr/bin/env node

/**
 * THROWAWAY PROTOTYPE — local web shell for Proof 01A.
 *
 * Keep this server deliberately small: it exposes one deterministic API
 * snapshot and two explicitly allow-listed static assets. It is not a general
 * static-file server and is not intended for deployment.
 */

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createInitialState,
  DEFAULT_FOCUS_RESIDENT_ID,
  focusResident,
  summarizeState,
} from "../proof01a/model.ts";
import {
  applyAction as applyProof01BAction,
  createProof01BSession,
  summarizeState as summarizeProof01BState,
  type Proof01BAction,
  type Proof01BSession,
} from "../proof01b-causal-phase/model.ts";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;

const PAGE_URL = new URL("./index.html", import.meta.url);
const PROOF01B_PAGE_URL = new URL("../proof01b-web/index.html", import.meta.url);
const PROOF00_RUN_URL = new URL(
  "../../../runs/proof00/run_proof00_anchored_v1.run.json",
  import.meta.url,
);

const STATIC_ASSETS = new Map<string, { readonly url: URL; readonly contentType: string }>([
  [
    "/app.js",
    {
      url: new URL("./app.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/styles.css",
    {
      url: new URL("./styles.css", import.meta.url),
      contentType: "text/css; charset=utf-8",
    },
  ],
  [
    "/prototype/proof01b/app.js",
    {
      url: new URL("../proof01b-web/app.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/prototype/proof01b/styles.css",
    {
      url: new URL("../proof01b-web/styles.css", import.meta.url),
      contentType: "text/css; charset=utf-8",
    },
  ],
]);

type Proof01BPreset = "limit" | "zero-after-two";

interface Proof01BWebSession {
  engine: Proof01BSession;
  revision: number;
  preset: Proof01BPreset;
  createdAt: number;
  lastSeenAt: number;
}

const PROOF01B_SESSION_HEADER = "x-proof01b-session";
const PROOF01B_SESSION_TTL_MS = 30 * 60 * 1_000;
const PROOF01B_MAX_SESSIONS = 64;
const PROOF01B_MAX_BODY_BYTES = 8 * 1_024;
const proof01bSessions = new Map<string, Proof01BWebSession>();

const baselineState = createInitialState();
const proof00Run = JSON.parse(await readFile(PROOF00_RUN_URL, "utf8"));
const apiPayload = JSON.stringify({
  targetResidentId: DEFAULT_FOCUS_RESIDENT_ID,
  targetResidentRecord: baselineState.residents[DEFAULT_FOCUS_RESIDENT_ID],
  worldHistory: baselineState.worldHistory,
  anchoredRun: {
    manifest: proof00Run.manifest,
    status: proof00Run.status,
    finalState: proof00Run.finalState,
  },
  before: summarizeState(baselineState),
  after: summarizeState(
    focusResident(baselineState, DEFAULT_FOCUS_RESIDENT_ID),
  ),
});

function configuredPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`PORT must be an integer from 1 to 65535; received ${JSON.stringify(value)}`);
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`PORT must be an integer from 1 to 65535; received ${JSON.stringify(value)}`);
  }
  return port;
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  );
}

function send(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string | Buffer,
): void {
  setCommonHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(request.method === "HEAD" ? undefined : body);
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  send(
    request,
    response,
    statusCode,
    "application/json; charset=utf-8",
    JSON.stringify(value),
  );
}

function proof01bEngineFor(preset: Proof01BPreset): Proof01BSession {
  return createProof01BSession({
    sourceOutcomes: preset === "zero-after-two"
      ? ["non-empty", "non-empty", "zero"]
      : ["non-empty", "non-empty", "non-empty"],
  });
}

function cleanupProof01BSessions(now = Date.now(), reserveSlot = false): void {
  for (const [id, entry] of proof01bSessions) {
    if (now - entry.lastSeenAt > PROOF01B_SESSION_TTL_MS) proof01bSessions.delete(id);
  }
  const retainedLimit = reserveSlot
    ? PROOF01B_MAX_SESSIONS - 1
    : PROOF01B_MAX_SESSIONS;
  while (proof01bSessions.size > retainedLimit) {
    const oldest = [...proof01bSessions.entries()]
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)[0];
    if (!oldest) break;
    proof01bSessions.delete(oldest[0]);
  }
}

function createProof01BWebSession(preset: Proof01BPreset): {
  readonly id: string;
  readonly entry: Proof01BWebSession;
} {
  cleanupProof01BSessions(Date.now(), true);
  const now = Date.now();
  const id = randomUUID();
  const entry: Proof01BWebSession = {
    engine: proof01bEngineFor(preset),
    revision: 0,
    preset,
    createdAt: now,
    lastSeenAt: now,
  };
  proof01bSessions.set(id, entry);
  return { id, entry };
}

function proof01BControls(state: Proof01BSession["state"]): readonly {
  readonly action: Proof01BAction["type"];
  readonly label: string;
  readonly enabled: boolean;
  readonly kind: "primary" | "step" | "test";
}[] {
  const mode = state.attempt.mode;
  const running = state.run.status === "running";
  return [
    {
      action: "complete-boundary",
      label: "核对因果边界",
      enabled: running && mode === "boundary-open",
      kind: "step",
    },
    {
      action: "collect-frontier",
      label: "收集世界响应",
      enabled: running && mode === "source-collection",
      kind: "step",
    },
    {
      action: "admit",
      label: "申请同时间推进",
      enabled: running && mode === "frontier-frozen" &&
        state.attempt.frontier?.kind === "non-empty",
      kind: "step",
    },
    {
      action: "prepare",
      label: "准备世界变更",
      enabled: running && mode === "admitted",
      kind: "step",
    },
    {
      action: "publish",
      label: "写入世界历史",
      enabled: running && mode === "ready",
      kind: "primary",
    },
    {
      action: "arm-barrier-failure",
      label: "令下一次写入失败",
      enabled: running && mode === "ready" && !state.failNextBarrier,
      kind: "test",
    },
  ];
}

function proof01BSnapshot(
  id: string,
  entry: Proof01BWebSession,
): Record<string, unknown> {
  const state = entry.engine.state;
  const summary = summarizeProof01BState(state);
  const controls = proof01BControls(state);
  const recommended = controls.find((control) =>
    control.enabled && control.action !== "arm-barrier-failure"
  ) ?? null;
  return {
    schemaVersion: "proof01b-web-v1",
    session: {
      id,
      revision: entry.revision,
      preset: entry.preset,
      ephemeral: true,
      createdAt: entry.createdAt,
    },
    authority: {
      runCommitmentId: entry.engine.trustAnchor.runCommitmentId,
      committedAuthorityHash: entry.engine.trustAnchor.committedAuthorityHash,
    },
    run: summary.run,
    base: summary.committedBase,
    phase: {
      ...(summary.currentPhase as Record<string, unknown>),
      boundaryObligations: state.attempt.boundaryObligations,
      boundaryAnswers: state.attempt.boundaryAnswers,
      boundarySelectionId: state.attempt.boundarySelection?.id ?? null,
      boundarySelection: state.attempt.boundarySelection,
      sourceObligations: state.attempt.sourceObligations,
      sourceResults: state.attempt.sourceResults,
      continuationClaims: state.attempt.continuationClaims,
      proposals: state.attempt.proposals,
      stagedResult: state.attempt.stagedResult,
      plan: state.attempt.plan,
      candidate: state.attempt.candidate?.base ?? null,
      bundle: state.attempt.bundle,
      failNextBarrier: state.failNextBarrier,
    },
    model: {
      ...(summary.modelFixture as Record<string, unknown>),
      ledger: state.modelLedger,
    },
    publication: {
      ...(summary.publication as Record<string, unknown>),
      receipts: state.receipts,
      bundles: state.publishedBundles,
      emptyClosures: state.emptyClosures,
    },
    checks: summary.checks,
    lastAction: summary.lastAction,
    projectionHash: summary.projectionHash,
    controls,
    recommendedAction: recommended?.action ?? null,
  };
}

function requestSessionId(request: IncomingMessage): string | null {
  const value = request.headers[PROOF01B_SESSION_HEADER];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function getProof01BWebSession(request: IncomingMessage): {
  readonly id: string;
  readonly entry: Proof01BWebSession;
} | null {
  cleanupProof01BSessions();
  const id = requestSessionId(request);
  if (!id) return null;
  const entry = proof01bSessions.get(id);
  if (!entry) return null;
  entry.lastSeenAt = Date.now();
  return { id, entry };
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new TypeError("Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > PROOF01B_MAX_BODY_BYTES) throw new RangeError("Request body is too large");
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function proof01BAction(value: unknown): Proof01BAction | null {
  switch (value) {
    case "complete-boundary":
    case "admit":
    case "prepare":
    case "arm-barrier-failure":
    case "publish":
      return { type: value };
    case "collect-frontier":
      return { type: "collect-frontier" };
    default:
      return null;
  }
}

function methodNotAllowed(
  request: IncomingMessage,
  response: ServerResponse,
  allow: string,
): void {
  response.setHeader("Allow", allow);
  send(request, response, 405, "text/plain; charset=utf-8", "Method Not Allowed\n");
}

async function handleProof01BApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  if (!sameOrigin(request)) {
    sendJson(request, response, 403, { error: "origin_not_allowed" });
    return;
  }

  if (pathname === "/api/proof01b/session") {
    if (request.method !== "POST") {
      methodNotAllowed(request, response, "POST");
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(request, response, error instanceof RangeError ? 413 : 400, {
        error: "invalid_request",
        message: error instanceof Error ? error.message : "Invalid request body",
      });
      return;
    }
    const preset = body.preset === "zero-after-two" ? "zero-after-two" :
      body.preset === undefined || body.preset === "limit" ? "limit" : null;
    if (!preset) {
      sendJson(request, response, 400, { error: "unknown_preset" });
      return;
    }
    const created = createProof01BWebSession(preset);
    sendJson(request, response, 201, proof01BSnapshot(created.id, created.entry));
    return;
  }

  const resolved = getProof01BWebSession(request);
  if (!resolved) {
    sendJson(request, response, 404, {
      error: "session_missing",
      message: "The ephemeral Proof 01B session is missing or expired.",
    });
    return;
  }

  if (pathname === "/api/proof01b/snapshot") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      methodNotAllowed(request, response, "GET, HEAD");
      return;
    }
    sendJson(request, response, 200, proof01BSnapshot(resolved.id, resolved.entry));
    return;
  }

  if (pathname !== "/api/proof01b/action" && pathname !== "/api/proof01b/reset") {
    sendJson(request, response, 404, { error: "not_found" });
    return;
  }
  if (request.method !== "POST") {
    methodNotAllowed(request, response, "POST");
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(request, response, error instanceof RangeError ? 413 : 400, {
      error: "invalid_request",
      message: error instanceof Error ? error.message : "Invalid request body",
    });
    return;
  }
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== resolved.entry.revision) {
    sendJson(request, response, 409, {
      error: "stale_revision",
      currentRevision: resolved.entry.revision,
      snapshot: proof01BSnapshot(resolved.id, resolved.entry),
    });
    return;
  }

  if (pathname === "/api/proof01b/action") {
    const action = proof01BAction(body.action);
    if (!action) {
      sendJson(request, response, 400, { error: "unknown_action" });
      return;
    }
    resolved.entry.engine = applyProof01BAction(resolved.entry.engine, action);
    resolved.entry.revision += 1;
    resolved.entry.lastSeenAt = Date.now();
    sendJson(request, response, 200, proof01BSnapshot(resolved.id, resolved.entry));
    return;
  }

  const requestedPreset = body.preset;
  const preset: Proof01BPreset | null = requestedPreset === "same"
    ? resolved.entry.preset
    : requestedPreset === "limit" || requestedPreset === "zero-after-two"
      ? requestedPreset
      : null;
  if (!preset) {
    sendJson(request, response, 400, { error: "unknown_preset" });
    return;
  }
  resolved.entry.engine = proof01bEngineFor(preset);
  resolved.entry.preset = preset;
  resolved.entry.revision += 1;
  resolved.entry.lastSeenAt = Date.now();
  sendJson(request, response, 200, proof01BSnapshot(resolved.id, resolved.entry));
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (pathname.startsWith("/api/proof01b/")) {
    await handleProof01BApi(request, response, pathname);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    methodNotAllowed(request, response, "GET, HEAD");
    return;
  }

  if (pathname === "/") {
    setCommonHeaders(response);
    response.statusCode = 302;
    response.setHeader("Location", "/prototype/proof01a");
    response.end();
    return;
  }

  if (pathname === "/prototype/proof01a") {
    try {
      send(
        request,
        response,
        200,
        "text/html; charset=utf-8",
        await readFile(PAGE_URL),
      );
    } catch (error) {
      console.error("Unable to read prototype page:", error);
      send(request, response, 500, "text/plain; charset=utf-8", "Page unavailable\n");
    }
    return;
  }

  if (pathname === "/prototype/proof01b") {
    try {
      send(
        request,
        response,
        200,
        "text/html; charset=utf-8",
        await readFile(PROOF01B_PAGE_URL),
      );
    } catch (error) {
      console.error("Unable to read Proof 01B prototype page:", error);
      send(request, response, 500, "text/plain; charset=utf-8", "Page unavailable\n");
    }
    return;
  }

  if (pathname === "/api/proof01a") {
    send(request, response, 200, "application/json; charset=utf-8", apiPayload);
    return;
  }

  const asset = STATIC_ASSETS.get(pathname);
  if (asset) {
    try {
      const body = await readFile(asset.url);
      send(request, response, 200, asset.contentType, body);
    } catch (error) {
      console.error(`Unable to read ${pathname}:`, error);
      send(request, response, 500, "text/plain; charset=utf-8", "Asset unavailable\n");
    }
    return;
  }

  send(request, response, 404, "text/plain; charset=utf-8", "Not Found\n");
}

const port = configuredPort(process.env.PORT);
const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    console.error("Unexpected request failure:", error);
    if (!response.headersSent) {
      send(request, response, 500, "text/plain; charset=utf-8", "Internal Server Error\n");
      return;
    }
    response.destroy();
  });
});

server.on("error", (error) => {
  console.error(`Unable to start World Studio prototype server on ${HOST}:${port}:`, error);
  process.exitCode = 1;
});

server.listen(port, HOST, () => {
  console.log(`Proof 01A web prototype: http://${HOST}:${port}/prototype/proof01a`);
  console.log(`Proof 01B web prototype: http://${HOST}:${port}/prototype/proof01b?variant=A`);
});
