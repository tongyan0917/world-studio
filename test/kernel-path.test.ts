import test from "node:test";
import assert from "node:assert/strict";

import { Kernel, type StateAdapter } from "../src/kernel/kernel.ts";
import { hash } from "../src/kernel/stable.ts";
import type { LogicalInstant, StateChange, TransitionProposal } from "../src/kernel/types.ts";

interface State {
  revision: number;
  instant: LogicalInstant;
  nodes: Record<string, { attributes: Record<string, number> }>;
}

const initial: State = { revision: 0, instant: { worldTime: 0, causalPhase: 0 }, nodes: { town: { attributes: { grain: 10, water: 8 } } } };
const adapter: StateAdapter<State> = {
  clone: structuredClone,
  hash,
  read(state, path) {
    if (path === "/nodes/town") return state.nodes.town;
    const match = /^\/nodes\/town\/attributes\/(grain|water)$/.exec(path);
    return match ? state.nodes.town!.attributes[match[1]!] : undefined;
  },
  validatePath: (path) => /^\/nodes\/town(?:\/attributes\/(?:grain|water))?$/.test(path),
  setKernelMeta(state, revision, instant) { state.revision = revision; state.instant = structuredClone(instant); },
  validateInvariants: () => [],
  diffPaths(before, after) {
    return ["grain", "water"].filter((field) => before.nodes.town!.attributes[field] !== after.nodes.town!.attributes[field]).map((field) => `/nodes/town/attributes/${field}`);
  },
};

function kernel(): Kernel<State> {
  return new Kernel(structuredClone(initial), adapter).registerMechanism({
    id: "mechanism.test",
    version: "1",
    capabilities: ["set"],
    actionKinds: ["set"],
    requiredValidators: [],
    requireCausalPathDimensions: true,
    allowedCausalDimensions: ["resource", "population"],
    footprint: (proposal) => [(proposal.action as { path: string }).path],
    apply(proposal, draft) {
      const action = proposal.action as { kind: "set"; path: string; value: number };
      const field = action.path.endsWith("grain") ? "grain" : "water";
      draft.nodes.town!.attributes[field] = action.value;
      return [{ operation: "set", path: action.path, value: action.value, causalDimensions: proposal.causalPathDimensions?.writes.find((binding) => binding.path === action.path)?.dimensions }] as StateChange[];
    },
  });
}

function proposal(instance: Kernel<State>, id: string, readPath: string, writePath: string, instant: LogicalInstant): TransitionProposal<{ kind: "set"; path: string; value: number }> {
  return {
    id,
    source: "mechanism.test",
    version: "1",
    authority: { kind: "mechanism", principalId: "mechanism.test", capability: "set" },
    subjects: ["town"],
    instant,
    causalParents: [],
    readSet: [instance.read(readPath)],
    causalPathDimensions: {
      reads: [{ path: readPath, dimensions: ["population"] }],
      writes: [{ path: writePath, dimensions: ["resource"] }],
    },
    preconditions: [],
    effectScope: { paths: [writePath], entityIds: ["town"] },
    resourceClaims: [],
    permissionClaims: [{ capability: "set", subjectId: "mechanism.test", objectId: "town" }],
    validators: [],
    action: { kind: "set", path: writePath, value: 12 },
  };
}

test("parent and child canonical paths participate in Kernel coordination and invalidation", () => {
  const instance = kernel();
  const instant = { worldTime: 1, causalPhase: 0 };
  const parentReader = proposal(instance, "proposal:parent-read", "/nodes/town", "/nodes/town/attributes/water", instant);
  const childWriter = proposal(instance, "proposal:child-write", "/nodes/town/attributes/grain", "/nodes/town/attributes/grain", instant);
  const result = instance.commitPhase(instant, [parentReader, childWriter]);
  assert.equal(result.transitions.length, 0);
  assert.ok(result.dispositions.every((value) => value.kind === "rejected"));
  assert.ok(result.dispositions.every((value) => value.reasonCode === "missing-explicit-resolver"), JSON.stringify(result.dispositions));

  const next = kernel();
  const heldParentRead = next.read("/nodes/town");
  const write = proposal(next, "proposal:write", "/nodes/town/attributes/grain", "/nodes/town/attributes/grain", instant);
  assert.equal(next.commitPhase(instant, [write]).dispositions[0]?.kind, "accepted");
  assert.notEqual(next.read("/nodes/town").revision, heldParentRead.revision);
});

test("invalid canonical paths and incomplete or unknown dimension bindings fail closed", () => {
  const cases = [
    { id: "bad-path", mutate: (value: ReturnType<typeof proposal>) => ({ ...value, readSet: [{ ...value.readSet[0]!, path: "/nodes/town/attributes/missing" }], causalPathDimensions: { ...value.causalPathDimensions!, reads: [{ path: "/nodes/town/attributes/missing", dimensions: ["population"] }] } }) },
    { id: "missing-binding", mutate: (value: ReturnType<typeof proposal>) => ({ ...value, causalPathDimensions: { ...value.causalPathDimensions!, reads: [] } }) },
    { id: "unknown-dimension", mutate: (value: ReturnType<typeof proposal>) => ({ ...value, causalPathDimensions: { ...value.causalPathDimensions!, writes: [{ path: value.effectScope.paths[0]!, dimensions: ["narrative"] }] } }) },
  ];
  for (const [index, entry] of cases.entries()) {
    const instance = kernel();
    const instant = { worldTime: index + 1, causalPhase: 0 };
    const base = proposal(instance, `proposal:${entry.id}`, "/nodes/town/attributes/grain", "/nodes/town/attributes/grain", instant);
    const result = instance.commitPhase(instant, [entry.mutate(base)]);
    assert.equal(result.transitions.length, 0, entry.id);
    assert.equal(result.dispositions[0]?.kind, "rejected", entry.id);
    assert.match(
      result.dispositions[0]?.reasonCode ?? "",
      /invalid-state-path|missing-causal-path-dimension|unknown-causal-dimension/,
      `${entry.id}:${JSON.stringify({ dispositions: result.dispositions, traceNodes: result.traceNodes })}`,
    );
  }
});
