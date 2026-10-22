# Bases duration reference and implementation — 2026-10-22

Owner: `bases_inline_core`; branch `codex/bases-durations`, isolated worktree
`.worktrees/bases-durations`; baseline `2f0d77a4d255d7290be090d1450d8c5f62576eef`.
Scope: Q3 G8 in `bases-expression-completion-audit-20261022.md`. The coordinator
owns composition, independent review, serialized Rust checks and actual runtime
acceptance. This record is source evidence, not a runtime parity claim.

## Pinned shipped source

The user-selected cached Obsidian 1.14.4 archive is
`~/Library/Application Support/obsidian/obsidian-1.14.4.asar`, SHA-256
`146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`.
Its `app.js` SHA-256 is
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
Recovered implementation stays outside the repository in private temporary
reference directories. No reference application or selected JavaScript was run.

REA analysis parent
`ev_add5e54ca4125579c2fe99c3806085085bc4a62b10d2588d6e8d0c8ba467dd8b`
parsed three inert selected files: 6,103 bytes, 1,868 AST nodes, zero parse
failures. Semantic graph analysis was bounded to 900 nodes total and 350 per
file, and is partial/truncated; unselected classes and calls are not recovered
by that graph. The source observations below also use the exact selected
expressions, rather than treating graph absence as proof.

All ranges are Python Unicode character offsets, end-exclusive, in that exact
`app.js` (not byte or JavaScript UTF-16 offsets):

| Selection | Range | Extract SHA-256 |
| --- | --- | --- |
| Duration class `CK` | 2204003–2207169 | `dccf9885bc6c1b4d5436b5616e5d8ce73a07564ada460917eca29bcb20b1043e` |
| Arithmetic dispatch `DQ` | 2330159–2331867 | `cada02e91b5240cc8495e775f54a4338cea767f73454cd04a7bdabb893b32403` |
| Relational dispatch `TQ` | 2328947–2330158 | `5f25ad0053184f5d8f7b52ccdc57b2ce023beace5790ca2e9ae2484ac8648691` |

The same archive's `lib/moment.min.js` identifies Moment 2.30.1; SHA-256
`b19e17770b1673aca44065e7dc2c393d306559871b99bfe885a0d10d4f2798cf`.
REA parent
`ev_b5d0cf5c04419ad46e372bf9a5f846fd8843880add8b5b83f80e6b11eeac46f5`
parsed two inert selections, 701 bytes, 270 AST nodes, zero parse failures,
without reaching the semantic-node limit:

| Selection | Range | Extract SHA-256 |
| --- | --- | --- |
| Fractional month difference | 28463–28689 | `af2a4c39138a9dc674771a3b02a8d8968153e220c71a5eebe0a17ae354591b67` |
| Unit difference dispatch | 33321–33783 | `dcb3e85c1043634f036821ba09fd26c1c256c90078f3eb23953e4fbbfc1da683` |

