# Mobile Unix source readiness review

2026-10-17; independent source reviewer in branch
`tingkai-c/mobile-unix-audit`, worktree
`/Users/ctk/orca/workspaces/Zorid/mobile-unix-audit`.
Implementation base: `f69dc90de0de697dfb75a5a3d1805b69dba982b3`.
Owned artifact: this document only. Dependencies: native mobile owner's UIKit /
existing Capacitor / embedded Rust staticlib evaluation; shared-core coordinator
retains integration ownership. Read AGENTS.md, roadmap execution checkpoint,
user findings and shared-core milestone acceptance. No implementation edits,
builds, tests, simulators or runtime probes performed. Findings below are source
review, not mobile acceptance. Existing desktop/browser acceptance excludes mobile.

## Recommendation

iOS has a plausible small cfg-only production-source enablement path. Android
also needs a lock compatibility shim for the declared Rust 1.89 minimum. Neither
target is enabled at this base. Start with an app-owned local filesystem vault;
neither Android document-provider URIs nor arbitrary iOS File Provider locations
are established compatible with this adapter. Keep Capacitor and the host choice
outside the storage cfg patch.

## Exact minimum cfg changes for the native owner

Use the explicit supported-target predicate everywhere production code currently
uses `any(target_os = "macos", target_os = "linux")`:

```rust
any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android")
```

1. `crates/zorid-native/Cargo.toml`: expand the target dependency table for
   rustix to the predicate above; keep version `=1.1.5`, features `fs, process`.
2. `src/lib.rs`: expand the positive predicates at lines 76, 205, 207, 209,
   211 (Errno conversion, fs, fs_stream, native, re-export). Expand the predicate
   *inside* each negative fallback gate at lines 213, 215, 223, 419, 486 so no
   duplicate stub types/impls remain on mobile.
3. `src/client_admission.rs`: expand production gates at lines 46, 59, 103
   (`checked`, `claim`, `verify`). Missing these leaves native.rs without its
   required lease functions. Keep unsupported platforms on the fallback.
4. Do not blanket replace these with `cfg(unix)`: the adapter requires specific
   atomic no-replace rename support, not just Unix descriptors. Do not copy
   rustix's private `apple`/`linux_kernel` cfg names into Zorid.
5. Leave process-based test module gates desktop-only for this minimal enabling
   patch (`lib.rs`493–503); broadening them does not make an iOS test runner able
   to spawn its own executable. The client_admission tests gate at line123 may
   be broadened separately when a mobile harness exists. Native submodules also
   contain unconditional `cfg(test)` fixture modules; inventory these before a
   mobile test build rather than claiming the desktop test suite is portable.

This enables source selection, not a confirmed cross-compile. There is no
identified need to change rename code, traversal flags, SQLite dependency cfgs,
shared core contracts, root build files or editor files for iOS source selection.

## Android lock blocker and minimum fix

