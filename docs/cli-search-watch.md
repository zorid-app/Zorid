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

Verification status: source prepared and rustfmt/diff checks performed. Executable
regressions prepared by independent cli_tests for search, local watch/restart,
signal shutdown and lost-ACK/network/auth behavior. No compile or test result is
claimed yet; root owns the serialized build slot and final native aggregation.
Independent packaging_review source review accepted the scoped source after
ordering, parser and shutdown-reporting fixes. Commits and exact execution evidence
will be appended after the scoped gate.
