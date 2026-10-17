# Portable file-v2 planner

Current fresh fixtures use `zorid_file_sync::v2` and text-v2. The existing crate-root
v1 API remains isolated for its earlier fixtures. Each decoder accepts only its
explicit version; no migration, fallback decoding, synthesized frontier or rewritten
wire ID is provided. This project has no deployed v1 user migration requirement.

A Create fixes directory, binary or text content ownership. Text binding names an
independent immutable text bootstrap and text format 2; it need not equal the
namespace Create ID. `VaultView.content_bindings` contains modes/bindings, not the
original binary seed. Current binary manifests are only in
`VaultView.namespace.entries[id].contents`. Text entries have no binary heads.

Text-v2 provides a private `TextActivity` capability from authenticated decoding or
successful local text planning. File-v2 turns it into a genuine graph activity
using the same UpdateId; it never creates a second envelope, binary SetContent,
location mutation or authored echo. The host commits the original text plan,
file graph plan, shared exact-wire ledger, cursor and publication obligations in
one transaction. A graph plan alone is not permission to publish text bytes.

Concurrent delete/edit yields retained recovery state; a deletion that observed
the edit yields a tombstone. Neither erases the text state. An edit that observes
a deletion is invalid until explicit Restore. Moves affect location independently
of text, so concurrent moves and edits preserve both. Unavailable valid bootstrap,
frontier, page and chunk dependencies remain pending; known incompatible identity
roles fail instead of becoming impossible downloads. All identity, cycle,
antichain and binding validation runs again on reconstruction.

`State::from_records` accepts normalized trusted local records. `StoredActivity`
contains full identities/context plus SHA-256 and byte length of its original
plaintext. It is persistence metadata, never fresh authentication. Its serde
implementation does not grant an ingestion capability. Hosts must bound encoded
storage reads before parsing and cross-check restored activity against their
immutable shared wire ledger. Do not expose raw reconstruction to remote callers.
There is no retained duplicate text body in the file graph.

File and text plans compare the complete expected state. A host must also enforce
its global UpdateId/wire ledger, including other protocol families, and globally
fresh local revisions. Exact received replay checks happen before new revision
preconditions. The portable graph detects repeated plaintext under the same text
ID using its digest, but the host additionally rejects changed ciphertext/nonces
under that ID, even for identical plaintext.

Source regressions cover both delivery orders for delete/edit and move/edit,
explicit restore, missing dependencies and restart, independent bootstrap binding,
mode/identity/role collisions, impossible binary/causal references, authenticated
text activity, strict version boundaries and binary-head behavior. Runtime
verification must include the existing v1 tests because both versions share the
private graph engine; source review is not a passing test result.

## Physical and retained-content witnesses

`v2::State::join_physical_move_frontier(identity, prior, applied_move)` validates
an existing nonempty canonical physical frontier and joins one resolved Move for
that exact entry/bootstrap. It uses the same validated ancestry bitsets as view
construction, retains incomparable heads, removes dominated heads and bounds the
result. It does not substitute the latest graph heads or claim that newer text
bytes were published. Restore is excluded. An ancestor folder Move cannot enter
a child's entry-scoped frontier; the host preserves the child's frontier and
proves the ancestor/member path change separately in its physical journal.

The helper validates causal semantics, not filesystem application or the truth
of the caller's historical publication claim. A native adapter must couple the
result to its durable source binding and actual completed Move, then atomically
store the fresh physical branch revision, unchanged text snapshot/bytes and the
new path/location evidence. Graph knowledge alone is not publication proof.

`v2::State::materialize_retained_binary(identity, content_event)` validates the
exact entry/bootstrap and immutable binary mode, derives the manifest from a
retained resolved Create/SetContent event, then verifies/materializes it in Rust.
Historical dominated content, Recovery entries and Tombstones remain readable;
the call neither selects a normal projection path nor asserts current content.
A Move/text event or another entry's event is not a binary-content witness.
Missing dependencies return `None`, while a valid empty file returns
`Some(Vec::new())`. A host validating already-retained bytes must treat missing
or mismatched content as damaged storage, never silently replace it with empty
bytes. Browser/WASM adapters should call this helper rather than implement
independent identity, ancestry or mode checks in JavaScript.

Both helpers and eight focused regression fixtures are source-reviewed only in
`core-physical-frontier`, based on integrated main `a8d1733`. No build or runtime
test has run for this follow-up yet. Existing view/wire formats are unchanged.
