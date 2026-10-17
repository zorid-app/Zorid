# Default desktop Rust authority

Owner /root/desktop_default_sol; worktree desktop-rust-default based main0d3db40.
2026-10-17 resumed checkpoint: root is sole main integrator (current main bf81894);
this worker preserves inherited uncommitted desktop/native-host implementation.
Native schema9 external import is /root/external_reconcile_sol owned;
packaged native resources are /root/package_sol owned. Registry source4a3d6f0+fb25329
is integrated in this candidate as ecdf215+81041d9.

Normal desktop selection always opens the Rust host. No ZORID_EDITOR_RUST,
relay config or fixed fixture root is required. The executable is a trusted
absolute override, development target/debug or target/release build, or packaged
resources/native/zorid-desktop-host. Missing executable, unsupported schema or
incomplete import is an explicit error; there is no filesystem adapter fallback.
Existing unreleased databases are not migrated or deleted.

Trusted --initialize-local startup initializes storage, reuses an enrolled scope
or derives local realm/vault IDs from persistent local_store_id, then calls the
shared native reconcile_external(ScanOptions::default(), Auto). Auto is owned by
native core: known binary extensions force binary; otherwise valid UTF8 without
NUL is text. Bytes and BOM remain unchanged. Startup requires report.complete.
The bounded periodic native scan also observes externally created files. Local
leased file commands operate without a relay runner; network fixture commands
still require protected startup credentials. Future hosted enrollment must use
this logical scope or an explicit import/rebind operation, never silently rotate.

Main holds Electron's single-instance lock before opening the persisted slot
registry. Each window owns a distinct stable client and secondary window ID;
restart restores its saved vault. The selected vault is persisted before client
admission, preventing ambiguous registry writes from orphaning new checkpoints.
Vault switches still require renderer flush/dispose/release before selection.
Normal close uses the awaited renderer handshake; unexpected window disappearance
retires only its client lease after draining and retains all checkpoints/intents.
The shared per-vault host stays alive while another window owns that service.
Last-owner retirement installs a per-root fence before draining. New opens wait,
selections that already received the old service retry, and removal of broker/cache
entries checks identity. Failed retirement keeps the root fenced until restart.
Vault switch fences new admissions through chooser/selection/persistence, rejects
overlapping selections, and retires the old released admission after rebinding.

Dedicated verification tooling remains separate. Explicit old fixture startup can
still select its protected relay configuration; it does not control defaults.

Verification: 52 focused Node checks passed with --test-concurrency=1 on
2026-10-17: editor-core (5), host-location (1), client-admission (9),
client-slots (5), window-broker (9), main (1), family-fixture (4),
durable-checkpoints (4), durable-writes (6), text-create (8). The retirement
checks cover delayed close, an already returned stale service, identity-checked
entry removal, failure fencing and late-admission blocking. Main wiring uses controlled Electron mocks. Native subprocess
startup regression is source-only pending the combined schema9 build. It covers
preexisting BOM text/binary/empty folder import, credential-free leased creation
and same-authority restart. Packaging verification and actual normal multiwindow
Electron create/save/rename/folder/trash checks remain separate gates.
