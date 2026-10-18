# Architecture documentation reorganization — 2026-10-18

## Scope and ownership

User requested a maintained platform-first architecture manual, separate system
files and cleanup of the cluttered docs root. Documentation coordinator owns
`tingkai-c/architecture-documentation`, based on canonical `824ddd2c`.
Native owner explicitly granted one reviewed docs/navigation-only main integration
via `msg_a61646818b43`; native implementation and its goal remain paused. No runtime
source, database, vault, dependency or generated asset changes are part of this batch.

## Result and review

Sixteen architecture pages describe desktop/browser/iOS presentation and editor,
Rust systems, storage, SQLite direction, saving/recovery, indexing/search, managed
data, sync/security, bindings/CLI and build boundaries. Current source and accepted
future direction are labeled separately. README and platform setup now route readers
to this manual instead of repeating obsolete scaffold limitations.

173 historical root documents move to reference/history folders. Their content is
preserved with relative links adjusted; the JSON relocation map supports old
cross-session paths. Root Markdown files reduce from210 to38, retaining active
coordination/contracts/plans and paths addressed by source/tests/scripts.

Independent read-only platform and core audits accepted the relevant module pages.
The platform reviewer independently confirmed source links and relocation targets.
No application build or runtime evidence is implied by documentation validation.

## Validation

- All173 relocation destinations exist and their old files are absent.
- All architecture/entry-page relative links resolve.
- Relative-link validation across README/docs introduces no missing targets.
  Nine pre-existing missing example assets, an absent old reference page and
  temporary Electron proof artifacts remain; they are not reconstructed evidence.
- `git diff --check` passes. Changes are limited to README.md and docs/.
- Source/scripts/tests references keep their original addressed root paths.

The current user sequence is saving/recovery correctness and Rust performance,
then complete desktop Bases/Tasks/Calendar/Google, then iOS. Storage migration,
parallel indexing, changed saves and Google integration remain unimplemented by
this documentation batch. The older execution records remain evidence, not
current architecture or permission to resume paused implementation.
