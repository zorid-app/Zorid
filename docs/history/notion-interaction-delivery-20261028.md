# Notion database interactions: delivery checkpoint, 2026-10-28

**In progress. This is not an installation or completion receipt.** Root is
continuing actual desktop acceptance. The reviewed source candidate is
`3b2ce849ee259a92c14177a3675f933bf5be3def` on
`codex/notion-interaction-match`, based on main `e4c8a6d0`. Root owns serialized
integration, native validation, packaging and replacement of the installed app.
This report and its [machine-readable receipt](notion-interaction-delivery-20261028.json)
record the current evidence; pending fields must be updated from actual results.

The [reference report](../reference/notion-database-interactions-20261027.md)
separates live Notion observations from static evidence and Zorid implementation.
The recovered public Notion chunk was kept outside repository source. Its old
volatile temporary directory is now gone; retained screenshots and documentation
references remain. No recovered bundle is a product dependency or copied source.

## Approved corrections and independent review

- Core `67bce4861fa3635e70a4ef7a8deb211bcc6ff6ad` (worker `f2b2572a`): preserve
  null Multi-select values during same-type schema updates. Arrays still lose
  genuinely removed option IDs only through the existing destructive-confirmation
  path. Tests cover null/[]/selected shapes, both additive targets, IDs/defaults,
  rejection rollback, exact stored content, reopen, replay and stale revisions.
  The user explicitly approved this scoped Rust fix and serialized host build.
  Independent source/test review found no must-fix issue.
- Clipboard helper `bb59446a2dd24cb4d264f58f7c86c3bf69cbd32c` (worker `a7553680`)
  and collection-only wiring `e4a2c7e7fc854295f46834e4b17f209555e0ae9e`: convert
  all eight supported types before submitting a range; retain exact IDs or reject
  ambiguous labels, distinguish null/[]/empty text and match the core's finite,
  safe-integer limits. Full-batch prevalidation precedes writes; legacy untyped
  behavior is unchanged. Independent helper review found no must-fix issue.
- Cancel cleanup `3b2ce849ee259a92c14177a3675f933bf5be3def` (worker `1f045f36`):
  Number/Date/Date-time parser errors no longer leave an orphan row alert after
  Escape. Cleanup follows the exact row's removed edit marker and waits for owned
  pending writes. Replaced rows, newer drafts and uncertain option-label failures
  retain their guards. Independent lifecycle review found no must-fix issue.

Prior table handoff, shared option creation and page-picker reviews are recorded
in the reference report. Independent source reviews do not establish native
behavior, package contents or installed persistence.

## Completed bounded checks

Persistent evidence root: `/Users/ctk/Projects/Zorid/tmp/notion-acceptance-20261028`.
The documentation worker read receipts/logs; it did not execute tests, builds or
GUI actions for this report.

| Check | Result | Evidence |
| --- | --- | --- |
| Store database integration tests | **33/33 pass**, zero ignored, 0.80s test runtime | `store-databases001.log`, `native-artifacts.json` |
| Final focused frontend checks | **324/324 pass**, zero skipped, 10.89s | `final-focused001.log` |
| TypeScript and native frontend build | **PASS**, `tsc --noEmit && vite build --mode native`; build003 completes | `frontend-build003.log`; separate cancel TypeScript log `validation-cancel-ts001.log` |
| Source-matched host and CLI | **PASS**, release/locked/offline, one job, 2m30s | `native-build001.log`, `native-artifacts.json` |

The native build uses the existing
`/Users/ctk/Projects/Zorid/tmp/local-database-target` cache, from core source
commit `67bce486` and crate tree `1a67c631324dc4af809c1a1627a197c3205849a2`.
Persistent product copies are under the evidence root's `products` directory:

| Binary | Bytes | SHA-256 |
| --- | ---: | --- |
| `zorid-desktop-host` | 27,853,168 | `d4f8bb259a4e14b172e1f7b935cd1f0bec00a8df0bed75039ce4d283c7d8aea6` |
| `zorid` | 25,419,856 | `faec50e23689dd01d895413b797cb64a2a269ac4615c5b820ea7992fd2802cf4` |

Compiler warnings and existing frontend chunk/dynamic-import warnings remain in
the logs. These bounded successful commands are not a full-suite result.

## Native CLI regression and fixture preparation

The old CLI rejected the exact additive option command with exit 2 and
`Confirm removal of values in 1 affected collection entries`. The rebuilt CLI
accepted that same command without a destructive-confirmation bypass. The new
option has a generated identity; the unrelated Multi-select member remains null,
with no pending projection or projection issue. Root established exact body
preservation for this separate disposable fixture. Evidence:
`nullable-append-command.json`, `nullable-native-red.json` and
`nullable-native-green.json`. This closes the bounded native CLI regression; it
does not close grid/page option creation or desktop all-type acceptance.

The initial CLI-populated local fixture could not be enrolled by normal desktop
startup: family enrollment intentionally requires a new empty vault with no
pending commands. The source-matched host could open that existing fixture with
initialization disabled. Root instead initialized an empty family fixture through
the normal desktop host before CLI seeding. The resulting identity/capabilities,
zero initial entries and clean host close are recorded in
`startup-fixture-diagnosis.json` and `family-startup-green.json`. No product guard
was weakened and no source fix or additional native build was needed for fixture
preparation.

During startup verification, generated `.zorid` metadata was accidentally created
under Downloads. Root narrowly reverted only metadata verified as created by this
task using its birth/client/store identity, then deleted only the matching
task-owned cache bucket. Ordinary files were neither read nor changed. Sanitized
evidence references are `default-folder-side-effect-reverted.json` and
`downloads-task-cache-cleanup.json`; private filenames are not reproduced here.

## Remaining acceptance and delivery — PENDING

| Required result | Status |
| --- | --- |
| Actual desktop clipboard transport, range conversion and input ownership | **PENDING** |
| Grid/page option creation and all eight supported datatype interactions | **PENDING** |
| Exact saved values, null/array shapes and bodies after desktop writes | **PENDING** |
| Table/List/Board and view settings/creation checks | **PENDING** |
| Normal desktop restart and persisted state | **PENDING** |
| Main integration and post-integration checks | **PENDING** |
| Source-matched package staging and exact archive/native verification | **PENDING** |
| Install/verify `/Users/ctk/Applications/Zorid.app`, replace previous bundle | **PENDING** |
| Close owned test app and record final disposition | **PENDING** |

Root fills these results from current acceptance, then records the exact
integrated/product commit, installed artifact and remaining limitations. The
standing installation instruction requires staging and verifying the replacement
before removing the previous app, while preserving vaults/preferences. No push,
iOS, Tauri, full-platform, full-suite or exact Notion parity claim is made.
