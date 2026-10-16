# macOS version releases

The canonical build trigger is a newly pushed `v<version>` tag. The workflow has no branch, pull-request, manual-dispatch or release-created build trigger. Validation requires strict SemVer and exact equality with `package.json`; deleted tags and already released versions cannot publish. A malformed `v*` tag runs only validation and fails before the packaging jobs. Do not push a release tag until the repository privacy audit, license/source review and credential setup are complete. No release or tag is created by this change.

## Products and build sequence

`.github/workflows/release-macos.yml` builds separate **arm64** and **x64** DMGs on native `macos-15` and `macos-15-intel` runners. Separate images keep downloads smaller and avoid merging architecture-specific Electron binaries into a universal app. The public asset names are:

- `Zorid-<version>-arm64.dmg`
- `Zorid-<version>-x64.dmg`
- `Zorid-<version>-source.tar.gz`
- `SHA256SUMS`
- `release-manifest.json`

The signed path uses electron-builder's packaging contract: `pnpm run package:mac --arm64 --dir` (or `--x64`), then notarizes/staples the signed app, then builds the signed DMG with `--prepackaged` and `--publish never`. It separately notarizes/staples the disk image. Verification requires the expected Developer ID identity, secure timestamp, app hardened runtime, code-signature verification, Apple `Accepted`, valid stapled tickets, Gatekeeper assessment, DMG integrity, matching mounted app identifier/version/architecture, packaged ASAR manifest verification, and the `/Applications` drag destination. Any failure prevents that architecture's artifact upload and therefore release publication. This workflow never calls the explicitly unsigned local packaging command.

Both architecture jobs must finish successfully before a separate job can publish. It downloads only those jobs' immutable workflow artifacts, computes checksums, creates a source archive and provenance manifest, uploads all assets into a draft, verifies their uploaded names/sizes and available GitHub digests, and then publishes. Failed uploads leave an unpublished draft for review; they do not expose a partial release. Inspect and remove a failed draft before deliberately rerunning that version. Published release assets are never overwritten automatically.

The repository-wide token defaults to `contents: read`; only the publication job receives `contents: write`. Checkout credentials are not retained. The built-in `GITHUB_TOKEN` is sufficient for same-repository publication. There is no cross-repository token, public-repository creation, visibility change, or Homebrew tap mutation in this workflow.

## Signing inputs and cleanup

Root owns certificate/key preparation and GitHub secret upload. The workflow expects these repository secrets; no actual credentials belong in tracked files:

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64 export of the Developer ID Application signing certificate and private key |
| `MACOS_CERTIFICATE_PASSWORD` | Password protecting that export |
| `MACOS_SIGNING_IDENTITY` | Full identity, `Developer ID Application: Name (TEAMID)` |
| `APPLE_API_KEY_P8_BASE64` | Base64-encoded App Store Connect **team** API private key in PEM format |
| `APPLE_API_KEY_ID` | Team API key ID |
| `APPLE_API_ISSUER_ID` | Team API issuer UUID |

Credentials are decoded only after tests/build pass, into a per-run/per-attempt/per-architecture directory under `RUNNER_TEMP` with mode 0700; private files use mode 0600. The signing certificate is imported into a fresh password-protected temporary keychain, which is explicitly selected through `CSC_KEYCHAIN` and `CSC_NAME`; the global default keychain and search list are not changed. The decoded P12 is removed after import. A step guarded by `always()` deletes the keychain and P8 after success or failure, before any artifact upload. The runner is ephemeral; cleanup cannot be guaranteed after abrupt runner loss, so persistent self-hosted runners are not part of this design. A failed detach never recursively deletes a mounted volume. Command failures omit credential-bearing arguments and private output.

Only the team API-key authentication path is implemented. Individual API keys and Apple-ID/password notarization are not silently substituted. The workflow does not print or upload signing credentials, notary private keys or signing work directories.

## Tag integrity and corresponding source

Configure a repository ruleset protecting `v*` tags from update/deletion and restricting who can create them. Publication authenticates against GitHub, resolves lightweight or annotated tags to a commit, and requires that commit to equal the build's `GITHUB_SHA` immediately before draft creation and again immediately before promotion. Moved tags fail closed. These checks complement immutable tag rules; they are not an atomic server-side lock against an administrator moving a tag between API calls.

The release carries matching corresponding source and build/release scripts for the approved **AGPL-3.0-only** project. `git archive` operates on the exact checked-out `GITHUB_SHA`, with a `Zorid-<version>/` prefix. It includes tracked source, license, package metadata, dependency lockfile, packaging configuration and build/release scripts; it excludes untracked vault data, generated build output and temporary credentials. The archive's digest appears alongside both DMG digests in `SHA256SUMS`; the manifest records commit, tag, workflow path, run ID/attempt, names, sizes and hashes. Release notes link the exact tag's source and identify the explicit archive. A tag's tracked contents must pass the separate privacy audit before release. Dependency source/licensing completeness remains part of the packaging/license review; the archive is not a substitute for third-party license obligations.

Strict SemVer includes prerelease/build identifiers. Prereleases are marked as such and never promoted as latest; stable Homebrew generation excludes them. The package version is checked against the mounted app's version verbatim. Apple's acceptance of nonnumeric bundle-version variants has not been exercised; rejection fails closed. Prefer a stable numeric version for the first reviewed release unless a prerelease has been validated separately.

## Homebrew and validation limits

Homebrew consumes the successfully published release and `SHA256SUMS` through the separately maintained cask generator/tap updater. The release manifest lets that updater check the exact successful workflow run and source commit. This workflow does not build Windows/Linux/mobile artifacts; those distributions remain discussion-only.

Local validation uses bounded tests: `node --test --test-concurrency=1 tests/release-*.test.mjs`. They exercise strict version checks, immutable action/trigger permissions, partial credential cleanup with synthetic data, rejected notarization, mounted-image failure cleanup, both-architecture gates, checksums, draft publication and moved-tag rejection. Tests do **not** read real certificates or contact Apple's notary service. Real signing, notarization, GitHub release publication and Homebrew installation remain unverified until an authorized version tag runs with reviewed secrets.

## Official source pins

Action references were resolved from the maintainers' GitHub tag APIs on 2026-10-16, including peeling pnpm's annotated tag to its commit. All workflow actions use immutable commit SHAs:

| Action | Commit |
| --- | --- |
| [actions/checkout](https://api.github.com/repos/actions/checkout/git/ref/tags/v4) | `11d5960a326750d5838078e36cf38b85af677262` |
| [actions/setup-node](https://api.github.com/repos/actions/setup-node/git/ref/tags/v4) | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| [pnpm/action-setup](https://api.github.com/repos/pnpm/action-setup/git/tags/f40ffcd9367d9f12939873eb1018b921a783ffaa) | `b906affcce14559ad1aafd4ab0e942779e9f58b1` |
| [actions/upload-artifact](https://api.github.com/repos/actions/upload-artifact/git/ref/tags/v4) | `ea165f8d65b6e75b540449e92b4886f43607fa02` |
| [actions/download-artifact](https://api.github.com/repos/actions/download-artifact/git/ref/tags/v4) | `d3f86a106a0bac45b974a628896c90dbdf5c8093` |

Runner architecture labels are confirmed by [GitHub's runner-images inventory](https://github.com/actions/runner-images#available-images). Apple's [notarization guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) requires Developer ID signing, hardened runtime and secure timestamps and describes ticket stapling; the workflow uses the current `notarytool` path rather than retired `altool`.
