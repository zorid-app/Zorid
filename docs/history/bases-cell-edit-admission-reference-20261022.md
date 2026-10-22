# Bases cell edit admission reference — 2026-10-22

The inspected Obsidian 1.14.4 note-property renderer keeps an existing editor
when its inferred type and serialized property value remain unchanged. Its
change callback uses the renderer's latest entry and writes one property into
frontmatter read by a queued file operation. This bounded path has **no query
generation/version admission check**. These are source observations, not a
runtime concurrency or durability test.

## Artifact and bounded REA evidence

Original retained decoded artifact:
`/private/tmp/zorid-obsidian-reference-20261021/1.14.4-app.js`, SHA-256
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
Exact private excerpts, transformations and original/prepared hashes:
`/private/tmp/zorid-bases-cell-admission-reference-20261022/provenance.json`.
No recovered source is included in this repository.

REA parent:
`ev_03ea5dcaee2375ae47b8673560c801101b806edc25f565c6ccf3c53d01e79eb8`;
summary: `ev_45a73b5edc824479c7b2f278c77c5643de8402e26118064638fa3a5a44d7430e`.
Eleven inert JS files parsed, 1,780 AST nodes, zero parse failures. Semantic
coverage is partial under 250 overall / 100 per-file node ceilings; unresolved
external identifiers remain. Bundle bootstrap, app, vault and UI were not run.
Offsets below are decoded Unicode characters, end-exclusive.

| Component | Original range | Source observation |
| --- | --- | --- |
| `KJ` note-property renderer | 2498866–2499796 | Every render updates its entry and serialized current value. Existing editor is retained if inferred type and prior serialized value equal the new ones. Otherwise it renders an editor with a change callback. Non-Markdown files disable this editor. |
| Base view `updateProperty` | 2495682–2496206 | Normalizes input, awaits a transaction, and passes file/key/value to `fileManager.processFrontMatter`. Callback finds the actual property spelling and assigns the value; absent property plus null is a no-op. No expected previous cell value or query epoch is passed. |
| Base view `createTransaction` | 2494168–2494639 | Captures ephemeral state, awaits the mutation callback, then compares recorded start/end JSON. A change requests view notification, clears redo and records undo. Notification is after the awaited write. |
| FileManager frontmatter API | 1802592–1802851 | Markdown files delegate to `vault.process`, wrapping its current text with the frontmatter transformer. |
| `vB` frontmatter transformer | 1804154–1804403 | Parses current supplied text, invokes the frontmatter callback, serializes resulting frontmatter and retains the remaining body. There is no captured query-generation parameter here. |
| Vault `process` | 1426694–1427070 | Increments saving state, awaits `adapter.process(file.path, callback, options)`, updates the file cache, and decrements saving in a finally path. |
| Desktop adapter `process` | 552166–552730 | Inside its queue, reads current UTF-8 text, applies the callback, skips identical output or awaits write/options, then reconciles the file in a finally path. |
| Desktop adapter queue | 565302–565518 | Chains operation startup from the prior promise on either fulfillment or rejection. A timeout-rejection race also exists; this record does not prove behavior after timeout. |
| Query controller `notifyView` | 2543297–2544425 | Builds a fresh view data object and calls its data-updated hook independently of the property transaction callback. |
| Notification setup / debounce | 2534671–2534718 / 544936–545544 | View notification is wrapped with a 50 ms timer-based debounce helper. This is a notification schedule, not an edit-admission generation fence. |

## What refresh changes in the observed path

The renderer compares the new raw property's JSON and inferred type with its
previous render. If both remain equal and an editor exists, it preserves that
editor. Its change callback first normalizes the proposed value and skips a
duplicate serialized value. Otherwise it updates its local serialized value
and invokes the base view with `renderer.entry.file`, using the entry currently
stored on that renderer rather than a captured query generation.

The base view's property callback operates on frontmatter obtained from the
file read inside the adapter queue. It changes the selected key on that object,
preserving other properties at that callback stage. It does not compare the
selected key against an expected value from the old query. The renderer's
serialized-value comparison is an input deduplication check; it is not a
conditional write against current file content.

Consequently, an unrelated query refresh is not itself a rejection condition
in these inspected calls. The source supports retaining an editor through a
render with unchanged value/type and then targeting the latest stored entry.
It does not prove that every refresh preserves the same renderer, DOM node,
selection or draft. A changed value/type can recreate the editor, and surrounding
virtualization or view replacement can have its own lifecycle.

## Limits and implications for Zorid

Normal operations through the inspected desktop adapter are promise-queued,
and the mutation awaits that operation before recording its transaction. This
does not establish serialization against an external editor, another process,
another adapter instance or an operation continuing after a timeout. Nor does
the bounded code prove atomic behavior for concurrent file rename/deletion,
same-property edits, invalid frontmatter, write failure or draft replacement.
No app runtime was used to observe any of those races.

This evidence explains why the reference need not reject an edit merely because
a global query epoch changed. It does **not** authorize relaxing Zorid's durable
write CAS, immutable target/revision witnesses, shared-buffer admission,
Base-configuration or property-definition guards. A Zorid admission change must
still verify its actual target and relevant edit contract and retain explicit
conflict/error behavior. Its handling of unrelated refresh should be tested
separately from genuine target/content/configuration changes.

No Zorid implementation, test result, concurrent-write guarantee or reference
parity acceptance follows from this source-only record.