`fs.rs`256 (`Paths::lock`) and `client_admission.rs`84 (`claim`) call
`File::try_lock()`. Rust **1.89** implements this with flock on Apple/Linux,
but its target predicate excludes Android; Android receives an `Unsupported`
error. A successful Android compile after cfg expansion therefore would not
establish a working `NativeVault::open`. This is a concrete declared-toolchain
blocker, independent of whether a newer toolchain adds Android support.
[Pinned Rust 1.89 source, lines1221–1251](https://github.com/rust-lang/rust/blob/1.89.0/library/std/src/sys/fs/unix.rs#L1221).

Add one helper in fs.rs and call it at both production sites; retain the existing
retry/deadline and lease `InUse` handling. Suggested exact helper body:

```rust
pub(crate) fn try_lock_exclusive(file: &File)
    -> std::result::Result<(), std::fs::TryLockError>
{
    #[cfg(target_os = "android")]
    {
        use rustix::fs::{flock, FlockOperation};
        match flock(file, FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => Ok(()),
            Err(rustix::io::Errno::AGAIN) => Err(std::fs::TryLockError::WouldBlock),
            Err(error) => Err(std::fs::TryLockError::Error(error.into())),
        }
    }
    #[cfg(not(target_os = "android"))]
    { file.try_lock() }
}
```

rustix1.1.5 exposes flock for Android (`src/fs/fd.rs`304–319). Android's
EWOULDBLOCK aliases EAGAIN. Preserve fd-owned RAII release, independent opens for
contending locks, permanent lock filenames and inode checks. Do not replace
flock with POSIX fcntl locks: those have different lifetime/close semantics.
Desktop fixtures using `lock.lock()` need equivalent adaptation if later ported.
Suspension can retain a process's locks, unlike termination; run blocking native
operations off the UIKit/main JS thread. Defaults allow five seconds of vault
lock waiting plus SQLite busy waiting; those are not a mobile UI latency bound.

## Rename and descriptor traversal

`fs.rs`128–134 `rename_new` already calls
`renameat_with(..., RenameFlags::NOREPLACE)`, then syncs both directories.
Pinned rustix1.1.5 source proves:

- `build.rs`143–161 classifies iOS as `apple`, Android as `linux_kernel`.
- `src/fs/at.rs`298 exposes renameat_with on both classes.
- `src/backend/libc/fs/types.rs`498–551 maps NOREPLACE to Linux
  RENAME_NOREPLACE and Apple RENAME_EXCL.
- `src/backend/libc/fs/syscalls.rs`546–623 uses a raw renameat2 syscall for
  Android's libc backend; Apple weak-links renameatx_np. Missing Apple symbol
  returns NOSYS for nonempty flags; there is no destructive fallback.
- The linux_raw backend also has renameat2; Android backend choice depends on
  architecture/build configuration. Do not infer a bionic wrapper API-level
  requirement from the existence of renameat2 in an NDK header.

Retain this call unchanged. Actual kernel/filesystem support still needs proof:
race a destination into existence and verify neither file nor directory is
overwritten; cover case-only names and nested moves. NOSYS/NOTSUP/INVAL/EXDEV
must stay errors or pending projection, never trigger ordinary rename or a
check-then-rename fallback. Cross-mount subtree moves are not supported by rename.
[rustix API](https://docs.rs/rustix/1.1.5/rustix/fs/fn.renameat_with.html).

`fs.rs` flags/open_dir_at/exact/regular/Paths maintain descriptor-relative
openat/mkdirat/statat and NOFOLLOW/CLOEXEC/NONBLOCK, directory enumeration,
single-link regular files, exact Unicode/case spelling, owner/private-mode and
dev:ino checks. These primitives have source paths on both mobile targets.
rustix's libc Dir::read_from independently opens `.` then uses fdopendir, rather
than relying on a Linux `/proc/self/fd` path. No production `/proc` dependency or
production process-spawn path was found in zorid-native.

Do not weaken checks for mobile. Runtime proof must cover iOS APFS case/Unicode
aliases, Android actual filesystem identity/timestamps, moved/replaced ancestors,
symlinks/hardlinks and private directory mode. Canonical root is fixed at open;
container relocation needs a fresh host-supplied root and reopen. SQLite still
uses an absolute pathname VFS with pre/post identity checks, not a descriptor VFS.
Same-user hostile ancestor relocation remains outside the documented boundary.

## Sync and SQLite durability

Keep every stage/file and directory `sync_all` and propagate failures. Calls
occur throughout fs.rs, fs_stream.rs, native.rs, namespace.rs, directory.rs and
publication_handoff.rs; a rename-specific shim alone would not cover them.
Rust1.89 `sync_all` uses **fcntl(F_FULLFSYNC) on Apple**, including iOS, and fsync
elsewhere. Do not describe the current Apple path as plain fsync or add a
redundant full-sync shim. Directory F_FULLFSYNC behavior on the selected iOS
filesystem is an explicit runtime gate: open/init itself syncs directories.
If unsupported, a directory-only fsync policy requires a separately reviewed
durability decision; swallowing EINVAL or replacing every sync_all with fsync
would silently change guarantees.
[Pinned Rust sync implementation](https://github.com/rust-lang/rust/blob/1.89.0/library/std/src/sys/fs/unix.rs#L1129).

zorid-store unconditionally uses rusqlite0.40.2 `bundled`;
Cargo.lock pins libsqlite3-sys0.38.2. That build compiles SQLite C with
SQLITE_THREADSAFE=1. This is feasible for an embedded staticlib but still needs
actual SDK/NDK compilation and link proof. UIKit/Capacitor linkage must resolve
one intended SQLite implementation; check duplicate/interposed SQLite symbols
if system SQLite or another native plugin is linked. Bundled SQLite is not
SQLCipher and does not establish local encryption at rest.

`zorid-store/src/lib.rs`378–399 opens NOFOLLOW for native paths, sets a five-second
busy timeout, journal_mode WAL, synchronous FULL, foreign_keys ON. No new SQLite
platform cfg is indicated. `fullfsync`/`checkpoint_fullfsync` are not enabled;
SQLite's Apple sync policy is separate from Rust File::sync_all. If a stronger
power-loss contract is required, review Apple fullfsync ON explicitly (it also
covers checkpoints); it is not a prerequisite to claim ordinary process-crash
recovery. Keep power-loss claims out of mobile acceptance without evidence.
[SQLite sync pragmas](https://www.sqlite.org/pragma.html#pragma_fullfsync).

Preserve `regular_identity`'s stat-only DB/WAL/SHM/journal inspection. Opening
then closing another descriptor of a SQLite inode can drop process POSIX locks;
this is why it intentionally differs from regular(). Same-process multiple
SQLite library copies and independent host/extension processes need their own
lock/restart proof. WAL needs local shared memory and working filesystem locks;
arbitrary remote/provider storage is not established supported.
[SQLite WAL requirements](https://www.sqlite.org/wal.html),
[SQLite corruption/locking cautions](https://www.sqlite.org/howtocorrupt.html).

## Host boundaries and required runtime evidence

Android Storage Access Framework supplies provider/document URIs, not the
ordinary root Path + openat + SQLite WAL semantics this API requires. Provider
access needs a separate import/export or explicitly designed storage boundary;
do not coerce content:// into a path. iOS security-scoped folders similarly
require host-managed access lifetime and any provider coordination; this crate
does not implement bookmarks, NSFileCoordinator, protection classes or host
lifecycle scheduling.
[Android document-provider contract](https://developer.android.com/training/data-storage/shared/documents-files).

Before calling either mobile platform supported, the native owner should record:

| Gate | Evidence still required |
| --- | --- |
| Target/link | iOS device + simulator staticlib/host link; Android chosen ABI/API + NDK link, actual Rust toolchain; no stub selected |
| First open | App-private root initializes .zorid, WAL/SHM, permanent locks; every directory/file sync succeeds |
| No-clobber | File and folder destination races preserve both contents; case-only rename and late old-fd writes preserve alternatives |
| Locking | Two independent NativeVault handles contend; bounded timeout; same-client lease exclusion and release; supported independent-process/extension path if exposed |
| SQLite lock survival | Metadata verification and peer open/close preserve live DB/SHM locks and WAL; avoid assuming desktop subprocess fixtures run inside iOS |
| Recovery | Terminate at stage/write/displace/publish/DB phase boundaries; reopen exact committed bytes/checkpoints and recover pending projection |
| Lifecycle | Suspend/resume, memory termination, locked-device protected-file denial and background expiration preserve uncertain saves and retry safely |
| Scope | App-owned path first; external/provider vaults, cloud eviction and removable storage stay unsupported until separately proven |

No native/mobile runtime result is inferred from this source review or from the
first shared-core milestone. The smallest honest delivery is iOS cfg enablement
with these gates pending; Android additionally requires the flock shim above.
