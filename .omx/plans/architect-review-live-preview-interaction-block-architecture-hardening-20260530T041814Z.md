# Architect Review — Live Preview Interaction + Internal Block Architecture Hardening

## Verdict

**APPROVE** — with minor pre-Critic amendments. The plan is architecturally sound and aligns with the constraints: interaction-first, source-backed Live Preview, private-only block architecture, no public plugin API, no tables/properties/Reading parity, and preserving Lezer/no-regex parser ownership.

It is **safe to send to Critic after applying the minor improvements below**; no additional Architect loop is required unless Critic finds a blocking ambiguity.

## Strongest Steelman Antithesis Against Option A

Option A risks under-designing the private block architecture because it lets selection/clipboard tests drive the contract shape incrementally. A registry-first pass could define a coherent internal model for source range, activation range, clipboard behavior, atomic policy, and widget lifecycle before adapting code blocks/callouts. That matters because the current private adapter is still thin: it maps `match → widget range` but does not encode clipboard or atomic policy. So Option A may pass interaction tests while leaving future first-party block families with implicit conventions rather than a clear internal contract.

## Tradeoff Tension

The real tension is **test-grounded minimalism vs. architectural coherence**. Option A correctly avoids premature public API design, but if the private contract remains only `match()` and `widget()`, clipboard/activation/atomic behavior may continue to live as scattered widget-specific code.

## Architecture Risks

### Selection

The plan correctly prioritizes boundary tests for `from`, `to`, `activationFrom`, and `activationTo`. This is necessary because current selection intersection treats an empty cursor as intersecting inclusively through `activationTo`, which is an off-by-one-sensitive policy. The plan should explicitly require expected behavior at “cursor exactly after widget/range end.”

### Clipboard

Current clipboard coverage is helper-level slicing only. The plan recognizes this gap and asks for behavior-level coverage where practical. Minor improvement: make mounted clipboard/output-filter coverage a **required attempted gate**, not merely “where practical,” because CodeMirror exposes `clipboardInputFilter`/`clipboardOutputFilter` for this exact integration surface.

### atomicRanges

The plan is sound in requiring an explicit decision. Current coverage only asserts the production source does not contain `atomicRanges`, which is not behavioral enough. The plan’s required cursor/deletion/pointer tests are the right fix. Note: CodeMirror atomic ranges affect cursor motion/deletion, but not direct programmatic selection updates, so tests must cover both keyboard movement and pointer activation.

### Private Block Registry

The plan preserves private-only scope. That matches current packaging: `@zorid/editor` is private and only exports the root entry, while the live-preview barrel does not export block renderer helpers. Minor risk: tests deep-import `block-renderers.ts` today, so “private” is convention plus package-boundary enforcement, not true module invisibility inside the repo.

## Synthesis / Concrete Improvements

Before Critic, apply these small planning clarifications:

1. **Add a private contract checkpoint** after interaction tests but before refactor: define internal fields for source range, activation range, clipboard source policy, and optional atomic policy. Keep it private.
2. **Strengthen clipboard gate wording**: mounted or filter-level copy/cut behavior must be attempted; helper slicing alone is insufficient final evidence unless documented as a limitation.
3. **Clarify atomic boundary expectations**: include cursor exactly at `activationTo`, delete/backspace at both widget edges, and pointer activation after atomic decision.
4. **Add package-boundary verification**: extend private-registry tests to check `packages/editor/package.json` exports remain root-only, in addition to current barrel checks.

## Root Cause of Remaining Risk

The main residual architectural risk is that Live Preview currently has source-backed rendering pieces, but not yet a single internal policy object for how widgets participate in selection, clipboard, activation, and atomic behavior. The plan identifies that gap and sequences it safely; it just needs the minor clarifications above to prevent “test-first” from becoming “policy-later.”
