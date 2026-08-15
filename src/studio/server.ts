#!/usr/bin/env node

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteWorldStore } from "../world-model/store.ts";
import { blankCreatorWorldTemplate, StudioService } from "./service.ts";
import type { CreatorWorldDefinition, StudioBranchRequest } from "./types.ts";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const staticFiles = new Map([
  ["/", { url: new URL("./web/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
  ["/index.html", { url: new URL("./web/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
  ["/app.js", { url: new URL("./web/app.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
  ["/i18n.js", { url: new URL("./web/i18n.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { url: new URL("./web/styles.css", import.meta.url), type: "text/css; charset=utf-8" }],
]);

function headers(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function send(request: IncomingMessage, response: ServerResponse, status: number, type: string, body: string | Buffer): void {
  headers(response);
  response.statusCode = status;
  response.setHeader("Content-Type", type);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(request.method === "HEAD" ? undefined : body);
}

function json(request: IncomingMessage, response: ServerResponse, status: number, value: unknown): void {
  send(request, response, status, "application/json; charset=utf-8", JSON.stringify(value));
}

async function body<T>(request: IncomingMessage): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("Request body exceeds 4 MiB");
    chunks.push(value);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function parts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

export interface StudioServerHandle {
  readonly server: Server;
  readonly service: StudioService;
  readonly store: SqliteWorldStore;
  readonly url: string;
  close(): Promise<void>;
}

export async function createStudioServer(options: { readonly database?: string; readonly port?: number; readonly seedDemos?: boolean } = {}): Promise<StudioServerHandle> {
  const database = options.database ?? ".world-studio/world-studio.sqlite";
  if (database !== ":memory:") mkdirSync(dirname(resolve(database)), { recursive: true });
  const store = new SqliteWorldStore(database);
  const service = new StudioService(store);
  if (options.seedDemos !== false) await service.seedDemoWorlds();

  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", `http://${HOST}`);
      const route = parts(url.pathname);
      if (url.pathname.startsWith("/api/")) {
        if (method === "GET" && url.pathname === "/api/health") return json(request, response, 200, { status: "ready", schemaVersion: store.schemaVersion(), worlds: service.listWorlds().length });
        if (method === "GET" && url.pathname === "/api/worlds") return json(request, response, 200, { worlds: service.listWorlds() });
        if (method === "GET" && url.pathname === "/api/templates/world") return json(request, response, 200, { definition: blankCreatorWorldTemplate(url.searchParams.get("worldId") ?? undefined, url.searchParams.get("title") ?? undefined) });
        if (method === "POST" && url.pathname === "/api/worlds/inspect") {
          const input = await body<{ definition: CreatorWorldDefinition }>(request);
          return json(request, response, 200, service.inspectDefinition(input.definition));
        }

        if (route[0] === "api" && route[1] === "worlds" && route[2]) {
          const worldId = route[2];
          if (method === "GET" && route[3] === "workspace" && route.length === 4) return json(request, response, 200, service.workspace(worldId, url.searchParams.get("run") ?? undefined));
          if (method === "GET" && route[3] === "drafts" && route.length === 4) return json(request, response, 200, { drafts: store.listWorldDrafts(worldId) });
          if (method === "GET" && route[3] === "drafts" && route[4] && route.length === 5) {
            const draft = store.loadWorldDraft(worldId, route[4]);
            return draft ? json(request, response, 200, draft) : json(request, response, 404, { error: { code: "not-found", message: "Creator draft not found" } });
          }
          if (method === "PUT" && route[3] === "drafts" && route[4] && route.length === 5) {
            const input = await body<{ definition: CreatorWorldDefinition; expectedRevision: number }>(request);
            if (input.definition.worldId !== worldId || input.definition.draftId !== route[4]) throw new Error("Draft URL and definition identity do not match");
            return json(request, response, 200, service.saveDefinition(input.definition, input.expectedRevision));
          }
          if (method === "POST" && route[3] === "drafts" && route[4] && route[5] === "compile" && route.length === 6) {
            const compiled = await service.compileSavedDefinition(worldId, route[4]);
            return json(request, response, 200, { worldId, contract: compiled.contract, instance: compiled.instance });
          }
          if (method === "POST" && route[3] === "runs" && route.length === 4) {
            const input = await body<{ seed?: string; calendarStartYear?: number; focusSubjectIds?: readonly string[]; controlId?: string }>(request);
            const control = service.startRun(worldId, { seed: required(input.seed, "seed"), ...(input.calendarStartYear === undefined ? {} : { calendarStartYear: input.calendarStartYear }), ...(input.focusSubjectIds ? { focusSubjectIds: input.focusSubjectIds } : {}), ...(input.controlId ? { controlId: input.controlId } : {}) });
            return json(request, response, 201, control);
          }
          if (method === "POST" && route[3] === "controls" && route[4] && route[5] === "actions" && route.length === 6) {
            const input = await body<{ action: "advance" | "pause" | "resume" | "run-to-complete" }>(request);
            return json(request, response, 200, await service.actOnRun(worldId, route[4], input.action));
          }
          if (method === "POST" && route[3] === "branches" && route.length === 4) {
            const input = await body<{ request: StudioBranchRequest }>(request);
            return json(request, response, 201, await service.branch(worldId, input.request));
          }
          if (method === "POST" && route[3] === "explain" && route.length === 4) {
            const input = await body<{ runId: string; target: { kind: "node" | "edge" | "fact"; id: string; fieldId?: string } }>(request);
            return json(request, response, 200, service.explain(worldId, input.runId, input.target));
          }
          if (method === "POST" && route[3] === "impact" && route.length === 4) {
            const input = await body<{ runId: string; inputIds: readonly string[] }>(request);
            return json(request, response, 200, service.impact(worldId, input.runId, input.inputIds));
          }
          if (method === "POST" && route[3] === "compare" && route.length === 4) {
            const input = await body<{ parentRunId: string; candidateRunId: string }>(request);
            return json(request, response, 200, service.compare(worldId, input.parentRunId, input.candidateRunId));
          }
          if (route[3] === "wiki") {
            if (method === "GET" && route.length === 4) return json(request, response, 200, { pages: url.searchParams.has("q") ? store.searchWikiPages(worldId, url.searchParams.get("q") ?? "") : store.listWikiPages(worldId) });
            if (method === "GET" && route[4] && route.length === 5) {
              const page = store.loadWikiPage(worldId, route[4]);
              return page ? json(request, response, 200, page) : json(request, response, 404, { error: { code: "not-found", message: "Wiki page not found" } });
            }
            if (method === "PUT" && route[4] && route.length === 5) {
              const input = await body<{ title: string; markdown: string; tags?: readonly string[]; expectedRevision: number }>(request);
              return json(request, response, 200, service.saveWiki(worldId, { slug: route[4], title: input.title, markdown: input.markdown, ...(input.tags ? { tags: input.tags } : {}) }, input.expectedRevision));
            }
          }
          if (method === "POST" && route[3] === "exports" && route.length === 4) {
            const input = await body<{ runId?: string }>(request);
            return json(request, response, 201, service.export(worldId, input.runId));
          }
          if (method === "GET" && route[3] === "exports" && route[4] && route[5] === "download") {
            const value = store.loadSettingBookExport(worldId, route[4]);
            if (!value) return json(request, response, 404, { error: { code: "not-found", message: "Export not found" } });
            response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(value.filename)}`);
            return send(request, response, 200, "text/markdown; charset=utf-8", value.markdown);
          }
        }
        return json(request, response, 404, { error: { code: "not-found", message: `No API route ${method} ${url.pathname}` } });
      }

      const asset = staticFiles.get(url.pathname);
      if (!asset || !["GET", "HEAD"].includes(method)) return send(request, response, 404, "text/plain; charset=utf-8", "Not found");
      return send(request, response, 200, asset.type, await readFile(asset.url));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not found|no .* exists|no accepted/i.test(message) ? 404 : /conflict/i.test(message) ? 409 : 400;
      return json(request, response, status, { error: { code: status === 409 ? "revision-conflict" : status === 404 ? "not-found" : "invalid-request", message } });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, HOST, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Studio server did not bind a TCP address");
  return {
    server,
    service,
    store,
    url: `http://${HOST}:${address.port}`,
    close: async () => {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      store.close();
    },
  };
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  const portValue = flag("--port") ?? process.env.PORT;
  const port = portValue === undefined ? DEFAULT_PORT : Number(portValue);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Port must be an integer from 0 to 65535");
  const handle = await createStudioServer({ database: flag("--db") ?? process.env.WORLD_STUDIO_DB, port });
  console.log(`World Studio ready at ${handle.url}`);
  console.log(`Database: ${flag("--db") ?? process.env.WORLD_STUDIO_DB ?? ".world-studio/world-studio.sqlite"}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void handle.close().finally(() => process.exit(0)));
}
