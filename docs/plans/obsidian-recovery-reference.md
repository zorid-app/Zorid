# Recovery reference and simplification

The user's 2026-10-30 direction is to match Obsidian's recovery handling and
remove extra recovery policy. It supersedes the earlier request to make every
failure invisible. Startup and redundant-indexing work remain active. Root owns
`codex/instant-editor-current`; no reference parity or installation is complete.

## Evidence and limits

REA inspected the cached Obsidian 1.14.5 artifact, SHA256
`3a349274f789b62c5b35ad19de10311909a94e8783033569c2210a4bac491780`.
Its extracted app.js SHA256 is
`95b9fd3944625c3b88116878b03d655147fed8cdfe6ddf931f2064ead78ccd5b`.
Root retained evidence: `ev_f56103a467bb6188e376c4c5697b539d32bcf961247f394a268bdd9e36d48e43`
and Bases follow-up `ev_304872f42b16ff7c0d2077c5a0ed771c2f51790ad5118883f709882460eb10bc`.
Independent follow-ups verified exact original bytes and hashes. Recovered code
stays in private temporary directories, outside the repository.

This is static evidence from the named call chains. It is not runtime fault
verification, proof this cached version was selected at launch, or proof that
all plugins/global handlers lack other behavior. Ranges below are zero-based,
half-open UTF-8 byte offsets in that exact app.js.

A bounded check of live-reference isolation found that a second user-data-dir
does not isolate the shipped macOS CLI socket: main unlinks/listens on the
home-directory socket even with CLI disabled, and may register the URL handler.
No second Obsidian was launched, no user socket/profile/handler was changed, and
no fault-runtime claim follows. Static call-chain evidence remains usable.

## Behavior established in the inspected paths

| Path | Reference behavior | Original bytes |
| --- | --- | --- |
| Adapter queue | Both success and rejection allow the next operation to run. The queue does not replay the failed operation. Desktop text write directly uses filesystem writeFile; selected chain has no temp/rename fallback. | 569823–570039; 554809–555273 |
| Text save | Coalesces requests; skips unchanged text; newer requests during a save set saveAgain. Failure restores the previous saved baseline, logs, displays a persistent notice, requests attempted-text backup, and rethrows. saveAgain drains newer requests; it is not blanket failed-write retry. | 2813133–2814052 |
| Text external change | Ignores the event while saving. Otherwise rereads; dirty plaintext can merge base/local/remote and display a changed-file notice. | 2814142–2814700; 2683916–2684103 |
| File loading | Generic BO catches the new onLoadFile failure, clears its file association, displays a notice and logs. No automatic retry in this method. Previous onUnloadFile is awaited outside that catch, so a failed unload save aborts transition. | 1537956–1538719 |
| Base configuration | Q8 extends the text view. saveQuery requests the ordinary save and updates local query state. It uses the same save-failure path. | Q8 exact UTF-16 source region 3135652–3138930, recorded in private provenance |
| Base properties and creation | Table property writes propagate failure without local replay/rollback. Undo grouping records history after success, rather than rolling back a partial filesystem sequence. Kanban drag failure restores its presentation and displays an error tooltip. New-note creation can precede a later frontmatter/presentation failure. | Additional REA evidence ev_4918236f7ff1330c85444b32c4362f399ffbdad01597f70a0cce4ccb9518305a; exact per-method ranges in private provenance |
| Embedded Base configuration | A linked .base embed debounces direct modify and lacks a local catch in that callback. A fenced Base block checks the original block before replacement and reaches the Markdown text-save path. No per-control review workflow in these inspected chains. | Additional REA evidence ev_b2c8ab9b6bd6a96c6e4194f4da91d8b5c5c69f5a904e7deeb1064cff7ab9ecd9 |
| Canvas | ste extends the text view, with non-plaintext JSON data. Inherits its save failure handling; JSON parse failure can reach the generic load catch. Plaintext merge branch does not apply. | 3428636–3432715 |
| Embedded Markdown | Reassembles the parent note and modifies it. Failure restores saved baseline, logs, requests persistent notice and attempted-text backup, then rethrows. | 2694320–2695409 |
| Snapshot policy | Enabled by default; ordinary md/canvas/base snapshots use a five-minute interval, seven-day retention, latest-content dedup. Pending paths drain each minute; expiry hourly and shortly after open. Forced backup bypasses cadence/dedup. | 3460161–3462197; 3465962–3467961 |
| Snapshot failure | IDB open failure logs; selected capture/drain/expiry methods contain no local IO retry. Forced backup failure is consumed by the FileManager bridge. Backup requests in primary save catches are not awaited. | 1338971–1339406; 1807755–1808118; 3465962–3467961 |
| Recovery browser | One path enumeration on open, one exact-path snapshot list per selection. Preview uses the already-loaded record. No local reread/backoff or availability subscription in these methods. Global rejection presentation unknown. | 3474096–3476719; 871419–871715 |
| Manual restore | Explicit selected stored text is written to its historical path; parent folder may be created; forced backup follows, then notice/list refresh. No local retry or current-content CAS in that callback. Stored paths may include deleted files. | 3472557–3473723 |
| Shutdown | Collects view saves, adapter work and configuration, prevents close while waiting, then closes. Selected aggregate has no local rejection-recovery catch. Actual failed-shutdown UX unknown. | 2896783–2897270; 1312749–1313050; 3936924–3937510 |
| Sync, separately | Backs up local text before selected remote replacement/merge paths without awaiting backup. Separate conflicted-copy branch exists. Escaped Sync failures stop that loop; per-path eligibility backs off from 10 to 300 seconds. This is not editor-save retry. | 3756208–3757058; 3745285–3747225 |

