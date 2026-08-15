#!/usr/bin/env node

import { resolve } from "node:path";

import { stableStringify } from "../kernel/stable.ts";
import type { Proof00Action, Proof00WorldState, RunArtifact } from "../kernel/types.ts";
import { readRunArtifact, writeRunArtifact } from "./io.ts";
import {
  replayProof00Artifact,
  runProof00Pair,
  runProof00Variant,
} from "./scenario.ts";
import {
  compareArtifacts,
  explainActorPerspective,
  explainAudit,
  explainWhyNot,
  verifyReplayArtifact,
  type ExplanationTarget,
} from "./views.ts";

function output(value: unknown): void {
  process.stdout.write(`${stableStringify(value)}\n`);
}

function usage(): never {
  process.stderr.write([
    "Engine Proof 00 — Cut-Off Town",
    "",
    "Usage:",
    "  npm run proof00 -- demo [output-directory]",
    "  npm run proof00 -- run <base|anchored> [output-directory]",
    "  npm run proof00 -- replay <run-artifact.json>",
    "  npm run proof00 -- compare <left.json> <right.json>",
    "  npm run proof00 -- explain <artifact.json> <proposal|transition|trace> <id>",
    "  npm run proof00 -- why-not <artifact.json> <proposal-id>",
    "  npm run proof00 -- perspective <artifact.json> <actor-id>",
    "  npm run proof00 -- verify <artifact.json>",
    "",
  ].join("\n"));
  process.exit(2);
}

async function load(path: string | undefined): Promise<RunArtifact<Proof00WorldState, Proof00Action>> {
  if (!path) usage();
  return await readRunArtifact(path) as RunArtifact<Proof00WorldState, Proof00Action>;
}

function target(kind: string | undefined, id: string | undefined): ExplanationTarget {
  if (!id) usage();
  if (kind === "proposal") return { kind: "proposal", id };
  if (kind === "transition") return { kind: "transition", id };
  if (kind === "trace") return { kind: "trace-node", id };
  return usage();
}

async function main(): Promise<void> {
  const [command = "demo", ...args] = process.argv.slice(2);
  if (command === "demo") {
    const directory = resolve(args[0] ?? "runs/proof00");
    const pair = runProof00Pair();
    const [baseFiles, anchoredFiles] = await Promise.all([
      writeRunArtifact(pair.base.artifact, directory),
      writeRunArtifact(pair.anchored.artifact, directory),
    ]);
    output({
      command,
      base: {
        files: baseFiles,
        finalStateHash: pair.base.artifact.finalStateHash,
        reservation: pair.base.reservationDisposition,
      },
      anchored: {
        files: anchoredFiles,
        finalStateHash: pair.anchored.artifact.finalStateHash,
        reservation: pair.anchored.reservationDisposition,
      },
      comparison: compareArtifacts(pair.base.artifact, pair.anchored.artifact),
    });
    return;
  }

  if (command === "run") {
    const variant = args[0];
    if (variant !== "base" && variant !== "anchored") usage();
    const run = runProof00Variant({ variant });
    const files = await writeRunArtifact(run.artifact, resolve(args[1] ?? "runs/proof00"));
    output({ command, variant, files, status: run.artifact.status, finalStateHash: run.artifact.finalStateHash });
    return;
  }

  if (command === "replay") {
    const original = await load(args[0]);
    const replayed = replayProof00Artifact(original);
    output({
      command,
      runId: original.manifest.runId,
      exact: stableStringify(original) === stableStringify(replayed.artifact),
      externalModelCallCount: replayed.externalModelCallCount,
      verification: verifyReplayArtifact(replayed.artifact),
    });
    return;
  }

  if (command === "compare") {
    const [left, right] = await Promise.all([load(args[0]), load(args[1])]);
    output(compareArtifacts(left, right));
    return;
  }

  if (command === "explain") {
    const artifact = await load(args[0]);
    output(explainAudit(artifact, target(args[1], args[2])));
    return;
  }

  if (command === "why-not") {
    const artifact = await load(args[0]);
    if (!args[1]) usage();
    output(explainWhyNot(artifact, args[1]));
    return;
  }

  if (command === "perspective") {
    const artifact = await load(args[0]);
    if (!args[1]) usage();
    output(explainActorPerspective(artifact, args[1]));
    return;
  }

  if (command === "verify") {
    output(verifyReplayArtifact(await load(args[0])));
    return;
  }

  usage();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
