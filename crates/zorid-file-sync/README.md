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
