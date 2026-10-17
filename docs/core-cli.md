# Standalone CLI: initial native slice

`zorid` embeds `zorid-native` and the Rust core in its own process. It does not
contact a desktop instance, daemon or IPC service. Each invocation opens the
vault's SQLite authority and uses the native adapter's cross-process filesystem
coordination. This initial slice supports macOS and Linux; other platforms return
`unsupported_platform` until their native adapter exists.

This is not the completed full-vault CLI milestone. Move/delete, search,
automatic watcher integration, full-vault E2EE sync and real Electron
concurrency verification remain required. An explicitly selected fixture text-sync
surface now sends encrypted native-authored updates to a local relay; its source
and fixture presence do not establish runtime acceptance.

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

## Explicit fixture text sync

This source slice uses the standalone process's embedded NativeVault, including
its persisted text CRDT, authored queue, seal-once encrypted wire and atomic
received-update/cursor transaction. It never requires desktop IPC, sends local
MutationRequests as sync payloads, or treats the local command outbox as the
network queue. Current native limits apply: managed UTF-8 text is at most 256 KiB,
with an 8,192-character whole-text diff work bound. Binary files, namespace
operations, creation/discovery over sync, continuous watching, production
onboarding and service deployment remain unsupported by these commands.

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
zorid --vault /tmp/fixture-a sync --credentials /tmp/fixture-credentials.json fixture-bind-empty --id note1 --bootstrap-id shared-bootstrap --expected-revision REVISION
zorid --vault /tmp/fixture-a sync --credentials /tmp/fixture-credentials.json fixture-adopt --id note1 --bootstrap-id shared-bootstrap --expected-revision REVISION --operation-id adopt1 --input /tmp/exact-existing-text.md
zorid --vault /tmp/fixture-a sync --credentials /tmp/fixture-credentials.json status
zorid --vault /tmp/fixture-a sync --credentials /tmp/fixture-credentials.json once --max-push 64 --max-pages 4
```

`fixture-bind-empty` binds an existing empty file using explicit entry and bootstrap
identities; replicas must agree on those identities, even if their local revisions
are different. `fixture-adopt` authors the initial content once from exact committed
bytes with a caller-stable operation ID and revision precondition. It is an
alternative to binding that same nonempty replica, not a command to independently
seed every replica. Both commands work offline. After binding/adoption, ordinary
revision-checked CLI writes and native external reconciliation use the shared text
mutation pipeline. Other replicas initially bind an empty file to the agreed
identity and receive the authored seed. Matching paths or matching content never
infer document identity. Unknown incoming entry/bootstrap identities stop receive;
they do not cause implicit file creation or a skipped cursor position.

`once` first pushes up to `max-push` pending native-authored updates, then pulls at
most `max-pages` pages of at most 64 entries each. Zero disables the corresponding
phase. Pull uses one fixed server high-water boundary for that invocation. The
transport caps each response before JSON/base64 decoding, validates contiguous
sequences, snapshot bounds, epoch and protocol extensions, and authenticates all
bounded page envelopes before committing any of that page. Upload ACKs validate
the exact update/vault/epoch and do not advance receive cursors.

A lost upload ACK retains the previously sealed wire. Run the same sync command
again: the next process sends the exact persisted ciphertext with the same update
ID. A failed receive never authorizes a cursor advance. A successfully committed
receive may have pending filesystem publication; its persisted cursor is still
valid, and `recover` retries publication. Native cursor/state CAS rejects concurrent
stale workers. Partial progress before a later error remains durable; another
invocation continues from persisted state without new local operations or echoing
received updates into the authored queue.

Success reports `server_accepted`, `locally_received`,
`receive_projection_pending`, and `pull_snapshot_complete` separately. `synced`
remains false and `all_file_sync_supported` remains false: completing a text pull
snapshot does not complete full-vault sync. `local_command_outbox_unclassified`
reports the older local command queue, which is not acknowledged by this text
transport and can include already transported text commands. It must not be used
as a count of missing server text updates. `pending_text_sample` is bounded at
1,000 entries; inspect `pending_text_sample_complete` rather than assuming a full
count. `status` is offline and never seals/uploads data. `sync_available: false`
on ordinary status refers to full-vault sync; `fixture_text_sync_available: true`
identifies this limited surface.

Focused source fixtures in `tests/sync.rs` use a real loopback relay and repeated
independent CLI executable processes. They cover offline concurrent edits,
received-no-echo, lost remote ACK after real server commit, exact ciphertext retry,
BOM/line-ending preservation, revoked credentials, wrong epoch, invalid encryption
and protected credential inputs. Transport unit fixtures reject malformed page
chains and excessive response bodies. Runtime results belong in the coordinator's
execution ledger; no production or complete full-vault-sync claim follows from
these fixtures. The conventional blocking HTTP client uses the
[reqwest 0.13.5 client controls](https://docs.rs/reqwest/0.13.5/reqwest/blocking/struct.ClientBuilder.html)
and [bounded Read response interface](https://docs.rs/reqwest/0.13.5/reqwest/blocking/struct.Response.html).
