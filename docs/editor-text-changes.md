# Mapping selections through external text updates

`src/editor/text-changes.ts` exports `textChanges(previous, next)`. Its sorted,
non-overlapping `{from, to, insert}` edits use UTF-16 offsets and can be passed to
CodeMirror `ChangeSet.of` or a transaction's `changes` field. Equal inputs return
an empty array. Applying the edits reconstructs the next string exactly; the
helper does not normalize line endings or parse Markdown.

The motivating regression was an editor containing `aaa\nKEEP\nzzz`, with its
caret at offset 5. Updating it to `!aaa\nKEEP\nzzz!` previously replaced the whole
document because the update used one common-prefix/suffix envelope. The helper
returns two insertions, so the unchanged middle and its caret map to offset 6.
The same changes can map inactive tabs' saved selections. Neither caller needs
to retain a second document snapshot after mapping.

The implementation scans the equal prefix and suffix, then searches for a short
edit path through the remaining text. It retains typed-array frontiers, not
character arrays, line arrays, or a document-sized edit matrix. The search has
two independent limits:

- At most 128 inserted/deleted UTF-16 units; a replacement counts as deletion
  plus insertion. Trace storage is at most 33,411 Int32 cells, approximately
  131 KiB, plus one 259-cell working frontier.
- At most `4 * (oldMiddleLength + newMiddleLength) + 65,536` frontier/comparison
  steps after the edge scans. Backtracking records only the bounded edits and
  does not scan every matching character again.

Thus scanning/search work is linear in input size with a fixed additive bound,
and search memory is independent of document length. Returned insert strings
are bounded by the new document length. The optional third argument records
`work`, `traceCells`, and `fallback` for deterministic tests; it retains no text.
These are algorithmic counters, not a claim about native typing latency.

When either search limit is exceeded, the helper returns the exact trimmed
replacement. Carets inside that replaced middle can then collapse according
to CodeMirror's normal mapping; prefix and suffix positions still map normally.
This deliberately bounded fallback also applies to sufficiently large separated
edits. Repeated text can admit several equally short alignments; the helper uses
a deterministic deletion-first tie, without claiming to infer editing intent.
Adjacent edits are coalesced and valid surrogate pairs are kept together. It
does not infer grapheme-cluster boundaries beyond surrogate pairs.

`tests/text-changes.test.ts` checks the original selection regression, separated
deletions/replacements, repeated text, directional multi-selections, multiline
and Unicode input, all pairs of short binary strings, and seeded mixed Unicode
strings including unpaired surrogates. Large fixtures assert exact output,
middle-caret preservation, and deterministic work/memory limits instead of
wall-clock thresholds. These helper tests do not establish native UI parity.
