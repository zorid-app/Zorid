# Desktop release runtime readiness

Reviewed 2026-10-16. This records the Electron 31.6.0 baseline and the dependency triage at `500c3be`; it does not select or install an upgrade. The minimum supported macOS version remains a product decision. Successful local unsigned packaging and native smoke checks are recorded in [desktop packaging](desktop-packaging.md), separately from runtime security readiness.

## Current release constraint

Electron 31 is outside Electron's [latest-three-major support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines). The triage returned 36 open Electron alerts: 11 high, 20 medium and 5 low. This snapshot is not a complete lockfile or Chromium security audit, and alert counts can change.

Although `package.json` lists Electron under `devDependencies` and GitHub labels the alerts as development scope, `electron-builder.cjs` reads that exact pin into `electronVersion`. The distributed app contains that Electron/Chromium/Node runtime. Excluding project `node_modules` from the ASAR does not remove it. A supported, validated runtime upgrade is still needed before treating the desktop release as ready; clearing one advisory range on another unsupported major is insufficient.

Current host evidence in `desktop/main.cjs`, `desktop/preload.cjs` and `desktop/window-broker.cjs` includes sandboxing, context isolation, disabled renderer Node integration, denied popups, restricted navigation, and authenticated main-frame IPC senders. CSP and literal Markdown HTML handling reduce script entry opportunities. These controls do not patch Electron or prove the absence of renderer script injection.

## Advisory prerequisites in this host

| Primary advisory | Prerequisite and current assessment |
| --- | --- |
| [Context isolation bypass, GHSA-h7rp-cf8h-j98x](https://github.com/electron/electron/security/advisories/GHSA-h7rp-cf8h-j98x) | The preload exposes Promise-returning `ipcRenderer.invoke` wrappers. If an attacker can execute JavaScript in that renderer, the advisory describes access to the isolated preload world. No such entry point was demonstrated in this review. The sandbox remains enabled; do not infer an automatic full Node escape. This is the most directly relevant conditional risk identified. |
| [Prototype setters across contextBridge, GHSA-ff2p-hmqr-hxm4](https://github.com/electron/electron/security/advisories/GHSA-ff2p-hmqr-hxm4) | Requires preload code to accept attacker-controlled objects and read their properties without own-property validation. Current wrappers forward objects to IPC; the audit found no corresponding application-level preload property reads. Reassess when adding bridge behavior. |
| [Popup sandbox inheritance, GHSA-gr2m-v5gq-v685](https://github.com/electron/electron/security/advisories/GHSA-gr2m-v5gq-v685) | Requires untrusted sandboxed content with popups allowed. The host denies every Electron popup, matching the advisory workaround. |
| [DevTools file execution, GHSA-f2r8-jv7c-xqmp](https://github.com/electron/electron/security/advisories/GHSA-f2r8-jv7c-xqmp) | Requires a separate means of executing script in DevTools, such as a malicious DevTools extension. The View menu permits opening DevTools; no extension loader was found. Ordinary DevTools availability alone does not establish exploitation. |
| [ASAR integrity bypass, GHSA-vmqv-hx8q-j7mg](https://github.com/electron/electron/security/advisories/GHSA-vmqv-hx8q-j7mg) | Concerns specific runtime integrity fuses and attacker write access to application resources. Those fuses are not configured here. The exact build-time ASAR inventory/hash check is a different mechanism and must not be described as runtime tamper protection. |

Other triaged advisories have missing or blocked prerequisites in the audited host. Absent features include custom protocols, webviews, Chrome extensions, offscreen rendering, and automatic updates. That is a source-based reachability assessment, not blanket immunity. The isolated plugin-loader foundation is not evidence of community plugin execution in the shipped host.

## Upgrade candidates, not a selection

The [official stable release list](https://releases.electronjs.org/) on the review date gives:

| Candidate | Runtime minimum macOS | Decision consideration |
| --- | --- | --- |
| 42.11.15 | 12 Monterey | Oldest currently supported major; shortest remaining support horizon of these candidates. |
| 43.8.0 | 12 Monterey | Retains Monterey while using the newer of the two compatible supported majors. |
| 44.8.0 | 13 Ventura | Latest stable major; excludes Monterey. |

The minimums follow Electron's [macOS 11 removal in 38](https://www.electronjs.org/docs/latest/breaking-changes#removed-macos-11-support) and [macOS 12 removal in 44](https://www.electronjs.org/docs/latest/breaking-changes#removed-macos-12-support). Recheck supported releases and advisories at implementation time. Do not retain the current `minimumSystemVersion: '10.15'` or Homebrew Catalina requirement when adopting these candidates; declaring an older minimum cannot make the runtime work there.

## Validation required for the eventual change

1. Confirm the macOS support decision, then pin one supported patch and update its frozen lockfile in an isolated change. Review the [intervening breaking changes](https://www.electronjs.org/docs/latest/breaking-changes). Keep unrelated dependency upgrades separate.
2. Validate binary installation before staging: Electron 42 [moves binary download out of postinstall](https://www.electronjs.org/docs/latest/breaking-changes#behavior-changed-electron-no-longer-downloads-itself-via-postinstall-script). Confirm the explicit installation/bootstrap, architecture and official distribution checksum in local and CI environments. Verify distribution/package/pin equality and regenerate Electron/Chromium license notices from that runtime.
3. Align packaging minimum macOS, generated bundle metadata, Homebrew requirements, release validation and documentation. Review renderer/preload API usage, including `webUtils.getPathForFile`, file dialogs, menu behavior, PDF/media handling and contextBridge behavior.
4. Run focused `desktop-main.test.cjs`, `window-broker.test.cjs`, `desktop-package.test.mjs` and affected release/Homebrew tests with test concurrency 1. Run the full suite, typecheck and production build serially on the local 8 GB machine.
5. Rebuild fresh unsigned arm64 and x64 apps from the candidate commit. Verify exact staged ASAR inventory and notices, runtime/bundle versions and architectures; create and mount both DMGs, verify their contained apps and `/Applications` links, then detach. Old-runtime artifacts cannot satisfy this gate.
6. Test native packaged behavior using disposable profiles/vaults on each supported architecture and the claimed minimum macOS: onboarding/vault selection, read/write/rename/recovery, split/editor/Canvas persistence, multiwindow ownership, external links/navigation denial, file drag/drop, menus/shortcuts, PDF/math/media, and unsaved-change quit guards. Preserve work and close owned test apps afterward; distinguish missing Intel/older-OS coverage explicitly.
7. For release readiness, validate Developer ID signing, hardened runtime, notarization and stapling of the app and DMG, mounted-app checks, and Gatekeeper on the candidate artifacts through the release workflow. Recheck advisories and publish matching source/notices only after the release gates pass. This document authorizes no signing, tags or publication.
