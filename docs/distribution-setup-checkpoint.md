# Distribution setup checkpoint

Verified on 2026-10-16 (America/Toronto):

- `zorid-app/Zorid` is public, with `main` as its default branch. Reachable
  history and subsequent publication changes were audited separately; see
  `credential-audit.md` and `publication-privacy-audit.md` for scope and limits.
- After the user's explicit authorization, six encrypted GitHub Actions secrets
  were uploaded and their names verified: `MACOS_CERTIFICATE_P12_BASE64`,
  `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGNING_IDENTITY`,
  `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER_ID`.
  Credential values are not stored in this repository or this report.
- The macOS workflow runs on new `v*` tag pushes. It builds both architectures,
  signs and notarizes the app and drag-to-Applications DMG, and publishes only
  after both architecture jobs succeed. Configuration is implemented; an actual
  signed release has not yet verified those operations.
- The public `zorid-app/homebrew-tap` repository is configured. Its initial
  metadata-only update workflow succeeded:
  <https://github.com/zorid-app/homebrew-tap/actions/runs/38985305116>.
  There is no installable cask until the first validated stable release.
- No release or version tag was created during setup. Branch pushes do not
  trigger the macOS build workflow. Windows, Linux, and mobile distribution
  remain separate discussion and implementation work.

Secret provisioning does not prove Apple authentication, notarization,
Gatekeeper acceptance, Intel runtime behavior, or a successful Homebrew install.
