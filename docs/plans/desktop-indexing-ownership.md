# Desktop indexing ownership cleanup

## Scope and ownership

2026-10-20 user steering: desktop only; native mobile resumes after desktop and
sync are solid. This implements the accepted desktop capability requirement,
not a new scheduler, Rust rewrite or mobile migration.

Owner: architecture root. Branch `codex/desktop-rust-maintenance`; isolated
worktree `/private/tmp/zorid-desktop-rust-maintenance`, baseline `37ed616e`.
`complexity_pipeline` owns `desktop/core-vault-fixture-service.cjs` and its focused
check file. `complexity_workspace` owns `desktop/editor-core.cjs` and its focused
check file. Root owns records and composition. Shared-core coordinator retains
sole main integration; this checkout does not mutate main or push.

## Contract

- Normal desktop explicitly requests Rust maintenance. Missing `documents` or
  `document_runtime` capability rejects opening before initialization/mutation,
  closes the opened host and supplies restart/update guidance.
- Requested maintenance also requires a complete admitted runtime, document
  commands and scoped notification route. Failed admission is retired and must
  not leave a cached usable context or prevent a later valid admission.
- Explicit runtime-disabled fixtures retain existing behavior. iOS, Android,
  browser, CLI and the shared fallback are unchanged by this patch.
- Preserve Rust ownership of retries/rebuilds/cancellation and feature-specific
  freshness requirements. Existing Rust scheduling is reused, not duplicated.

## Verification

Implementation is complete in the isolated branch; main integration is pending
with the shared-core coordinator. Reciprocal independent source reviews found no
blockers. Root owns the additional runtime-admission assertion correction.

- Worker check: `node --test --test-concurrency=1 tests/core-vault-fixture-service.test.cjs`:
  13/13 pass.
- Worker check: `node --test --test-concurrency=1 tests/desktop-editor-core.test.cjs`:
  18/18 pass.
- Composed check: `node --test --test-concurrency=1 tests/core-vault-fixture-service.test.cjs tests/desktop-editor-core.test.cjs tests/desktop-client-admission.test.cjs tests/desktop-document-runtime-admission.test.cjs`:
  55/56 pass initially. One runtime-admission assertion expected the replaced
  generic error code. Source behavior matched the new contract; the assertion
  now requires the new code and actionable message.
- Final affected rerun: `node --test --test-concurrency=1 tests/desktop-document-runtime-admission.test.cjs`:
  11/11 pass, no skips. Other 45 composed checks passed on unchanged inputs;
  only this assertion changed after that run. Final coverage is 56 distinct
  checks, not a claim that the entire 56-check command reran green.
- `git diff --check` passes. No TypeScript or Rust source changed, no builds run.

No native app, WASM, mobile or full S1 acceptance is claimed. A matching-host
normal desktop smoke and the real missing-host startup path remain integration
verification, owned by the shared-core coordinator; do not interrupt its ongoing
campaign or describe focused Node checks as actual app acceptance.