The local fractional month interpolation adapts the MIT-licensed
[Moment 2.30.1 diff implementation](https://github.com/moment/moment/blob/2.30.1/src/lib/moment/diff.js).
The full notice is retained in `crates/zorid-bases/LICENSE-MOMENT`, with
provenance in `UPSTREAM.md`. There is no new dependency. The primary
[Moment documentation](https://momentjs.com/docs/) and
[guides](https://momentjs.com/guides/) support the distinction between local
calendar arithmetic, elapsed time, and fractional month differences.

## Observed duration contract

- Simple syntax is a complete, case-sensitive signed integer followed by one
  supported unit, optionally separated by one ASCII space. `M` means months;
  `m` means minutes. Fractions, compound expressions, extra whitespace, a leading
  plus sign and embedded matches do not satisfy the expression. Millisecond
  branches exist in the shipped parser but are unreachable through its simple
  regular expression; `1ms` is therefore rejected.
- The shipped ISO-like matcher is unanchored and requires `T`, even without time
  components. Components use integer-prefix conversion (`P1.9YT` has one year).
  `PT` produces zero. Weeks are folded into days. A matched component starting
  with punctuation produces a nonfinite component; Zorid retains its D2 numeric
  diagnostic instead of admitting a nonfinite result. These are recorded source
  rules, not a claim of standards-compliant general ISO 8601 parsing.
- Truthiness checks stored components for nonzero values. Canceling components
  may be truthy even when their elapsed result is zero.
- Duration multiplication and division by a Number preserve Duration components.
  Duration addition/subtraction are component-wise. Unsupported operand orders
  and modulo remain diagnostic. Division by zero retains the finite guard.
- Date addition runs local setters sequentially: years, months, days, hours,
  minutes, seconds, milliseconds. Each complete setter argument truncates toward
  zero. Month/year setters overflow their original day rather than clamping it;
  2024-01-31 plus one month becomes 2024-03-02. Combining setters changes results
  and is not equivalent. A nonzero time component marks the result as timed even
  when truncation leaves its instant unchanged.
- Eight fields expose converted totals: years, months, days, weeks, hours,
  minutes, seconds, milliseconds. Keys use that order. Years/months use Moment's
  fractional month interpolation with **clamped interpolation anchors**, which
  is separate from overflowing Date addition. Days/weeks use civil differences;
  smaller units use elapsed milliseconds. Thus a DST calendar day can be 23 or
  25 elapsed hours while its converted days field remains one.
- Loose Duration equality and relational comparisons use calendar elapsed
  milliseconds, including valid duration Strings on the right. Relational
  conversion is asymmetric: a left String is numeric-converted rather than
  duration-parsed. Non-numeric text makes relational predicates false.

## Zorid context, refresh and limits

Every implicit conversion uses the invocation's immutable captured clock and
explicit UTC/fixed/IANA timezone. No ambient `Date`, native local clock, dynamic
filesystem timezone or JavaScript evaluator is introduced. The existing D1
policy remains explicit: nonunique local gap/fold results are diagnostic rather
than guessed using a platform disambiguation. This deliberate portable policy
is not claimed to match every native JavaScript gap/fold result. Numeric and
range failures remain D2 diagnostics. Calendar helpers execute a constant seven
setter steps; interpolation uses at most one symmetry swap and bounded anchors.

Refresh scheduling supplements the existing AST walk with a charged abstract
interpretation. A direct constructor or typed arithmetic is pure; unit-field
access, calendar comparison and list membership become instant-sensitive when
Duration is possible. Unknown formula aliases, computed indexes, current-note
properties, callbacks, unsupported call returns and heterogeneous branches
remain unions rather than false scalar proofs. Callback value/index types use
known receiver elements; reduce uses a finite bit-lattice fixed point with
cooperative work checks. Nested list/computed values conservatively preserve
possible Duration. Unknown member names on a possible Duration are sensitive.
Ordinary proven scalar paths and equality against non-duration literal text
retain clock independence. Incomplete/budget-exhausted analysis is sensitive.
Optional answer reuse also refuses these implicit clock reads, including
call-free formula/property expressions. Captured grouping equality now receives
the same invocation clock; grouping refresh advice is coordinated separately
with the query owner.

The source tests use independent literal clocks and numeric/date expectations:
accepted/rejected simple and ISO-like syntax; all converted fields; zero and
canceling truth; typed arithmetic; January/leap-day sequential overflow;
truncated fractional setters; DST civil versus elapsed units; explicit D1/D2
failures; asymmetric comparison; row duration-scalar agreement; and refresh/cache
analysis through aliases, nested lists, dynamic access, map and reduce. They do
not derive expected output from the implementation or execute recovered code.

## Verification status

Source-only implementation and tests prepared; no Cargo, app, browser, native
host or WASM run has been performed for this duration change. Independent review
and the coordinator's composed checks are required before recording acceptance.
Moment-style humanized output is outside this G8 completion scope and remains
tracked by the separate G9 output audit. Existing broader Bases acceptance does
not establish this new duration behavior.
