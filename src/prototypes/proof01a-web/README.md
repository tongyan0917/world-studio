# THROWAWAY — Proof 01A Visual Prototype

This page asks one question: **which visual structure makes “the same resident becoming more detailed without rewriting the world” easiest to understand?**

It is a disposable UI comparison, not the World Studio product interface. All three options use the same in-memory Proof 01A transition and expose the same conservation checks; only their information structure changes.

## Run

```sh
npm run prototype:proof01a:web
```

Open the local URL printed by the command. The route is `/prototype/proof01a`.

## Three options, one page

Use the high-contrast switcher at the bottom of the page, the left/right arrow keys, or share a URL with `?variant=`:

- `?variant=A` — **Workbench**: an Obsidian-like three-pane workspace. Best for browsing a world, inspecting one resident, and keeping invariants nearby.
- `?variant=B` — **Causal graph**: the transition is a node-and-edge explanation. Best for seeing identity, history, population, and grain dependencies as one causal picture.
- `?variant=C` — **Timeline compare**: before and after are the primary objects. Best for answering exactly what changed and what remained committed.

The variants intentionally disagree about hierarchy. Pick one, or record a concrete mix such as “A’s navigation, B’s causal explanation, C’s before/after checks.” Do not polish all three into permanent surfaces.

## A: independent content views

Variant A is now a routed workspace rather than one long document. The URL keeps
the selected view and the in-memory before/after projection:

- `view=overview` — readable world and crisis brief.
- `view=character` — `resident-0042` plus the committed Mara example from the
  Proof 00 anchored run.
- `view=relationships` — directional membership and committed interaction
  records, without inventing friendship or trust.
- `view=events` — Proof 01A history and the Proof 00 Mara/Ivo/council execution
  chain.
- `view=proof` — the promotion diff, state fingerprints, and five invariants.

Content is visibly classified as committed fact, engine interpretation,
creative draft, unresolved, or author-side operation. The API reads the
committed Proof 00 run artifact and Proof 01A model directly; presentation copy
does not become world-state authority.

## Prototype boundaries

- No persistence or external dependencies.
- No LLM call or new simulation behavior.
- No production route, component system, or visual-design commitment.
- The bottom switcher is prototype chrome, not part of the candidate product UI.

Capture the hands-on verdict in [NOTES.md](./NOTES.md). Once the question is answered, keep the learning and delete or absorb the throwaway page.
