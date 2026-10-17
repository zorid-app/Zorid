# macOS packaging

The release package uses pinned electron-builder 26.15.3 and Electron 44.8.0. Development/test installation uses the checked-in pnpm lockfile and `pnpm@12.14.0`; the repository's tests require Node 26. The packaged Electron runtime retains its separate bundled Node/Chromium versions.

The supported release artifacts are `Zorid-${version}-arm64.dmg` and `Zorid-${version}-x64.dmg`, each containing `Zorid.app` and an `/Applications` shortcut. The bundle identifier is `app.zorid.notes`, matching the existing Capacitor configuration. The minimum macOS setting is 13.0 (Ventura), matching Electron 44's runtime requirement; this is not a test result on Ventura. There are no Windows/Linux release targets or automatic updater implementation in this change. The application currently retains Electron's default icon; no product icon was invented for this release setup.

## Build inputs and licenses

Run `pnpm install --frozen-lockfile`, then `pnpm run desktop:install --arm64` (or `--x64`) and `pnpm run build` before packaging. The explicit installer verifies the pinned macOS executable architecture and runtime notices; packaging and staging do not download a missing runtime. Use a separate dependency installation per architecture. `pnpm run package:stage` creates a fresh `.release/app` from six explicitly named desktop modules, all compiled `dist` runtime files except source maps, the current project `LICENSE`, and a minimal generated application `package.json`. It does not copy root `node_modules`, source trees, tests, vaults, recovered reference artifacts, credentials or repository metadata. Dependencies used by the renderer are already bundled or emitted by webpack. The staging script rejects symlinks and hidden/cache directories in compiled input. Future additional desktop modules must be added deliberately to its allowlist.

The license field is AGPL-3.0-only. Staging copies the current license text rather than embedding an old copy in a script. Third-party packages retain their own terms. Existing webpack-extracted `*.LICENSE.txt` and all emitted MathJax, PDF.js, Prism, font and wasm notices remain intact. A conservative aggregate of regular production dependencies and installed peers is included as `THIRD_PARTY_NOTICES.txt`; optional native modules are not shipped. MathJax font packages that omit a standalone license use the installed MathJax Apache-2.0 license text, with each package's name, version and upstream repository retained. Electron's license and Chromium notices are separately included under `licenses/electron/`, since the packager removes the downloaded distribution's top-level copies. This is an inventory of distributed notices, not a legal opinion on license compatibility.

The corresponding source for the same version tag must accompany release binaries. The release workflow owns publication and source archives; packaging never publishes by itself.

`.release/inputs.json` records every staged application path and SHA-256 hash. The after-pack hook checks the ASAR's exact file inventory and byte contents, including renderer assets and notices. Package metadata is checked semantically because electron-builder rewrites its formatting. `pnpm run package:verify <path/to/Zorid.app>` repeats this check against a mounted DMG app or an unpacked bundle. This checks included application resources, not Apple signing/notarization or native rendering behavior.

Electron Builder's separate dependency collector can fall back from the minimal staged app to the repository's production dependencies. The packaging configuration explicitly excludes all `node_modules` paths from that collector. A regression test exercises the pinned collector against an original fixture containing a native dependency; the unfiltered control collects it and the release configuration collects no dependency files. The exact ASAR verifier remains mandatory and rejects any unexpected files.

## Signing and notarization

The release configuration requires explicit `CSC_NAME` and `CSC_KEYCHAIN`, rejects blank/ad-hoc identities and conflicting `CSC_LINK`, selects distribution signing, requires code signing, enables hardened runtime, and signs the DMG. It never reads a certificate from the repository. The workflow creates the temporary keychain and supplies credentials. Built-in automatic notarization is disabled so that the workflow can explicitly submit, wait, staple and validate both artifacts in order:

