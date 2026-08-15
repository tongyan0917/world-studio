# Proof 01B Prototype Learning Notes

> THROWAWAY artifact. Complete this note from hands-on use, then delete the terminal shell or absorb only the validated protocol idea.

## Question

Does the sequence below make the phase-control boundary understandable and trustworthy?

`Base → boundary completeness → source collection → Frontier → cascade admission → atomic publication → next Base`

In particular, is it obvious that zero closure publishes nothing, failed barriers gain no authority, and only a proven non-empty `B + 1` Frontier stops the Run Incomplete?

## Starting hypothesis

This control slice is sufficient for the next MVP step if it makes five things tangible:

1. boundary obligations and Proposal-source obligations are separate exhaustive layers;
2. the model contributes a recorded Proposal but cannot mutate committed World state;
3. same-time successors require the immediately preceding Receipt and one exact published-output-to-active-input witness;
4. successful atomic publication alone increases receipt-derived cascade depth; and
5. zero closure and `B + 1` failure leave the last committed Base intact for different, visible reasons; and
6. a trust anchor outside candidate state is necessary: content hashes alone cannot prevent an entire internally consistent Run or committed history from being replaced and re-hashed.

The zero/non-empty Result is frozen as part of the source fixture before a Run begins. It is not a checkpoint-time operator choice.

## Mechanical smoke observations

- Date: 2026-08-10
- Command: `npm run prototype:proof01b -- --demo`
- Did scenarios A, B, and C complete? Yes; the additional fail-closed checks in D also completed.
- Did recorded replay reproduce the same projection hash? Yes.
- Did any invariant report `FAIL`? No in the mechanical smoke run.
- Did the retained external authority reject a separately valid alternate Run and a re-hashed output/Bundle/Receipt history? Yes.

Mechanical success answers only whether the sketch executes. It does not answer whether the abstraction feels natural or whether the artifact names are too dense.

## Creator hands-on observations

- Which transition was hardest to understand?
- Was the distinction between boundary accounting and source collection useful or noisy?
- Did the World description make the abstract protocol feel grounded enough?
- Was it clear which data was committed and which was only staged?
- Did the zero-Frontier and Limit-Reached branches feel meaningfully different?
- What important failure or action is missing?

## Verdict

- [ ] Direction is good enough to absorb into the next Proof 01 implementation slice.
- [ ] Revise one named transition and run the prototype again.
- [ ] Reject this control model.

Reason:

## Smallest next constraint, only if observed use requires one

- Observed failure:
- Constraint that directly addresses it:
- Why the MVP cannot proceed without it:

## Disposition

- [ ] Delete the terminal shell; capture the decision in durable design.
- [ ] Lift the validated pure transition logic; delete the terminal shell.
- [ ] Keep temporarily for one named follow-up experiment:
