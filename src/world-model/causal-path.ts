import type { GraphWorldAction } from "./types.ts";

/** Canonical address of one causally inspectable value in a World Snapshot. */
export interface WorldStateTarget {
  readonly kind: "node" | "edge" | "fact";
  readonly id: string;
  readonly fieldId?: string;
}

function escaped(value: string): string {
  return encodeURIComponent(value);
}

export function worldStateTargetPath(target: WorldStateTarget): string {
  if (target.kind === "fact") {
    if (target.fieldId) throw new Error("Fact targets do not accept fieldId");
    return `/facts/${escaped(target.id)}`;
  }
  const base = `/${target.kind === "node" ? "nodes" : "edges"}/${escaped(target.id)}`;
  return target.fieldId ? `${base}/attributes/${escaped(target.fieldId)}` : base;
}

export function graphActionWritePath(action: GraphWorldAction): string {
  switch (action.kind) {
    case "adjust-node-number":
    case "set-node-attribute": return worldStateTargetPath({ kind: "node", id: action.nodeId, fieldId: action.fieldId });
    case "adjust-edge-number":
    case "set-edge-attribute": return worldStateTargetPath({ kind: "edge", id: action.edgeId, fieldId: action.fieldId });
    case "create-node": return worldStateTargetPath({ kind: "node", id: action.node.id });
    case "create-edge": return worldStateTargetPath({ kind: "edge", id: action.edge.id });
    case "assert-fact": return worldStateTargetPath({ kind: "fact", id: action.fact.id });
  }
}

export function worldObjectParentPath(path: string): string | undefined {
  return /^(\/nodes\/[^/]+|\/edges\/[^/]+)\/attributes\/[^/]+$/.exec(path)?.[1];
}

export function writerForWorldReadPath<T>(writers: ReadonlyMap<string, T>, readPath: string): T | undefined {
  let matched: T | undefined;
  for (const [writePath, writer] of writers) {
    if (writePathCanProduceReadPath(writePath, readPath)) matched = writer;
  }
  return matched;
}

export function isCanonicalWorldStatePath(path: string): boolean {
  const parts = path.split("/");
  try {
    if (parts.length === 3 && parts[1] === "facts" && parts[2]) return worldStateTargetPath({ kind: "fact", id: decodeURIComponent(parts[2]) }) === path;
    if (parts.length === 3 && ["nodes", "edges"].includes(parts[1] ?? "") && parts[2]) return worldStateTargetPath({ kind: parts[1] === "nodes" ? "node" : "edge", id: decodeURIComponent(parts[2]) }) === path;
    if (parts.length === 5 && ["nodes", "edges"].includes(parts[1] ?? "") && parts[2] && parts[3] === "attributes" && parts[4]) return worldStateTargetPath({ kind: parts[1] === "nodes" ? "node" : "edge", id: decodeURIComponent(parts[2]), fieldId: decodeURIComponent(parts[4]) }) === path;
  } catch {
    return false;
  }
  return false;
}

/** Object creation can produce later field reads; a field write cannot claim an aggregate object read. */
export function writePathCanProduceReadPath(writePath: string, readPath: string): boolean {
  return writePath === readPath || readPath.startsWith(`${writePath}/attributes/`);
}
