# Desktop Release And Auto-Update Infrastructure

Maintain Zorid desktop release infrastructure, including the completed tagged `v0.1` all-platform release setup and the next accepted story: GitHub Releases based desktop auto-update.

## Constraints

- Keep desktop app ID as `app.zorid.desktop` because the owned domain is `zorid.app`.
- Update package versions to `0.1.0` before tagging `v0.1`.
- Use a real pushed Git tag `v0.1`.
- Create a draft GitHub Release for tagged builds.
- Release desktop artifacts only.
- macOS target is universal `dmg` and `zip`, with split-architecture fallback only if CI requires it.
- Windows target is unsigned `msi` and `zip`.
- Linux target is `AppImage`, `deb`, and `tar.gz`.
- Run `pnpm quality:fast` before packaging in CI.
- Set or update Apple signing and notarization GitHub secrets from local certificate files with `gh secret set`.

## Accepted Story: GitHub Releases Auto-Update

Add desktop auto-update support using GitHub Releases for `zorid-app/Zorid`, `electron-builder`, and `electron-updater`.

### Auto-Update Constraints

- Stable GitHub Releases only; prereleases are ignored.
- Automatically check for updates and automatically download available updates.
- Never restart or install without explicit user confirmation.
- Auto-check is enabled by default, can be disabled, and manual checks remain available.
- Automatic checks run shortly after startup and at most once every 24 hours while the app is open.
- The 24-hour throttle must persist across app restarts using updater metadata under `app.getPath('userData')`.
- Background failures are passive; manual failures show inline Settings errors with retry.
- Supported in-app updater packages are macOS, Windows NSIS, and Linux AppImage.
- Linux `deb`, Linux `tar.gz`, and any retained Windows MSI are manual/package-managed artifacts, not in-app updater paths.
- Production macOS updates require signed and notarized artifacts.
- Public Windows auto-update requires signed NSIS artifacts; unsigned NSIS is internal testing only.
- Keep updater logic in the Electron main process and expose only narrow serializable preload bridge APIs.
- Do not expose raw Electron, Node, or `electron-updater` to renderer or plugins.
- Keep the public plugin `AppAPI` metadata-only.
- Modify the existing desktop release workflow rather than adding a parallel release workflow.
- Keep draft GitHub Releases as the safety gate; updater sees a release only after a maintainer verifies assets and publishes a non-prerelease stable release.
- Release assets must include generated updater metadata such as `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, and `*.blockmap` as generated.
- Coordinate updater install/restart with runtime shutdown so runtimes dispose once and `quitAndInstall` is not blocked by `before-quit` handling.
