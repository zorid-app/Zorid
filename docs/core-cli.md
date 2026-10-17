# Standalone CLI: initial native slice

`zorid` embeds `zorid-native` and the Rust core in its own process. It does not
contact a desktop instance, daemon or IPC service. Each invocation opens the
vault's SQLite authority and uses the native adapter's cross-process filesystem
coordination. This initial slice supports macOS and Linux; other platforms return
`unsupported_platform` until their native adapter exists.

This is not the completed full-vault CLI milestone. Search, continuous watching,
large-file streaming and production enrollment remain required. Current-v2 family
sync source uses the native core's shared ledger and causal text/file state; its
source and fixture presence do not establish runtime acceptance.

## Commands

Build from the workspace once the native adapter is present:
`cargo build -p zorid-cli -j1`. The binary is `target/debug/zorid`.

```sh
zorid --vault /path/to/existing-vault init
zorid --vault /path/to/existing-vault status
zorid --vault /path/to/existing-vault list
zorid --vault /path/to/existing-vault mkdir attachments --id folder1 --operation-id mkdir1
zorid --vault /path/to/existing-vault create note.md --id note1 --operation-id create1 --input ./note.md
zorid --vault /path/to/existing-vault read --id note1
zorid --vault /path/to/existing-vault read --id note1 --raw
zorid --vault /path/to/existing-vault write --id note1 --expected-revision REVISION --operation-id write1 --input -
zorid --vault /path/to/existing-vault move moved.md --id note1 --expected-revision REVISION --operation-id move1
zorid --vault /path/to/existing-vault delete --id note1 --expected-revision REVISION --operation-id delete1
zorid --vault /path/to/existing-vault reconcile nested/file.bin note.md
zorid --vault /path/to/existing-vault rescan
zorid --vault /path/to/existing-vault rescan --max-entries 500 --max-total-bytes 16777216 --max-depth 32 --max-duration-ms 2000
zorid --vault /path/to/existing-vault recover
```

Only `init` initializes private storage. It requires an existing directory and
does not import its existing files. Other commands require an existing regular
`.zorid/vault.sqlite`; a mistyped path does not silently initialize a new vault.
The adapter's existing-only open runs under its vault lock with SQLite creation
disabled; an empty or uninitialized database is rejected rather than initialized.
Opening initialized storage can perform native schema migrations and locking;
`list` and `read` query the committed core snapshot, not a live directory scan.
Run explicit `reconcile` with changed paths to import external edits, or `rescan`
to discover external paths. Supported
nested imports include existing parent directories. `recover` resumes pending
projection; it does not discover every external file.

`mkdir` creates one folder through the native mutation/projection pipeline; its
parent must already exist. It has no recursive `-p` behavior and never replaces a
file. As with file creation, supply a unique entry ID and operation ID, retain the
receipt, and inspect projection status. Existing filesystem paths remain subject
to the native adapter's alias, identity and no-clobber checks.

`rescan` uses bounded native enumeration, imports supported file/folder changes,
and records durable scan coverage. Defaults are 10,000 entries, 64 MiB total
examined file bytes, depth 128, and a soft five-second work limit. Optional flags
override each bound; native validation still applies. The duration is checked
between operations and is not a hard wall-clock deadline; vault lock waiting has
its own bound. Incomplete coverage returns `complete: false`, rather than claiming
all files were inspected. A later scan may continue discovering current state.
`--max-entries` accepts 1 through 100,000. Zero byte budget allows only empty
files/directories; zero duration ends scanning incomplete immediately. Depth zero
examines root entries but records unvisited subdirectories as incomplete. None of
these limits authorize deletion. Projection recovery precedes bounded scanning.
Inspect `issues` and `missing`: missing paths are preserved absence observations,
**not deletions**, and committed bytes remain accessible. No scan result can be
used as an instruction to remove all unseen entries. The response reports the
chosen limits (byte/time values as decimal strings), a persisted scan ID and
bounded counts. Raw scan diagnostics are replaced with `scan_issue` and
`scan_incomplete` codes, while paths remain metadata.

Create fails rather than replacing an existing file. Input is bytes from `--input
FILE` or `--input -` (stdin until EOF); it is never decoded as text. This slice has
a 16 MiB whole-file bound. Input over the bound is rejected, never truncated. The
native adapter retains its own matching size check. Larger files/streaming remain
required work. No credentials are accepted as flags or emitted as diagnostics.

## Agent protocol and retry rules

Success is one JSON object on stdout, with `version: 1`, `ok: true`, and `result`.
Failure is one JSON object on stderr, with `version: 1`, `ok: false`, and
`error: {code, message, detail}`; stdout is empty. Help/version are conventional
text. `read --raw` is the only data-output exception: successful stdout contains
exact bytes, no framing or newline; errors remain JSON on stderr. Default `read`
returns `entry` metadata, `encoding: "base64"`, and `bytes` containing standard
padded base64. Status exposes counts, never the recovery records' plaintext bytes.

