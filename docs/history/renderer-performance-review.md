# Renderer work-count review

Independent review of integrated renderer checkpoint `e11fa87`, with the math
queue-cancellation follow-up from the MathJax owner. Tests use real CodeMirror
state/plugins and jsdom; no elapsed-time thresholds or native performance claims.

## Counted results

- A mixed document plus 200 heading/paragraph sections undergoes 20 ordinary
  caret transactions. After parser stabilization: **zero full-tree rediscovery
  calls, zero whole-document string conversions, zero added renderer mounts or
  observers, and zero renderer releases**. The fixture mounts callout, table,
  display math, and embedded resources alongside a fence.
- Six alternating Live construction/destruction and Reading render/disposal
  cycles leave **zero active tracked ResizeObservers or IntersectionObservers**.
  Embedded descendants are released exactly once and every retained Reading
  code-copy button has its callback removed.
- Found an uncancelled MathJax work queue: 16 unique formulas queued behind a
  blocked conversion still performed all 16 conversions after all owners were
  disposed. Stale DOM was already suppressed, but unnecessary engine work remained.
- Owner fix adds active-consumer accounting and immediate cancellation settlement.
  Independent test now drains the queue with an active sentinel: only the
  already-running formula and sentinel convert. Separate test verifies shared
  work survives one cancelled owner and an abandoned formula can be requested
  successfully later.

Run the focused probes with:

```sh
node --test --test-concurrency=1 tests/renderer-performance-review.test.ts tests/renderer-update-budget.test.ts
```

Four probes pass on the reviewed follow-up. Queue tests intentionally fail on
unfixed `e11fa87`; integrate the owner's math-renderer fix with these tests.

## Limits and remaining measurement

The document/tree index may still rebuild after edits or parser advancement.
Selection decoration updates still iterate cached span collections; these probes
establish avoidance of full parsing/string materialization and remounts, not
constant-time selection work. Native scrolling/viewport transitions, measured
frame latency, memory retained by the actual MathJax/Prism engines, IME, and mobile
resource budgets remain unverified. The zero-geometry jsdom shim cannot reproduce
native viewport measurements. Full suites/builds were not run by this lane.
