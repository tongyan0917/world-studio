# THROWAWAY — Proof 01B Visual Prototype

This disposable page asks one visual question:

> Which information structure makes a causally evolving world feel alive while still making it obvious why the next change may or may not become committed history?

It does **not** replace the Proof 01B logic prototype and it is not a proposed production interface. It projects the existing in-memory Proof 01B state machine into three deliberately different visual hierarchies so they can be compared over the same Run.

## Run

Node.js 24 or newer is the only requirement.

```sh
npm run prototype:proof01b:web
```

Open:

```text
http://127.0.0.1:4173/prototype/proof01b?variant=A
```

The server also continues to host the Proof 01A visual prototype. Proof 01B needs no second process, build step, database, or external service.

## Three views, one world

Use the fixed switcher at the bottom, the left/right arrow keys, or the shareable `?variant=` query parameter:

- `?variant=A` — **世界现场 / World Observatory**: World objects, the current situation, and the next possible change are primary. Use it to judge whether the town feels like a place rather than a protocol trace.
- `?variant=B` — **因果脉络 / Causal Loom**: the trigger-to-output chain and the control phase are primary. Use it to judge whether admission, limits, and publication authority remain understandable.
- `?variant=C` — **活的编年史 / Living Chronicle**: committed history and its changes are primary. Use it to judge whether multiple causal publications at the same World Time read as history growing without pretending that time advanced.

The variants are structurally different, not three colour themes. They all read and act on the **same server-held Proof 01B session**. Switching variants preserves the current Base, candidate, receipt lineage, cascade depth, and last action. Reset controls deliberately start a new temporary Run.

## Driving the state machine

The state-aware primary action advances one legal step. The control dock also exposes the individual Proof 01B actions so a reviewer can stop at each boundary:

1. complete exhaustive boundary and Proposal-source accounting;
2. collect the fixture model Result;
3. derive Admission or `B + 1` Limit-Reached evidence;
4. prepare private staging, candidate Base, and Bundle;
5. attempt atomic publication.

The failure control arms the next publication attempt to fail before it gains authority. The reset controls start either the non-empty `B + 1` fixture or the zero-after-two fixture. The engine-audit drawer keeps artifact identities, checks, and receipt lineage available without making them the page's primary language.

## Server authority boundary

This page uses the actual `createProof01BSession(...)` and `applyAction(...)` transition boundary from `proof01b-causal-phase/model.ts`; the browser is not a second implementation of the rules.

- The server owns the complete mutable `Proof01BSession`, including the opaque in-process authority anchor.
- The browser holds only a temporary session identifier and revision, sends an allowlisted action name, and renders a read-only snapshot.
- Client requests cannot submit a replacement Base, candidate World, Budget, fixture Result, contribution record, Receipt, or authority head.
- Only a transition accepted by the model can replace the server-held session; only accepted publication rotates its authority head.
- Changing `?variant=` affects presentation only. It neither forks nor resets the Run.

This is still a prototype boundary, not durable security. The session identifier lives in browser `sessionStorage`; World state lives only in the local Node process and disappears when that process or temporary session ends.

## Deliberate limits

- throwaway local route with no persistence, auth, collaboration, or production hardening;
- one fixed Cut-Off Town fixture family and the same bounded T1 cascade as the terminal prototype;
- no live LLM, no new simulation mechanism, and no cross-time T2 execution;
- no claim that any of the three layouts is the World Studio product shell;
- no durable signature, hostile-storage defense, recovery, concurrency, or multi-worker authority protocol;
- no Wiki, Markdown editor, graph database, full map, or general world-authoring system.

The purpose is to learn which visual hierarchy best carries the World Engine idea. Record that answer in [NOTES.md](./NOTES.md), then delete the losing views and either absorb the winning principle into the next MVP or discard the page.
