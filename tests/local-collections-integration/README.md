# Standalone local collection acceptance

`run.mjs` runs an actual matched `zorid-cli` binary, starting a fresh independent
process for each command. It never starts Electron, a browser, a sync service or
the desktop host, and never replaces Rust authority with a JavaScript store.
This scenario is outside the default unit-test glob. The coordinator owns its
runtime lane and runs it after the native/CLI/query batches are composed, reviewed
and built from the supplied source receipt.

```sh
node tests/local-collections-integration/run.mjs \
  --cli /absolute/matched/zorid-cli \
  --expected-cli-sha256 MATCHED_64_CHARACTER_SHA256 \
  --source-revision MATCHED_FULL_40_CHARACTER_GIT_COMMIT \
  --out /private/tmp/zorid-local-collection-evidence
```

The script checks the executable's hash/identity and the exact `crates`,
`Cargo.toml` and `Cargo.lock` Git objects against the supplied build revision. It
rejects dirty or untracked Rust source. Those source objects, the driver hash and
the executable are checked again after the scenario. A matching version string
alone is not accepted as artifact provenance. The executable hash/source
association comes from the coordinator's build receipt, not inference by this
driver. The driver must be integrated into the checkout whose Rust source is
being verified; running it from its older preparation branch intentionally fails
source admission.

The output parent is resolved before admission and must be outside the canonical
repository, every registered worktree and the executable's directory. A unique
fixture directory contains a disposable vault, app-data root and command receipts.
The script never points at an existing vault and does not remove any fixtures or
evidence after the run. No sync credentials or enrollment commands are used.

## Authored scenario

The plan has **30 CLI processes**, a maximum of 42, a five-minute scenario budget,
25 seconds per process and 16 MiB of captured output per command. Mutations use
explicit operation IDs. A timeout kills only the process created by that command;
observed exit is recorded separately from a requested signal. An unobserved child
remains named in the failed report rather than being reported as cleaned up.

1. Initialize a local vault, create an ordinary untyped note and an ordinary
   legacy `Properties.yaml` file, then create Books and Projects. Identically
   named Rating fields must have independent identities.
2. Create two Books entries and one Projects entry. Check stable core note IDs,
   readable `_type`/field values, exact bodies and unmanaged frontmatter/comment
   preservation. Check readable `.zorid/types/Books.yaml` schema IDs/options and
   compare the first note's actual disk bytes with a separate CLI raw read.
3. Create one Base containing a filtered Books view, a Projects view and an
   untyped view. Explicitly publish the Rust index, then query each view through
   the standalone CLI. The low-rated Book is demonstrably hidden by the first
   view; untyped results include only the loose note and expose file properties.
   The loose note deliberately contains `_type: Books`: that readable label must
   not grant hidden membership or contaminate either collection's query.
4. Change a value, replay the identical operation in a fresh process, reject a
   stale revision and reject a different payload reusing the same operation ID.
   Rejections must preserve the actual saved bytes.
5. Rename the collection, its Status field and one status option. Identities and
   values remain stable while readable YAML changes. The old definition filename
   disappears, the unrelated Project remains byte-identical, and Duplicate creates
   a new note identity inside the original collection.
6. Delete the collection. All three current members move to recoverable Trash,
   including the member hidden by the saved filter. Create an unrelated occupant
   at the first book's former path. Restore the collection: original member IDs
   return, the occupied path gets an alternative filename, and the occupant's
   bytes stay exact.
7. Reopen both collections and list them using fresh CLI processes. Check member
   identities/values, preserved ordinary note/legacy registry/Base source, zero
   pending file publication and no pending outgoing work.

Database commands use exactly:

```text
zorid-cli --vault VAULT database request --input -
```

Stdin is `{ "schemaVersion": 1, "command": { "op": "...", ... } }`. Success
and failure use the normal CLI envelopes. Each successful database reply must
report zero pending readable projections and no projection issues; a durable
logical commit with failed publication is not accepted as completed file behavior.
The driver does not silently try alternate command syntaxes or skip missing APIs.

## Evidence and limits

The console prints the report path and result. `report.json` includes exact source
and artifact identities, the command plan, every child PID/exit/signal, input and
output hashes, per-scenario status and passed assertions. `commands/` retains the
exact stdin/stdout/stderr bytes. Failure leaves subsequent scenarios explicitly
`unexecuted`; it cannot be relabeled a pass by a later source fix.

A pass establishes only these authored standalone local CLI/query scenarios. It
does not establish UI/onboarding, automatic New filter synthesis, focus/keyboard
interactions, simultaneous clients, crash/interruption recovery, external-edit
admission, browser/WASM/mobile behavior, or distributed sync/encryption guarantees.
Deleting a collection here exercises its core/native command, not the UI's
confirmation presentation. No new performance or full-suite campaign is implied.

Preparation validation is `node --check run.mjs` and documentation/source review.
The actual scenario remains **not run** until the coordinator records a matched
artifact execution receipt.
