# Zorid Homebrew tap

This tap distributes Zorid's stable macOS releases for Apple Silicon and Intel Macs. After the first approved stable release has populated `Casks/zorid.rb`, install with:

```sh
brew install --cask zorid-app/tap/zorid
```

Update with `brew update` followed by `brew upgrade --cask zorid`. Uninstall with `brew uninstall --cask zorid`. The cask removes the app through Homebrew's standard app handling; it has no vault-deletion or user-data cleanup commands.

The update workflow checks public release metadata every six hours and can also run manually. It never builds Zorid or downloads the application DMGs. It accepts only a published stable version whose release manifest matches a completed successful macOS release workflow attempt and the current remote tag commit. Both architectures have pinned SHA-256 checksums. Drafts, prereleases, downgrades, and changed content for an already committed cask version are rejected.

The updater trusts Zorid's release maintainers. Run/tag checks detect inconsistent publication metadata; they are not cryptographic artifact attestations. Signing and notarization are enforced by the application release workflow before publication. A first live release and Homebrew installation must be verified separately.

The scripts in this tap are licensed under AGPL-3.0-only; see `LICENSE`. Zorid's source and corresponding source archives are available from [zorid-app/Zorid](https://github.com/zorid-app/Zorid).
