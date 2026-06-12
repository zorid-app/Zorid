# Desktop v0.1 Release Setup

Set up all-platform desktop release builds for Zorid, then trigger a tagged `v0.1` build.

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
