import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { stableStringify } from "../kernel/stable.ts";
import type { RunArtifact } from "../kernel/types.ts";

async function writeImmutable(path: string, contents: string): Promise<"created" | "unchanged"> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path, "utf8");
    if (existing !== contents) {
      throw new Error(`Immutable Run artifact already exists with different content: ${path}`);
    }
    return "unchanged";
  }
}

export interface WrittenRunArtifact {
  readonly artifactPath: string;
  readonly tracePath: string;
  readonly manifestPath: string;
  readonly status: "created" | "unchanged";
}

export async function writeRunArtifact(
  artifact: RunArtifact,
  outputDirectory: string,
): Promise<WrittenRunArtifact> {
  const safeName = artifact.manifest.runId.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  const directory = resolve(outputDirectory);
  const artifactPath = join(directory, `${safeName}.run.json`);
  const tracePath = join(directory, `${safeName}.trace.jsonl`);
  const manifestPath = join(directory, `${safeName}.manifest.json`);
  const artifactContents = `${stableStringify(artifact)}\n`;
  const traceContents = artifact.trace.map((node) => stableStringify(node)).join("\n") + "\n";
  const manifestContents = `${stableStringify(artifact.manifest)}\n`;
  const statuses = await Promise.all([
    writeImmutable(artifactPath, artifactContents),
    writeImmutable(tracePath, traceContents),
    writeImmutable(manifestPath, manifestContents),
  ]);
  return {
    artifactPath,
    tracePath,
    manifestPath,
    status: statuses.every((status) => status === "unchanged") ? "unchanged" : "created",
  };
}

export async function readRunArtifact(path: string): Promise<RunArtifact> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as RunArtifact;
}