Every create/write/mkdir requires a caller-generated operation ID. Create/mkdir additionally
requires an entry ID; write requires the exact expected revision from a prior
read/list/commit receipt. IDs use the shared core's lexical restrictions. Generate
unique IDs for new operations and persist the exact request before invoking the
CLI. After a lost response, rerun the **identical** operation ID, entry ID, path,
expected revision and input bytes. Do not generate a new operation ID or fetch a
new revision for that retry. Reusing an operation ID with different input produces
`idempotency_conflict`; stale writes produce `revision_conflict`.

Mutation success includes `durable_local_commit: true`, `commit`, `projection`,
and `synced: false`. `projection.state: "pending"` still means the database commit
succeeded: retain its receipt, then use recover/reconcile. It is not a reason to
repeat the write under a new operation ID. `pending_outbox` means locally queued
work, not a remote acknowledgment. A broken stdout pipe can happen after commit;
the same exact-retry rule applies when output delivery fails.

Reconcile/recover can have partial outcomes. Inspect `complete` and
`report.blocked` even when exit status is zero: successful imports are already
durable and must not be treated as rolled back. Current external deletions and
unresolved filesystem divergence are reported as blocked, preserving the data.
Pending projection uses code `projection_pending`; blocked report entries expose
`path`, code `reconciliation_blocked`, and a generic message. Raw native diagnostic
strings are not emitted. These generic codes do not identify the underlying cause;
typed native recovery diagnostics remain future work.

| Exit | Meaning |
| --- | --- |
| 0 | Result returned; inspect projection/complete for pending work |
| 1 | I/O, unsafe filesystem path, corrupt storage, or output delivery failure |
| 2 | Invalid arguments, invalid mutation input, or size limit |
| 3 | Revision/idempotency conflict, changed filesystem, or lock timeout |
| 4 | Missing vault or entry |
| 5 | Unsupported capability, platform, or schema |

Stable codes are provided for automation; human messages may change. Content is
printed only by explicit reads. Parser errors intentionally do not echo arbitrary
argument values, and low-level database/I/O error strings are not logged.

## Verification scope

`cargo test -p zorid-cli -j1 -- --test-threads=1` runs real executable invocations
against disposable temporary directories. Fixtures cover binary stdin and file
inputs, independent invocation restart/replay, revision and operation-ID
conflicts, exact raw/base64 reads, external nested imports, no-clobber behavior,
size rejection, safe error output and committed-but-projection-pending receipts.
Additional source fixtures cover folder creation/retry with a nested binary file,
bounded rescan completion, nested discovery and retained bytes after a missing
file observation. These additions require the native scan/directory slice and
have not been executed as part of source preparation.
Source presence alone does not establish these checks passed. The coordinator's
execution ledger records actual runs. These tests do not establish Electron
integration, server sync, Windows support or the completed CLI milestone.

## Current-v2 fixture family sync

This source uses the standalone process's embedded NativeVault for current text-v2
and file-v2, one authored envelope queue, persisted seal-once ciphertext, and atomic
received-envelope/domain-state/cursor transactions. No desktop IPC, alternate CLI
backend or local MutationRequest wire format is involved. Text mode still has its
256 KiB managed-text and 8,192-character replacement-diff bounds.

Each invocation takes `sync --credentials /absolute/path/to/fixture.json` followed
by one of the commands below. Provision the file through the synthetic relay
fixture host. The schema is version 1 with `endpoint`, `realm_id`, `vault_id`,
`server_epoch`, `key_epoch`, `key_base64` (32-byte vault key, canonical padded
base64) and `bearer_token` (relay-issued 64-character lowercase hex). Never put
keys or tokens in argv. Credentials must be outside the vault, in an owner-only
regular file owned by the current effective user, with one link; final-component symlinks and
files over 16 KiB are rejected. Ancestor symlinks are resolved normally; this
fixture check is not a sandbox against hostile same-user path replacement. Credential bodies and low-level diagnostics are
never printed. These fixture inputs are not production enrollment/secret storage.

The endpoint must be HTTP on an explicit literal loopback IP and port, without
userinfo, query, fragment or a non-root path. DNS names, redirects, system proxies,
implicit retries and remote endpoints are disabled. The expected realm and server
epoch are independently pinned in the file. An epoch change fails explicitly;
this CLI does not reset a receive cursor or rotate keys automatically.

