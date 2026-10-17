# macOS packaging

The release package uses pinned electron-builder 26.15.3 and Electron 31.6.0. Development/test installation uses the checked-in pnpm lockfile and `pnpm@12.14.0`; the repository's tests require Node 26. The packaged Electron runtime retains its separate bundled Node/Chromium versions.

The supported release artifacts are `Zorid-${version}-arm64.dmg` and `Zorid-${version}-x64.dmg`, each containing `Zorid.app` and an `/Applications` shortcut. The bundle identifier is `app.zorid.notes`, matching the existing Capacitor configuration. The minimum macOS setting is 10.15, matching the installed Electron distribution's `LSMinimumSystemVersion`; this is not a test result on Catalina. There are no Windows/Linux release targets or automatic updater implementation in this change. The application currently retains Electron's default icon; no product icon was invented for this release setup.

## Build inputs and licenses

Run `pnpm install --frozen-lockfile`, then `pnpm run build` before packaging. `pnpm run package:stage` creates a fresh `.release/app` from six explicitly named desktop modules, all compiled `dist` runtime files except source maps, the current project `LICENSE`, and a minimal generated application `package.json`. It does not copy root `node_modules`, source trees, tests, vaults, recovered reference artifacts, credentials or repository metadata. Dependencies used by the renderer are already bundled or emitted by webpack. The staging script rejects symlinks and hidden/cache directories in compiled input. Future additional desktop modules must be added deliberately to its allowlist.

The license field is AGPL-3.0-only. Staging copies the current license text rather than embedding an old copy in a script. Third-party packages retain their own terms. Existing webpack-extracted `*.LICENSE.txt` and all emitted MathJax, PDF.js, Prism, font and wasm notices remain intact. A conservative aggregate of regular production dependencies and installed peers is included as `THIRD_PARTY_NOTICES.txt`; optional native modules are not shipped. MathJax font packages that omit a standalone license use the installed MathJax Apache-2.0 license text, with each package's name, version and upstream repository retained. Electron's license and Chromium notices are separately included under `licenses/electron/`, since the packager removes the downloaded distribution's top-level copies. This is an inventory of distributed notices, not a legal opinion on license compatibility.

The corresponding source for the same version tag must accompany release binaries. The release workflow owns publication and source archives; packaging never publishes by itself.

`.release/inputs.json` records every staged application path and SHA-256 hash. The after-pack hook checks the ASAR's exact file inventory and byte contents, including renderer assets and notices. Package metadata is checked semantically because electron-builder rewrites its formatting. `pnpm run package:verify <path/to/Zorid.app>` repeats this check against a mounted DMG app or an unpacked bundle. This checks included application resources, not Apple signing/notarization or native rendering behavior.

## Signing and notarization

The release configuration requires explicit `CSC_NAME` and `CSC_KEYCHAIN`, rejects blank/ad-hoc identities and conflicting `CSC_LINK`, selects distribution signing, requires code signing, enables hardened runtime, and signs the DMG. It never reads a certificate from the repository. The workflow creates the temporary keychain and supplies credentials. Built-in automatic notarization is disabled so that the workflow can explicitly submit, wait, staple and validate both artifacts in order:

1. `pnpm run package:mac --arm64 --dir` (or `--x64`) stages and signs the app. Output is `release/mac-arm64/Zorid.app` for arm64 and `release/mac/Zorid.app` for x64.
2. The workflow archives the app, submits it to Apple's notary service, then staples and validates the accepted ticket on the app bundle.
3. `pnpm exec electron-builder --config electron-builder.cjs --mac dmg --arm64 --prepackaged release/mac-arm64/Zorid.app --publish never` creates the signed DMG around that stapled app. Use the corresponding architecture/path for x64.
4. The workflow notarizes/staples the DMG, mounts it, verifies the contained app and only then publishes both architecture assets.

The package commands always use `--publish never`. The workflow owns version-tag checks, both-architecture success requirements, release upload and Homebrew generation. Do not use an unsigned build as a release artifact.

## Local validation

`pnpm run package:mac:unsigned --arm64 --dir` produces an explicitly unsigned local bundle. Omitting `--dir` also exercises DMG creation and its Applications shortcut. This mode sets a dedicated override, disables identity discovery and hardened runtime, and clears signing variables in its child environment; it does not import or inspect certificates. It cannot establish Developer ID, notarization, Gatekeeper or Intel runtime correctness.

Run `node --test --test-concurrency=1 tests/desktop-package.test.mjs` for focused staging, dependency-notice, input-symlink, archive inventory/hash and signing-default tests. Heavy builds and packaging runs must remain serialized on the local 8 GB machine. Any native smoke pass must use an isolated test vault/profile and close the owned Electron process afterward.

The configuration follows the pinned tool's [macOS documentation](https://www.electron.build/v26/docs/mac/), [DMG layout options](https://www.electron.build/v26/docs/dmg/), and [file selection rules](https://www.electron.build/v26/docs/configuration/). Electron describes signing and notarization as distinct steps in its [code-signing documentation](https://www.electronjs.org/docs/latest/tutorial/code-signing). These links describe tool behavior; successful signed CI release verification is still required.

The isolated implementation pass installed the frozen dependencies with lifecycle scripts disabled, passed all eight focused tests and five additional independent reviewer probes, and passed the pinned electron-builder configuration schema check. An unsigned bundle attempt stopped while copying the existing Electron distribution because local disk space ran out, before electron-builder ran. The incomplete copies were removed. No `.app` or DMG packaging, native packaged runtime, Developer ID signing, notarization, or Gatekeeper result is claimed by those tests.
# Dependency installation

Run `pnpm install --frozen-lockfile` explicitly before building. The workspace
uses `verifyDepsBeforeRun: error` so running a build or test cannot unexpectedly
reinstall dependencies shared by active development worktrees. Electron's
install script is allowed; the transitive `electron-winstaller` script is
explicitly skipped because the current release pipeline packages macOS only.
Windows packaging needs its own reviewed install/build configuration.