## Concrete simplification decisions

- Remove unused collection-created-presentation helper and its sole test. Its New
  consumer was never integrated. Preserved feature drafts are not shipped work.
- Remove the version-history dialog's additional retry supervisor, timers and
  availability subscription. Use one read per explicit action and retain stale
  result/close guards, snapshot identity validation and explicit restoration.
- Remove the initial note-load wrapper's additional retry policy. Preserve prompt
  cancellation, entry identity and stale-result rejection. Core recovery of an
  already accepted uncertain write is a different responsibility.
- Audit and remove bespoke configuration Review/Copy policy coherently; do not
  replace it with a new recovery framework or silently discard retained inputs.
- Freeze unintegrated New/popup/compound recovery extensions. Do not spend more
  implementation time making their custom fault campaigns pass.

Storage transactions, immutable operation identity, receipt validation, physical
write preconditions and IPC ownership checks remain required by Zorid's Rust
architecture. Their existence is not a claim about Obsidian. Existing journals,
snapshots and uncertain writes are user data; UI simplification must not delete
them or report them saved without an acknowledged outcome.

Still open: the configuration UI cut, remaining custom raw-input/reconnect/draft
presentation routes, retained-journal compatibility, integrated verification,
runtime reference checks and build/install. This document does not establish
complete parity or the 800 ms editor target.

## Implementation checkpoint

Root integrated reviewed unused-helper removal as bdf09d1b, explicit history
requests as 075d89e2, and single-attempt initial note loading as 908d5026.
Initial-load checks pass 41/41; the history dialog's scoped checks pass 20/20.
The broader history run exposed one old automatic-retry expectation (27/28).
Its explicit-action successor and unused history availability plumbing removal
are integrated as 0022fe9f; all four history suites now pass 28/28.

Separate opt-in startup diagnostics are integrated as 12064e9a/4b0741a4/eda3a95e.
Diagnostic unit checks pass 36/36; Native observer checks pass 11/11 with local
child-process access. The sandboxed Native run timed out all fake handshakes;
the access-enabled run passed, without source changes or longer timeouts.
These are observer tests, not measured startup improvement or app acceptance.

Package013 at source908d5026 passes TS, Vite and 361-file verification. ASAR SHA
`d7f871616000b2edc5f8cc4232a9bd2290e233876cfc359e14fc5ad5612bd9f7`;
unchanged verified Native SHA
`2f5851c08d5e42c18b395123e929c0b3f50b2c6dbd3a9439b966afa5602684a3`.
Actual LaunchServices diagnostic `/private/tmp/zorid-launchservices-focus-candidate013-20261030-002/report.json`
is valid: genuine window/webContents/document focus, exact fixture readiness,
one normal quit, Native exit0, no forced cleanup or remaining owned processes,
unchanged fixture/artifact. App kernel exit status is unknown separately from
observed normal app lifecycle and open-wrapper exit0. No input was sent.
One instrumented run attributes 997.4 ms to BrowserWindow construction and
436.9 ms to Native service open; Native internal reconciliation-yield phase
reports 375.455 ms. These are diagnostic intervals, not an 800 ms usable-editor
measurement, comparison, or representative first-import/large-note acceptance.
Package013 predates history plumbing removal and the configuration UI cut.

## Fresh follow-up audit — 2026-10-30

Official documentation checked at https://obsidian.md/help/plugins/file-recovery:
five-minute minimum snapshot spacing, seven-day retention, local storage outside
the vault, and explicit Copy/Restore. Its documented type list is Markdown and
Canvas; the inspected cached artifact also includes Bases, so those two sources
should not be described as identical. Current native Zorid snapshots accept only
Markdown. Existing captures use five minutes/seven days and content deduplication.
This is narrower file-type coverage, not a reason to expand this task.

Current main already contains `19d9287f` (ordinary editable Base controls in place
of bespoke Review/Copy) and `23541ed6` (ordinary failed-save backoff removal),
superseding the open implementation status above. The fresh read-only audit found
two remaining optional policies to cut: indefinite Workspace failed-readmission
backoff and independent-draft failed-backup timer retries. Initial native host
readmission and exact uncertain-write reconciliation remain architecture duties.
Access to existing protected draft versions remains to avoid stranding user data;
this is a known Zorid-specific compatibility surface, not claimed Obsidian parity.
