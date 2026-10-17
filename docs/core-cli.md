# Standalone CLI: initial native slice

`zorid` embeds `zorid-native` and the Rust core in its own process. It does not
contact a desktop instance, daemon or IPC service. Each invocation opens the
vault's SQLite authority and uses the native adapter's cross-process filesystem
coordination. This initial slice supports macOS and Linux; other platforms return
`unsupported_platform` until their native adapter exists.

This is not the completed full-vault CLI milestone. Move/delete, physical folder
creation, search, complete filesystem scanning, E2EE sync and real Electron
concurrency verification remain required. This executable never uploads data.

## Commands

Build from the workspace once the native adapter is present:
`cargo build -p zorid-cli -j1`. The binary is `target/debug/zorid`.

```sh
zorid --vault /path/to/existing-vault init
zorid --vault /path/to/existing-vault status
zorid --vault /path/to/existing-vault list
zorid --vault /path/to/existing-vault create note.md --id note1 --operation-id create1 --input ./note.md
zorid --vault /path/to/existing-vault read --id note1
zorid --vault /path/to/existing-vault read --id note1 --raw
zorid --vault /path/to/existing-vault write --id note1 --expected-revision REVISION --operation-id write1 --input -
zorid --vault /path/to/existing-vault reconcile nested/file.bin note.md
zorid --vault /path/to/existing-vault recover
```

Only `init` initializes private storage. It requires an existing directory and
does not import its existing files. Other commands require an existing regular
`.zorid/vault.sqlite`; a mistyped path does not silently initialize a new vault.
The adapter's existing-only open runs under its vault lock with SQLite creation
disabled; an empty or uninitialized database is rejected rather than initialized.
Opening initialized storage can perform native schema migrations and locking;
`list` and `read` query the committed core snapshot, not a live directory scan.
Run explicit `reconcile` with changed paths to import external edits. Supported
nested imports include existing parent directories. `recover` resumes pending
projection; it does not discover every external file.

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

Every create/write requires a caller-generated operation ID. Create additionally
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
Source presence alone does not establish these checks passed. The coordinator's
execution ledger records actual runs. These tests do not establish Electron
integration, server sync, Windows support or the completed CLI milestone.
