# Credential publication audit

Audit date: 2026-10-16. This is a local, read-only review of publication
candidate `5bab1b7173a7cd721658306c5f151e1e84961712` and its reachable history.
It does not cover concurrent uncommitted changes or later commits.

## Result and captured scope

No confirmed credentials, private signing keys, tracked credential files, or
new private-note/proprietary-artifact paths were identified within this scope.
This finding is not a guarantee that no sensitive information exists.

- Main history: 287 commits, 856 unique blobs, 12,407,276 blob bytes;
  28 binary blobs scanned for credential signatures; no size-based skips.
- Every historical tree was checked for sensitive filenames: 455 unique
  paths, with no credential/signing-file path matches.
- Delta from `64a7eeab695ef09eb13df7d17d91941c19ddd5cf`: 39 changed paths,
  including packaging `e5994b7`, release workflow
  `274d6f7f103867ad0cda0eb6e4cb5d2e53859cc0`, Homebrew
  `d573a1fee2cbed4bf66d5f55741fd26f2ad17e0c`, and media/documentation
  updates through `bd832cfcc0405b3f331f37a2f895200e45d9fb6d`.
- Changed blob versions contain no new binary artifacts, absolute personal
  home paths, or recognized private-vault path references. Generated package
  outputs were not part of this committed-source audit.

## Method and reviewed false positives

No local gitleaks or trufflehog installation was available. Local structured
byte/text scans checked every reachable blob and commit message for common
provider-token formats, private-key envelopes, authorization headers,
credential-bearing URLs, credential assignments, and sensitive filenames.
A second pass checked broader assignment forms and high-entropy literals.
No repository content was uploaded, and no matched credential values or
private content were printed in the review report.

Eight signature matches were reviewed as false positives:

- Three historical versions of the synthetic URL-boundary fixture in
  `tests/editor-transfers.test.ts`.
- A private-key envelope validation string in
  `scripts/release/macos-release.mjs`, plus a short invalid key fixture in
  `tests/release-macos.test.mjs`. The fixture fails local cryptographic parsing.
- Three short mock token assignments in `tests/release-publish.test.mjs`;
  the exercised requests use injected mock responses.

The broader pass screened 244 quoted literals and produced 61 review
candidates. These were parser/control token expressions, password-entry UI
callbacks, ordinary wording, workflow credential-persistence booleans,
environment-loaded signing inputs, and randomly generated temporary
keychain passwords. Three entropy candidates in
`tests/desktop-package.test.mjs` were repetitions of a local filesystem
fixture path. No usable credential literal was identified.

## Limits and publication gate

This is a heuristic source/history audit, not a comprehensive security
assessment. Binary blobs received signature checks, not archive extraction
or decryption; the separate provenance audit records their origin.
Unreachable objects, reflogs, ignored/untracked files, concurrent working
changes, signing services, and generated release packages are outside this
main-publication scope. See `publication-privacy-audit.md` for personal-data
and proprietary-artifact findings and the earlier GitHub surface inventory.

Scan new commits before pushing them. Review generated distributable contents
before uploading release assets; this source audit does not certify a future
package. No visibility, publishing, history-rewrite, or deletion action was
performed by this audit.
