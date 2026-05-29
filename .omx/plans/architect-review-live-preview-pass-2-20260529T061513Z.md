# Architect Review — Live Preview Pass 2

Verdict: APPROVE
Date: 2026-05-29T06:15:13Z

## Summary

The PRD/test spec are implementation-ready and correctly sequence Live Preview Pass 2 around source-backed task toggling, Markdown keymap confidence, and one tiny replace-preview primitive before block widgets/tables/properties. No blocking principle violations found; the main repair note is to keep the replace-preview slice fixed and tripwire-based so execution does not drift.

## Strongest Steelman Antithesis

The strongest counterargument is: Pass 2 should skip replace-preview entirely and focus only on task toggle plus keymap hardening. Replace decorations can introduce cursor/selection complexity before parser-backed matching exists, and an ambiguous inline-code-or-heading choice could create executor ambiguity. Since source-backed task interaction alone already proves transaction/history safety, a stricter pass could defer syntax hiding until after more parser/mapping fixtures.

## Tradeoff Tension

| Option | Pros | Cons |
|---|---|---|
| Task toggle + keymap only | Lowest risk; directly addresses the known styling-only task gap | Leaves current Live Preview mark-only architecture untested for syntax hiding |
| Current PRD: task toggle + keymap + one replace-preview slice | Proves the next renderer capability while still bounded | Requires careful selection/reveal tests and a fixed tiny target |
| Jump to widgets | More visually impressive | Contradicts research sequence and increases selection/history risk |

## Synthesis / Minimal Repair

Approve the plan, but execution should treat inactive inline-code delimiter hiding as the default replace-preview target. Use heading marker hiding only if inline-code delimiter tests fail on a documented brittleness reason. This preserves the plan's capability proof while preventing open-ended renderer exploration.

## Principle Violations

None blocking.

Watch item: avoid promising protection against an intentional external overwrite unless implementation adds explicit versioning. The right pass-2 claim is that stale external replacement does not echo as a user edit and silent external `setText()` behavior remains guarded.

## Concrete Review Notes

1. Approve Option A as the recommended next pass; it matches research-backed order and current context.
2. Keep command-first task toggle; click handling should remain optional/deferred unless it stays transaction-backed and small.
3. Do not add custom Enter/Backspace behavior without a failing test; verify existing Markdown keymap behavior first.
4. Fix the replace-preview target during execution kickoff: inline-code delimiter hiding first, heading marker only as documented fallback.
5. Preserve internal API boundary; no platform/public renderer API in this pass.
