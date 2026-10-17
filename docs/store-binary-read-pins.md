# Durable binary read pins

Owner: `package_sol/binary_reads`. Source-only implementation in isolated
`store-binary-streaming`; parent owns shared registration, schema 11 and helper
integration. No builds or tests have run for this module yet.

`Store::open_binary_read` checks the supplied file state against its exact
historical family publication, including identity/bootstrap, revision, path,
kind, selected content event and manifest. It verifies actual complete content
before returning a private `BinaryReadSession`. `open_capture_read` instead
resolves the caller-owned sealed capture; it does not manufacture an EntryState
or infer graph membership.

The pin retains its source, optional historical EntryState and a bounded metadata
membership snapshot. It copies no payload bytes. Its serialized row is bounded
to 2 MiB plus 64 KiB. The store permits four active pins. No implicit expiration,
eviction or source GC releases this quota. Explicit idempotent close releases
only the pin; immutable sources remain retained.

Resume restores the original snapshot from retained immutable authority, checks
its exact fingerprint and verifies whole content again. No persisted boolean
becomes a proof. Later content writes, moves and deletion cannot substitute the
latest graph or entry for this snapshot. Graph and capture sources remain
separate in both persistence and verification.

Each range checks the owning local store/scope, client and exact original pin
row, then checks its private proof against the session metadata. It reads only
chunks overlapping the requested offset and rechecks exact source and chunk
commitments. The returned range is at most 128 KiB; crossing a chunk boundary
may read two bounded chunks, without reading prefix payloads. Offset past EOF
or an oversized request fails; EOF and zero-length ranges return empty bytes.

Opening uses a deferred SQLite transaction while hashing, and inserts the pin
only after complete verification. A concurrent writer that invalidates its
read snapshot causes the write upgrade to fail rather than issuing stale proof.
Resume/range use coherent read transactions. Capture metadata currently invokes
its existing complete sealed-source check before the explicit portable manifest
verification; this can hash twice on open/resume, but never per range.

Five source tests cover four-pin quota and owner/local-store separation, restart
and closed pins, corrupted actual payloads, empty capture content, a historical
graph pin across write/move/delete/restart, and direct bounded range traversal
that reads only overlapping chunks and rejects altered bytes. These are planned
checks until the coordinator runs the shared store gate. They establish no
client, native, browser, mobile or memory acceptance by themselves.

Caller-checkpointed `open_binary_read_with_id` and
`open_capture_read_with_id` make a lost open response retryable. The caller's
read ID identifies the open request within that client; the store separately
allocates a fresh random pin UUID for the serialized resume/close locator.
Existing owner/source/state matches restore the original pin and metadata and
verify actual whole content before returning a session. They do not replan
against today's target, allocate another pin or fail merely because four pins
are occupied. Changed active requests fail. Random-ID open methods remain
convenience wrappers over this same path.

`list_binary_reads(client)` returns at most four locators belonging to that
client in the current local store, including their caller read IDs. It reads
no content and returns no private proof. Native reserved internal owners can
explicitly resume/close orphaned pins under their outer filesystem lock after
restart; another client cannot discover or evict these pins.

Close deletes the active pin. Reusing a closed caller read ID allocates a new
store pin UUID. An old serialized locator cannot resume or close the new pin,
and the old in-process session stays invalid. No permanent closed-ID tombstones
or automatic eviction were added.

Two additional source-only tests cover orphan discovery/owner filtering and
explicit quota release, plus caller-chosen lost-ACK retry at capacity, changed
request/owner conflicts, independent same-content pins and closed-locator
separation. The graph-history test also retries its exact old open request
at capacity after write/move/delete. These seven checks remain unrun.
