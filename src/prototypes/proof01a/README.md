# THROWAWAY — Proof 01A Terminal Prototype

This is deliberately disposable code for one learning question:

> Can focus increase the Simulation Resolution of an already-existing ordinary resident without creating a replacement person, double-counting population or grain, or rewriting committed World history?

It is a walking skeleton, not a proposed product interface or production architecture. The terminal shell should be deleted once the question is answered; only validated state-transition ideas should be absorbed into the real engine.

## Run it

Interactive, one-screen terminal:

```sh
node src/prototypes/proof01a/cli.ts
```

Non-interactive before-to-focus demonstration:

```sh
node src/prototypes/proof01a/cli.ts --demo
```

The demo form is useful for review and automated smoke checks because it exits after printing the initial state, the focused state, and every visible invariant.

## Controls

- `f` — focus the existing `resident-0042`
- `r` — reset the deterministic in-memory fixture
- `q` — quit

Every action redraws the complete relevant state. Pressing `f` repeatedly is intentionally idempotent: it cannot create another resident or debit aggregate state twice.

The first focus also realizes exactly one prototype-only detail, `currentConcern`, from the resident's already committed quarter and the town's grain-shortage context. This intentionally crude field exists only to make “more detail” observable; whether it is too shallow or too presumptive is part of the experiment.

## What is visible

- the full summary before and after focus;
- the resident, residual, and detailed population counts;
- residual, detailed, and total grain;
- committed World-history count and hash;
- the last focus-promotion record and projection hash;
- checks for stable identity, population and grain reconciliation, unchanged history, and deterministic repetition.

All state lives in memory. There is no persistence, LLM call, recursive neighbor expansion, generic dependency engine, or creator-facing UI. Those are outside this prototype's question.

Record what the interaction teaches in [NOTES.md](./NOTES.md), then delete the shell or absorb the smallest validated transition into Proof 01A.
