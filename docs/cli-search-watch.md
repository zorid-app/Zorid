# CLI search and watch execution checkpoint

Owner /root/package_sol; branch tingkai-c/cli-search-watch, Orca worktree
/Users/ctk/orca/workspaces/Zorid/cli-search-watch, based main04ca6f3. Root alone
integrates main. Scoped ownership: crates/zorid-cli plus core-cli.md and this
checkpoint. The only root lock edit adds the already pinned libc dependency to
the zorid-cli stanza; no package resolution/version changes.

Approved scope: basic committed UTF-8 literal search and standalone restartable
foreground watch/rescan with optional existing fixture sync. No new crypto,
enrollment, migrations, daemon/IPC or large-file streaming. Native scanner and
fatal/compound changes remain external_reconcile_sol owned; public report/API
unchanged. Watch must integrate after the typed-fatal routing patch: successful
incomplete reports must never conceal storage/schema/unsafe-root failures.

Search reads committed content and reports each actual read's revision, bounded
matching-line output and explicit skipped/truncated counts. Watch retains exact
native durable queues/cursors, checks authority across reopen cycles, uses a
retry allowlist and atomic-only shutdown flags. Enrolled inventory must precede
recovery; incomplete inventory also defers sync because receive/duplicate paths
can run recovery internally. Independent packaging_review identified and reviewed
this required ordering refinement during source preparation.

## Scoped validation — 2026-10-17

Reviewed implementation commit380f030 was merged with root's tested native
main9fa497f in isolated candidate98c37f3. No implementation source changed during
these checks. Root granted the exclusive Cargo slot; all commands used
CARGO_BUILD_JOBS=2 and
CARGO_TARGET_DIR=/Users/ctk/orca/workspaces/Zorid/core-default-integration/target.

- `cargo test --locked --offline -p zorid-cli --test search_watch -- --test-threads=1`:
  session48086 exit0; compile29.88s, five real-process cases passed (1.48s).
- `cargo test --locked --offline -p zorid-cli --test sync watch_ -- --test-threads=1`:
  session2988 exit0; three real-process/loopback relay cases passed (2.26s).
- `cargo test --locked --offline -p zorid-cli --bin zorid retry_allowlist_never_retries_fatal_identity_or_storage_errors -- --test-threads=1`:
  session3375 exit0; one unit case passed.
- `cargo test --locked --offline -p zorid-cli --test commands read_commands_never_initialize_and_usage_does_not_echo_values -- --test-threads=1`:
  session66354 exit0; one existing parser/no-init regression passed.

Ten scoped cases pass. They cover committed UTF-8/unknown-format search, binary
skips and explicit limits, no implicit discovery, active/offline/restarted local
watch, SIGINT shutdown with subsequent vault usability, incomplete enrolled scan
with no recovery/network sweep, lost ACK preserving exact sealed ciphertext
across process restart, and revoked credentials without retry/secret output.
The first watch sync run9857 exited101 because two new assertions compared an
unbound cursor to its valid bound position-zero context. Test-only correction
now checks unchanged position plus expected realm/vault/server epoch, and
requires actual cursor advancement on successful retry. Implementation was not
changed or weakened. Existing store dead-code and test fixture warnings remain.

Independent packaging_review accepted scoped source after ordering, parser and
shutdown-reporting fixes. Tests were independently prepared by cli_tests. Binary
at the shared target's debug/zorid has SHA256
5212e542ed7673ccc0ef9fea32ee6f5f77ee85b80173f40fe4ce28e080657abb.
The shared slot was released after these checks; test children/relay lifetimes
are bounded and owned by their fixtures.

Independent follow-up review also accepted the corrected cursor assertions and
this evidence record. Root alias policy was checked against native fs.rs164-167:
the selected root is canonicalized once by the existing native contract; watch
pins that same legitimate alias destination while retaining native content and
private-storage no-follow/identity checks. No runtime source change was needed.

Root must integrate source380f030 and the test/evidence followup onto main with
the native typed-fatal dependency. This is local CLI capability evidence, not
large-file streaming, production enrollment, normal app sync UX or completion of
the full milestone. Existing scanner bounds/progress limitations remain native
owner work, with incomplete cycles explicitly reported and sync deferred.
