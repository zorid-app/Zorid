# Homebrew distribution

The prepared distribution is a public `zorid-app/homebrew-tap` repository containing `Casks/zorid.rb`. Homebrew removes the `homebrew-` prefix when resolving the short tap name, so the eventual install command is `brew install --cask zorid-app/tap/zorid`. The skeleton is in `assets/homebrew-tap`; it intentionally contains no fabricated cask or placeholder checksums before a valid release exists. Homebrew documents both [custom taps and their Casks directory](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap) and [architecture-specific cask URLs and SHA-256 values](https://docs.brew.sh/Cask-Cookbook#handling-different-system-configurations).

## Release contract

The canonical source and release repository is `zorid-app/Zorid`. Stable tags have the exact form `vMAJOR.MINOR.PATCH`, with no prerelease/build suffix or leading zero components. The signed and notarized release contains:

- `Zorid-VERSION-arm64.dmg` and `Zorid-VERSION-x64.dmg`, each containing `Zorid.app`.
- `Zorid-VERSION-source.tar.gz`, the corresponding source archive.
- `SHA256SUMS`, with SHA-256 entries for the three artifacts.
- `release-manifest.json`, schema version 1, recording repository, version, tag, source commit, workflow path, run ID, run attempt, and each artifact's name/size/SHA-256.

The cask selects the correct DMG architecture, pins both hashes, and requires macOS Ventura (13) or newer, matching the Electron 44 packaging floor. It uses the ordinary `app` artifact and no installer hooks, quarantine bypass, `:no_check`, `:latest`, or user-data removal commands. No Windows/Linux/mobile packaging is added here.

The source release workflow owns building, signing, notarization, checksum generation, and publishing. The source-side wrapper can generate a cask after publication using:

```sh
node scripts/generate-homebrew-cask.mjs \
  --release-json release.json \
  --checksums SHA256SUMS \
  --output zorid.rb
```

`release.json` must be the full GitHub REST release response, not a reduced `gh release view` projection. The generator checks stable publication state, exact repository/tag URLs, required uploaded assets and their positive sizes, SHA256SUMS file size, checksum syntax/uniqueness, and GitHub asset digests when available. `--current-cask Casks/zorid.rb` additionally prevents downgrades and same-version content replacement. Without `--output`, the validated cask goes to stdout. Invalid input is rejected before the destination is replaced. The [GitHub release API](https://docs.github.com/en/rest/releases/releases) defines the publication and asset metadata used here.

## Tap update workflow

The tap's `update-cask.yml` runs at minute 17 every six hours, plus manual dispatch on `main`. This is metadata polling, not scheduled building. It downloads only release JSON, the small checksum/manifest files, tag metadata, and the exact recorded workflow attempt. It requires the canonical source repository, `.github/workflows/release-macos.yml`, push event, triggering tag name, commit, run ID/attempt, and completed successful result to agree. Annotated tags are peeled through a bounded chain. The source archive is checked alongside both DMGs. The updater always reads any current cask before rendering the next one. A release whose source workflow is still running waits for the next check; absent releases are a no-op. Publication inconsistencies fail without changing the cask.

The workflow only stages `Casks/zorid.rb` and commits when it changes. It uses the tap's own `GITHUB_TOKEN` with `contents: write`; public source metadata requests carry no credentials. A source-repository `GITHUB_TOKEN` cannot write an unrelated tap, so this pull model avoids a cross-repository PAT, deploy key, GitHub App, or organization-wide authorization. See [GitHub's token authentication documentation](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token). Updates are normally available within six hours, or immediately after a maintainer manually dispatches the tap workflow once the source run succeeds.

The trust boundary is the project's release maintainers. Published metadata, checksum matches, and a successful run/tag consistency check do not cryptographically bind released bytes to a build: a release editor could replace release assets and metadata. The updater does not claim artifact attestation or independently assess DMG signatures. Once a cask version is committed, replacing its content with different checksums is rejected. Correcting a release requires a new version. Source signing/notarization checks and Homebrew's pinned download checks serve distinct purposes.

## Activation owned by the release coordinator

Activation remains held until the user's source-history privacy audit and AGPL-3.0-only license change are cleared. No tap/release/tag is created by this implementation. After approval, the coordinator must:

1. Create or inspect public `zorid-app/homebrew-tap` and its `main` branch using the existing authorized GitHub account. Copy the contents of `assets/homebrew-tap/` into it, including its hidden `.github` directory, and copy the canonical source repository `LICENSE` to the tap root. Review and push that concrete tree.
2. Enable Actions with permission for this workflow's `contents: write`, and allow its bot to update the tap's `main` branch under the chosen branch rules. No extra token secret is required. If direct bot pushes are prohibited, adapt publication to the organization's approved pull-request flow before enabling the schedule.
3. Complete source release signing/notarization credentials and the approved version-tag release separately. Wait for both architectures, source archive, publication, and source workflow completion.
4. Dispatch the tap updater, review the generated cask commit, and run Homebrew audit/installation on a suitable Mac. Verify installation, launching, upgrade behavior when a later release exists, and uninstall while preserving vaults. Do not claim Intel installation from an Apple Silicon-only test.

The earlier sandboxed `gh auth status` reported an invalid session; the root release coordinator must assess its actual authorized session before network mutations. Public tap existence was not established by this worker. The repository name is a concrete target, not a claim that it already exists.

## Verification status

Focused Node tests cover strict release/asset/checksum validation, Ruby syntax, numeric version ordering, atomic writes, exact manifest/run/tag gates, annotated-tag peeling, metadata-only requests, current-cask protection, publication waiting, and response size limits. The actual GitHub API tag-run response for public `sharkdp/bat` run `19872995895` reported `head_branch: v0.26.1` with `event: push`; this confirms the tag-name gate's API shape, not a Zorid live run. Action commit pins were checked by the release-workflow owner against official repository refs.

No tap publication, live source release, Homebrew installation/audit, codesign/notarization result, Intel/native launch, or updater run against a published Zorid release has been verified in this change.