```sh
zorid --vault /tmp/fixture-a sync --credentials /tmp/fixture-credentials.json fixture-enroll
zorid --vault /tmp/fixture-a create note.md --id note1 --operation-id create1 --text --input /tmp/note.md
zorid --vault /tmp/fixture-a create asset.xyz --id asset1 --operation-id create2 --binary --input /tmp/asset.xyz
zorid --vault /tmp/fixture-a sync --credentials /tmp/fixture-credentials.json status
zorid --vault /tmp/fixture-a sync --credentials /tmp/fixture-credentials.json once --max-push 64 --max-pages 4
```

Enrollment requires a fresh empty initialized vault. Enrolling the identical scope
again is idempotent. Each receiving client enrolls its own fresh empty vault; it
does not independently create matching files or infer shared identity from paths.
Current authenticated namespace Create records supply identity/content binding.
Old `fixture-bind-empty` and `fixture-adopt` explicitly reject as obsolete; there
is no development-fixture migration or invented v1 namespace frontier.

In enrolled vaults, file creation requires exactly one of `--text` or `--binary`.
This is immutable content ownership, not a filename or UTF-8 heuristic. The mode
is part of operation idempotency: retrying an operation with another mode rejects.
Writes, moves and logical deletes use the persisted binding and the caller's
revision precondition. `--recursive` authorizes only the core-observed subtree;
it never purges storage or expands remote deletion to unknown files. Offline
commands persist their family envelopes atomically with their local mutation.

`once` pushes at most `max-push` native-authored envelopes and pulls at most
`max-pages` bounded pages against a fixed relay high-water mark. Zero disables a
phase. The existing bounded HTTP transport validates realm, epoch, contiguous
sequence, response sizes and ACK identity before recording remote acceptance.
The CLI authenticates a bounded page before sending each capability to the native
family dispatcher. It does not parse CRDT updates or assemble chunk manifests.

The native transaction may durably receive an envelope whose Create, frontier,
page or chunk is unavailable. That committed receipt and its dependency obligation
may advance the shared cursor, without publishing an empty or partial file. Later
dependency delivery resolves it. Failed transactions do not advance the cursor.
Exact duplicate delivery is quiet, and received data never becomes authored echo.
Lost upload ACKs retry the persisted winning ciphertext with the same UpdateId.

Output separates `server_accepted`, `locally_received`, `locally_applied_updates`,
`duplicate_receipts`, `dependency_pending_receipts`, `receive_projection_pending`
and `pull_snapshot_complete`. Metadata under `family` reports the shared cursor,
pending counts and current limits/graph usage. Counts declared as strings by the
native API stay decimal strings. Pending envelope samples are capped at 1,000;
inspect `pending_envelope_sample_complete`. `synced` stays false because a bounded
sweep is not a global synchronization barrier. Physical publication may remain
pending after durable receive; `recover` handles supported projection work.

### File-size and memory boundaries

The interim CLI/native fixture whole-file limit is 16 MiB. Input uses cap-plus-one
reads and rejects oversize before a mutation. Arbitrary binary bytes and unknown
extensions are supported within that limit. This is a temporary client bound,
not an architectural requirement or a claim that larger-file work is finished.

The protocol plaintext limit is 1 MiB **per envelope**, not per file. Native
chunking uses at most 128 KiB raw chunks, manifest pages and a final content event;
the CLI uploads one sealed envelope at a time. The portable manifest permits up
to 64 MiB, but that does not mean the current client can materialize 64 MiB.
Current chunk JSON numeric arrays can expand fourfold, and aggregate encoded graph
history is capped at 128 MiB and 4,096 records. Even two worst-case 16 MiB versions
approach that graph limit. Native transactions must reject exhausted bounds
without partial receipts; status exposes current usage. No truncation is allowed.

File imports, projection and graph rebuilds still use bounded whole buffers.
Transporting chunks does not make those operations streaming. Supporting larger
files requires core-owned incremental staging/hash validation, normalized chunk
storage and bounded graph/materialization work; CLI must consume that native
streaming interface rather than invent another storage path. Keep this work
required before claiming unrestricted full-vault support.

Source fixtures use actual standalone CLI processes and a real loopback relay.
They cover offline text convergence, exact lost-ACK retry, protected credentials,
revocation/epoch/authentication rejection, remotely created text, binary content
larger than one envelope followed by move/delete, immutable create modes, and
pending manifest/page/chunk restart resolution without partial publication or
echo. Process stdout/stderr are drained concurrently with bounds and a watchdog.
These current-v2 additions are source-only until the coordinator records an actual
schema8 integrated test pass. They do not establish browser/Electron convergence
or production enrollment. The HTTP client remains
[reqwest 0.13.5](https://docs.rs/reqwest/0.13.5/reqwest/blocking/struct.ClientBuilder.html).