1. `pnpm run package:mac --arm64 --dir` (or `--x64`) stages and signs the app. Output is `release/mac-arm64/Zorid.app` for arm64 and `release/mac/Zorid.app` for x64.
2. The workflow archives the app, submits it to Apple's notary service, then staples and validates the accepted ticket on the app bundle.
3. `pnpm exec electron-builder --config electron-builder.cjs --mac dmg --arm64 --prepackaged release/mac-arm64/Zorid.app --publish never` creates the signed DMG around that stapled app. Use the corresponding architecture/path for x64.
4. The workflow notarizes/staples the DMG, mounts it, verifies the contained app and only then publishes both architecture assets.

The package commands always use `--publish never`. The workflow owns version-tag checks, both-architecture success requirements, release upload and Homebrew generation. Do not use an unsigned build as a release artifact.

## Local validation

Electron 44 uses the explicit `desktop:install` bootstrap before staging. It invokes the installed package's `install-electron` entry point without launching the app, checks the project pin, executable CPU type, path marker, version and notices, and rejects custom download/distribution overrides. It uses the package's published checksums. Existing wrong-architecture installations fail with an instruction to use a separate installation; they are never silently replaced. CI bootstraps its matrix architecture before testing, building or importing signing credentials. See the [Electron 44 checkpoint](electron44-upgrade-validation.md) for observed results and remaining gates.

`pnpm run package:mac:unsigned --arm64 --dir` produces an explicitly unsigned local bundle. Omitting `--dir` also exercises DMG creation and its Applications shortcut. This mode sets a dedicated override, disables identity discovery and hardened runtime, and clears signing variables in its child environment; it does not import or inspect certificates. It cannot establish Developer ID, notarization, Gatekeeper or Intel runtime correctness.

Run `node --test --test-concurrency=1 tests/desktop-package.test.mjs` for focused staging, dependency-notice, input-symlink, archive inventory/hash and signing-default tests. Heavy builds and packaging runs must remain serialized on the local 8 GB machine. Any native smoke pass must use an isolated test vault/profile and close the owned Electron process afterward.

The configuration follows the pinned tool's [macOS documentation](https://www.electron.build/v26/docs/mac/), [DMG layout options](https://www.electron.build/v26/docs/dmg/), and [file selection rules](https://www.electron.build/v26/docs/configuration/). Electron describes signing and notarization as distinct steps in its [code-signing documentation](https://www.electronjs.org/docs/latest/tutorial/code-signing). These links describe tool behavior; successful signed CI release verification is still required.

The Electron 31.6.0 implementation passed nine focused tests, five additional independent reviewer probes, and the pinned electron-builder configuration schema check. A real unsigned arm64 directory package then passed the mandatory after-pack verifier and a separate verification command: 328 application files, a 21 MiB ASAR, and a 246 MiB `Zorid.app`. The generated bundle identifier and version matched `app.zorid.notes` and `0.1.0`. This local check reused the installed Electron distribution through `--config.electronDist=node_modules/electron/dist` and the existing compiled renderer; it establishes packaging inventory, not the behavior of subsequent source changes.

That preserved app was packaged into a 96 MiB unsigned `Zorid-0.1.0-arm64.dmg`, mounted read-only, and passed the same 328-file verification. Its `Applications` symlink resolved exactly to `/Applications`; the volume detached successfully afterward. The native arm64 smoke pass launched the packaged app, restored a disposable vault and split workspace, played audio with an advancing scrubber, and quit normally. These checks used the earlier compiled renderer, before the subsequent Canvas integration build. They do not establish native drag-install behavior, Intel runtime, Developer ID signing, notarization or Gatekeeper acceptance.

# Dependency installation

Run `pnpm install --frozen-lockfile` explicitly before building. The workspace
uses `verifyDepsBeforeRun: error` so running a build or test cannot unexpectedly
reinstall dependencies shared by active development worktrees. Electron's
runtime is installed explicitly with `pnpm run desktop:install`; Electron 42+ no longer downloads it through postinstall. The transitive `electron-winstaller` script is
explicitly skipped because the current release pipeline packages macOS only.
Windows packaging needs its own reviewed install/build configuration.
