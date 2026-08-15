#!/usr/bin/env node

/**
 * THROWAWAY PROTOTYPE — delete this terminal shell after Proof 01A answers its
 * learning question. The portable state transition lives in model.ts.
 */

import {
  createInitialState,
  DEFAULT_FOCUS_RESIDENT_ID,
  focusResident,
  summarizeState,
} from "./model.ts";

const TARGET_RESIDENT_ID = DEFAULT_FOCUS_RESIDENT_ID;

const ansi = {
  clear: "\x1b[2J\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
} as const;

type PrototypeState = ReturnType<typeof createInitialState>;
type PrototypeSummary = ReturnType<typeof summarizeState>;
type CheckStatus = "PASS" | "FAIL" | "PENDING";

interface PrototypeCheck {
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function number(summary: PrototypeSummary, key: string): number {
  const value = record(summary)?.[key];
  return typeof value === "number" ? value : Number.NaN;
}

function checks(
  baseline: PrototypeSummary,
  current: PrototypeSummary,
): readonly PrototypeCheck[] {
  const promoted = number(current, "promotionCount") > 0;
  const lastPromotion = record(record(current)?.lastPromotion);
  const repeat = promoted
    ? summarizeState(focusResident(createInitialState(), TARGET_RESIDENT_ID))
    : undefined;

  const residentCount = number(current, "residentCount");
  const populationReconciles =
    residentCount === number(baseline, "residentCount") &&
    number(current, "residualCount") + number(current, "detailedCount") === residentCount;

  const totalGrain = number(current, "totalGrain");
  const grainReconciles =
    totalGrain === number(baseline, "totalGrain") &&
    number(current, "residualGrain") + number(current, "detailedGrain") === totalGrain;

  const historyUnchanged =
    record(current)?.historyHash === record(baseline)?.historyHash &&
    number(current, "historyEventCount") === number(baseline, "historyEventCount");

  return [
    {
      label: "stable identity",
      status: promoted
        ? lastPromotion?.residentId === TARGET_RESIDENT_ID ? "PASS" : "FAIL"
        : "PENDING",
      detail: promoted
        ? `focused ${String(lastPromotion?.residentId ?? "unknown")}`
        : `press [f] to focus ${TARGET_RESIDENT_ID}`,
    },
    {
      label: "population reconciliation",
      status: populationReconciles ? "PASS" : "FAIL",
      detail: `${number(current, "residualCount")} residual + ${number(current, "detailedCount")} detailed = ${residentCount}`,
    },
    {
      label: "grain reconciliation",
      status: grainReconciles ? "PASS" : "FAIL",
      detail: `${number(current, "residualGrain")} residual + ${number(current, "detailedGrain")} detailed = ${totalGrain}`,
    },
    {
      label: "committed history unchanged",
      status: historyUnchanged ? "PASS" : "FAIL",
      detail: `${number(current, "historyEventCount")} events; baseline hash retained`,
    },
    {
      label: "same-input repetition",
      status: promoted
        ? record(repeat)?.projectionHash === record(current)?.projectionHash ? "PASS" : "FAIL"
        : "PENDING",
      detail: promoted
        ? "fresh initial state + same focus produced the same projection hash"
        : "checked after the first focus",
    },
  ];
}

function plainCheck(check: PrototypeCheck): string {
  return `[${check.status}] ${check.label}: ${check.detail}`;
}

function styledCheck(check: PrototypeCheck): string {
  const color = check.status === "PASS"
    ? ansi.green
    : check.status === "FAIL"
      ? ansi.red
      : ansi.yellow;
  return `${color}[${check.status}]${ansi.reset} ${ansi.bold}${check.label}${ansi.reset}: ${check.detail}`;
}

function styledJson(value: unknown): readonly string[] {
  return JSON.stringify(value, null, 2).split("\n").map((line) =>
    line.replace(
      /^(\s*)"([^"]+)":/,
      `$1${ansi.bold}$2${ansi.reset}:`,
    )
  );
}

