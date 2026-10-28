# Bases refresh and select stability — 2026-10-27

User finding: Bases flashes Updating around once a second; the Select field also
flashes. Fix the cause and replace the installed app under the standing rule.

## Feedback loops and causes

`node --test --test-concurrency=1 tests/bases-refresh-stability.test.ts` initially
failed both real BaseSession regressions: three equal refreshes produced three
Updating announcements and replaced the managed Select cell. Red002/003 are
retained; first001 only failed fixture setup and is not symptom evidence.

The one-variable held-schema probe isolated table replacement to schema reply:
clearing live authority was not itself the remount; every equal response advanced
the presentation revision. Public refresh and controller publication could also
start duplicate reads. Ordinary note renderer-only and actual
Vault→NotePropertyTargets→renderer Select loops stayed stable across 60 equal
refreshes, so no unrelated ordinary-note renderer change was made.

Rust source audit found the exact cadence: every explicit-source view was forced
to Instant, including static collection/untyped views. A1s deadline then reached
the controller correctly. Summary previews had the same blanket fallback.

The core red command was:

```sh
cargo test --release --locked --offline --jobs 1 \
  --target-dir /Users/ctk/Projects/Zorid/tmp/local-database-target \
  -p zorid-bases --test refresh_hints explicit_ -- --test-threads=1
```

Original source: **0/3 pass**, Instant instead of None/Day. First green attempt
exposed an incorrect new-test oracle: unsupported `values.count()` conservatively
means Instant. Correcting only the fixtures to supported `values.length` gave
**9/9 refresh-hints and 12/12 view-source checks pass**. Conservative analyzer
fallbacks were preserved.

## Reviewed changes

- Core `aaea9e54`, composed as `86466ce8`: analyze each explicit view's own
  formulas/filter/selected summaries, and its own summary-preview definitions.
  Static views have no deadline; now/today retain Instant/Day. Legacy root scope,
  work budget and conservative unknown-expression behavior remain. Compiler v11
  prevents old compiled scheduling meaning from being reused.
- Frontend `7008cb5c`: retain mounted controls through background revalidation;
  coalesce only an exact context/configuration-read lookup; compare settled
  schema/member/error presentation before changing its revision. Live authority
  still clears and editing is blocked while schema loads or fails. Real changes
  still render. Existing-result Updating appears after 350ms; initial loading,
  real failures and slow refresh activity remain visible. Timers retire on close.

Independent scoped review found no must-fix issues in either change. Frontend
59/59 focused and 2/2 targeted legacy checks pass, plus TS/native frontend build.
Main post-integration59/59 +TS pass.

## Native and installed verification

The serialized `--jobs 1` release build produced the matching host and standalone
CLI from integrated candidate `86466ce8`; all 318 captured Rust source hashes
stayed unchanged. Exact crate/Cargo trees and binary hashes are in the adjacent
[delivery receipt](bases-refresh-stability-20261027.json).

Old/new native CLI queries over the same committed static fixture and clock 0
return Instant/1000ms versus None/null. Native baseline runs the previous installed
ASAR/host through a separate Electron process against a disposable clone of an
earlier verified desktop vault. It records 100 AX samples over 4.702s:9 Updating
samples and 1 table/control replacement sample. The initial newly CLI-initialized
fixture could not open in desktop (invalid_request); it remains separate evidence
and is not counted as a desktop pass.

Fixed normal source Electron: 80 samples over 3.281s, zero Updating or table/control
replacement samples. The real Status picker retains search, saves Done via Enter,
and the projected Markdown body remains exactly `Picker body remains exact.\n`.
An earlier quiet 56.5s sample had DevTools docked; it is excluded from normal-layout
proof. Native window image exports were intermittently blank, so no blank image
is offered as visual proof.

The 356-file verified package was staged and installed at
`/Users/ctk/Applications/Zorid.app`, then verified from that exact installed path
with the disposable profile and normal renderer. Restart restores Done; 80 samples
over 3.698s show zero Updating/replacement samples. Normal quit exit 0. The previous
bundle is deleted after successful launch verification. Real vaults/preferences
are preserved. No owned test app remains; no push, iOS or Tauri work.

## Limits

This is bounded desktop acceptance, not a full suite, all layouts, mobile or web
claim. The broader Rust library run had 175 pass/30 preparation cases fail at the
same old corpus `InvalidVersion` before Base compilation; a representative case
reproduces unchanged on the baseline core. Existing JS ordinary-note edit and
hidden-pane refresh fixtures also fail or time out on unchanged main. Those
failures remain recorded rather than being counted as passes or repaired within
this scope. Logs and native observations are under
`/private/tmp/zorid-bases-refresh-20261027`.
