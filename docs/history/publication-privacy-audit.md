# Publication privacy and artifact audit

The read-only audit covered all 442 reachable commits, 821 unique blob versions
(12.25 MB), and 428 historical paths in the local repository snapshot. It
included `main` at `2d41b32` and `integration/tab-host` at `e12c6e6`. Counts
describe that snapshot, not subsequent commits or remote repository state.

No private vault collection, note database, user screenshot, recovered
application bundle, APK, or extracted application source file was detected in
reachable history by the path, file-type, and content-pattern checks. All 28
binary blobs matched the installed upstream Capacitor template archives by
SHA-256: 27 mobile image assets and the Gradle wrapper JAR. These are template
assets, not screenshots of a user's notes.

Three documentation code fences had no exact or whitespace-normalized match in
the installed reference application archive. None of the 289 historical source
files larger than 512 bytes matched that archive as a complete file. These
checks do not prove the absence of partially copied code, transformed source,
or arbitrary personal prose. Credential scanning was a separate review and is
not certified by this report. Dependency notice completeness and legal license
compatibility are also outside this report's conclusions.

## Current-tree hygiene and historical exposure

Personal absolute home-directory paths were present in these documents at
`2d41b32` and remain in earlier reachable commits:

- `docs/reference/android-reference.md`
- `docs/history/integration-validation.md`
- `docs/reference/mermaid-reference.md`
- `docs/history/mobile-parity-next-audit.md`
- `docs/platforms.md`
- `docs/reference-evidence.md`

The current-tree cleanup replaces the home-directory prefix with `$HOME`.
Reference artifact hashes, byte offsets, and remaining evidence paths are
preserved. The ignore rules also cover local signing credentials and clearly
named root-level reference, capture, and scratch directories. Root-level
application packages are ignored; existing source fixtures and mobile PNG assets remain
eligible for tracking.

This cleanup does **not** remove historical path exposure. Publishing the
existing Git history can expose the earlier paths and Git author/committer
identity metadata. No history rewrite, identity rewrite, upload, or repository
visibility change was performed as part of this audit or cleanup. Unreachable
objects, untracked files, remote-only refs, release attachments, and future
changes were not certified.
