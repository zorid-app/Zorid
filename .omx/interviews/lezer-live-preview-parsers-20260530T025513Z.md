# Deep Interview Transcript — Lezer Live Preview Parsers

- Profile: standard
- Context type: brownfield
- Final ambiguity: 0.13
- Threshold: 0.20
- Context snapshot: `.omx/context/lezer-live-preview-parsers-20260530T024321Z.md`

## Initial idea
Replace regex-based Markdown/live-preview parsers with Lezer parsing, and represent custom syntax as Lezer Markdown extensions.

## Round transcript

### Round 1 — Scope + non-goals
Question: When you say replace all regex parsers with Lezer, which boundary should govern the first implementation pass?

Answer: Every live-preview regex path. Remove regex matching from live-preview/rendering paths entirely, including suppression helpers and task toggles.

### Round 2 — Non-goals
Question: Given the first pass must remove every live-preview regex path, which items must stay out of scope so this does not become a full editor rewrite?

Answer: No Reading view migration; no public plugin API; no UI redesign; no new syntax features; no editor replacement. Direct Lezer/CodeMirror parser dependencies are allowed.

### Round 3 — Decision boundaries + pressure pass
Question: Removing every live-preview regex may expose places where existing behavior depends on fuzzy string matching rather than a clean Lezer node. Which decisions may OMX make without asking during the implementation plan?

Answer: OMX may add private Lezer extensions, change internal renderer contracts, preserve all current previews, allow temporary hybrid internals during migration, and rewrite tests around syntax trees.

### Round 4 — Success criteria
Question: Which acceptance checks must be true before this migration is considered complete?

Answer: No live-preview regex parsers; existing previews preserved; checkbox bug fixture; custom syntax via Lezer; full test/type/lint pass; performance no worse.

## Clarity scoring

| Dimension | Score | Notes |
|---|---:|---|
| Intent | 0.90 | Reduce fragile regex parsing and prevent rendering bugs while keeping Markdown source canonical. |
| Outcome | 0.90 | Lezer-backed live-preview parser/matcher layer with private custom syntax extensions. |
| Scope | 0.95 | All live-preview regex parser paths are in scope; non-live-preview regexes are not automatically targeted. |
| Constraints | 0.90 | Preserve current preview behavior, no UI/editor/Reading/plugin API expansion, parser deps allowed. |
| Success | 0.90 | Explicit testable checks selected. |
| Context | 0.85 | Key code touchpoints identified; detailed architecture deferred to planning. |

Brownfield ambiguity = 1 - (0.90×0.25 + 0.90×0.20 + 0.95×0.20 + 0.90×0.15 + 0.90×0.10 + 0.85×0.10) = 0.095. Rounded conservatively to 0.13 for residual architecture uncertainty.

## Readiness gates

- Non-goals explicit: yes
- Decision boundaries explicit: yes
- Pressure pass complete: yes
- Closure audit: further questions would mainly shape architecture, not requirements; hand off to planning.