function runDemo(): void {
  const beforeState = createInitialState();
  const before = summarizeState(beforeState);
  const after = summarizeState(focusResident(beforeState, TARGET_RESIDENT_ID));

  process.stdout.write([
    "THROWAWAY PROTOTYPE — Proof 01A population focus promotion",
    `Target: ${TARGET_RESIDENT_ID}`,
    "",
    "=== BEFORE ===",
    JSON.stringify(before, null, 2),
    "",
    `=== FOCUS ${TARGET_RESIDENT_ID} ===`,
    JSON.stringify(after, null, 2),
    "",
    "=== CHECKS ===",
    ...checks(before, after).map(plainCheck),
    "",
  ].join("\n"));
}

function runInteractive(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "Interactive mode needs a TTY. Run with --demo for non-interactive output.\n",
    );
    process.exitCode = 2;
    return;
  }

  const baselineState = createInitialState();
  const baselineSummary = summarizeState(baselineState);
  let state: PrototypeState = baselineState;
  let note = "Ready. Focus the existing ordinary resident when you want to inspect the transition.";
  let closed = false;

  const render = (): void => {
    const summary = summarizeState(state);
    const frame = [
      `${ansi.bold}THROWAWAY PROTOTYPE — Proof 01A${ansi.reset}`,
      `${ansi.dim}Question: can focus increase one existing resident's resolution without rewriting the world?${ansi.reset}`,
      `${ansi.dim}Target: ${TARGET_RESIDENT_ID}${ansi.reset}`,
      "",
      `${ansi.bold}Current relevant state${ansi.reset}`,
      ...styledJson(summary),
      "",
      `${ansi.bold}Visible invariants${ansi.reset}`,
      ...checks(baselineSummary, summary).map(styledCheck),
      "",
      `${ansi.dim}${note}${ansi.reset}`,
      "",
      `${ansi.bold}[f]${ansi.reset} ${ansi.dim}focus resident${ansi.reset}  ` +
        `${ansi.bold}[r]${ansi.reset} ${ansi.dim}reset in memory${ansi.reset}  ` +
        `${ansi.bold}[q]${ansi.reset} ${ansi.dim}quit${ansi.reset}`,
    ];
    process.stdout.write(`${ansi.clear}${ansi.hideCursor}${frame.join("\n")}\n`);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    process.stdin.off("data", onKey);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${ansi.showCursor}\n`);
  };

  const onKey = (input: string): void => {
    if (input === "q" || input === "\u0003") {
      close();
      return;
    }
    if (input === "f") {
      const prior = state;
      state = focusResident(state, TARGET_RESIDENT_ID);
      note = state === prior
        ? `${TARGET_RESIDENT_ID} was already focused; the transition is idempotent.`
        : `${TARGET_RESIDENT_ID} moved from residual to detailed resolution.`;
      render();
      return;
    }
    if (input === "r") {
      state = createInitialState();
      note = "Reset to the deterministic in-memory fixture.";
      render();
      return;
    }
    note = `Unknown key ${JSON.stringify(input)}. Use [f], [r], or [q].`;
    render();
  };

  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onKey);
  process.once("exit", () => process.stdout.write(ansi.showCursor));
  render();
}

function usage(): void {
  process.stdout.write([
    "THROWAWAY Proof 01A terminal prototype",
    "",
    "Usage:",
    "  node src/prototypes/proof01a/cli.ts         # interactive TUI",
    "  node src/prototypes/proof01a/cli.ts --demo  # before -> focus snapshot",
    "",
  ].join("\n"));
}

const [option] = process.argv.slice(2);
if (option === "--demo") runDemo();
else if (option === "--help" || option === "-h") usage();
else if (option === undefined) runInteractive();
else {
  usage();
  process.exitCode = 2;
}
