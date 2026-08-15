# THROWAWAY — Proof 01B Causal-Phase Prototype

This disposable prototype asks one question:

> Can a single-process, in-memory state machine make the accepted Proof 01 control boundary tangible: exhaustive boundary/source accounting freezes a Frontier; a non-empty Frontier requires cascade admission before one atomic publication can activate the next Base; a zero Frontier closes without publication; and a B+1 same-time Frontier stops Incomplete without mutating the last committed Base?

It is an **executable protocol sketch**, not an implementation of ADR-0053 through ADR-0059 and not a proposed creator interface. Its purpose is to expose whether the control flow feels coherent before storage, concurrency, full validation, or product UI make mistakes harder to see.

## Run it

Interactive, single-redraw terminal inspector:

```sh
npm run prototype:proof01b
```

Deterministic review trace:

```sh
npm run prototype:proof01b -- --demo
```

The demo runs three main fixtures:

1. two same-time phases publish successfully, then an exact third non-empty Frontier reaches `B + 1` and stops Incomplete before Stage 1;
2. a zero Frontier at full depth `B` closes normally without Admission, Limit-Reached, or an empty publication; and
3. an injected publication-barrier failure leaves the committed Base and depth unchanged, then retries the same Bundle at the same position.

It also replays the main fixture using the recorded model contributions and compares the complete projection hash.
Additional fail-closed checks remove a required boundary answer, try to replace the committed Budget or future source schedule with another fully valid and re-hashed Run, reclassify a frozen non-empty source Result as zero, rewrite and re-hash a published output or root causal witness, tamper with a candidate World and Bundle binding, and publish a phase with no new causal output. The transition API requires a module-issued authority anchor held outside the candidate state; only accepted publication rotates its committed-authority head. The last case selects the later `T2` Process boundary but stops explicitly because cross-time Process execution is outside this slice.

## Controls

- `b` — answer every frozen causal-boundary obligation and derive the selected boundary plus Proposal-source manifest;
- `g` — collect the Result fixed by this Run's source fixture; it cannot be changed from non-empty to zero at the checkpoint;
- `a` — derive Admission or, only at `B + 1`, Limit-Reached evidence;
- `s` — prepare a private staged result, Plan, candidate Base, and Bundle;
- `c` — attempt the atomic publication barrier;
- `f` — make the next barrier attempt fail without gaining authority;
- `r` — start over with the same deterministic fixture; this is not retry or resume;
- `1` — start a new limit fixture whose first three source Results are non-empty;
- `2` — start a new zero-after-two fixture whose third source Result is frozen as zero before the Run starts;
- `d` — print all demo scenarios and quit;
- `q` — quit.

Switching fixture starts a new Run and receives a new external authority anchor; it is not retry, resume, budget recovery, or a way to reset cascade depth. Illegal actions only update the visible rejection message; they do not advance the protocol or mutate committed World authority.

## What is visible

- the frozen committed Base, World Time, compact World description, active inputs, history, and Receipt lineage;
- the initial Run Commitment plus module-issued external authority head that fixes the Run, branch, Budget, fixture, and current committed-state hash before any action;
- the distinct boundary-source and Proposal-source obligation counts and their explicit answers;
- collection-Quiescence, Frontier, root or exact successor trigger proof, Admission, private staging, Plan, candidate, Bundle, Receipt, empty closure, and Limit-Reached identities;
- a cascade depth derived from successful Receipts rather than an independently mutable counter;
- the fixture model, prompt, schema, raw-output, parsed-output, and input fingerprints;
- checks that a zero Frontier is not an empty publication, a blocked `B + 1` Frontier has no Stage-1 artifacts, and only a successful Receipt activates the next Base.
- fail-closed lineage checks in which Bundle identity covers published output content and Receipt identity covers the exact Run Commitment, Admission, boundary selection, causal proof, outputs, model contributions, and publication metadata.

## Deliberate limits

- in-memory and single-process only;
- one fixed town fixture and one Proposal source per phase;
- a recordable/replayable deterministic model adapter, not a live LLM;
- no database, workers, concurrent attempts, locks, CAS, or durable recovery;
- the authority anchor is an in-process prototype capability, not a durable signature, access-control system, or hostile-storage security mechanism;
- no complete ADR-0056 refinement, ADR-0057/0058 continuation lifecycle, pending-lineage merge, or dormant registration semantics;
- no real coordination, validation, resolution, dependency sealing, phase-composition validator, or full publication artifact schemas;
- no cross-time cascade, budget-recovery Run, resolution change, Mechanism-version change, or Anchored Run;
- no creator-facing UI.

The bounded transition model and its in-process stand-in for an external authoritative head live in `model.ts`; the temporary TUI lives in `cli.ts`. `applyAction(session, action)` is the only exported transition entry point. Record observed use in `NOTES.md`, then delete the shell or absorb only the smallest validated logic into the real Engine Proof.
