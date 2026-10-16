# Desktop and mobile targets

Zorid has original Electron entry points and a Capacitor configuration sharing the
TypeScript renderer. This is working application scaffolding, not verified full
Obsidian platform parity. The `ios/` and `android/` native projects have been
generated with Capacitor 8.5.3 and synchronized with Filesystem 8.1.5. No native
simulator/device compile, launch, or behavior has been validated.

## Install and run

From the repository root, install the dependencies and build the renderer:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm desktop
```

For development, run `npm run dev` in one terminal, then `npm run desktop:dev`
in another. Both use `http://127.0.0.1:5173`. The development URL is only selected
when `ZORID_DEV_URL` is set; the normal desktop command loads `dist/index.html`.

Electron runs with context isolation, a sandboxed preload, and Node integration
disabled in the renderer. The preload exposes only vault operations. Main-process
IPC accepts the application's own main frame and expected page origin.

The folder picker opens an ordinary local Markdown vault. Its path is remembered
in Electron's user-data directory when the user selects it. Files are saved with
a temporary file and rename; deletions move to `.trash/<unique-id>/<original-path>`
inside that vault. Symlink paths are rejected. External filesystem changes are
observed through native notifications with a metadata polling fallback.

The platform result carries a stable `id` separately from its display `label`:
desktop uses `desktop:<canonical-vault-path>`, mobile uses
`mobile:documents:Zorid`, and the browser preview uses `browser:default`.
Workspace and draft storage must use this ID so identically named vault folders
do not share state.

## Mobile projects

Both projects already exist. After installing dependencies and building, sync the
renderer and plugin metadata into them:

```sh
pnpm mobile:sync
```

Open the generated project with `npm run mobile:ios` or `npm run mobile:android`.
The iOS project uses Swift Package Manager. Native builds require the appropriate
Xcode or Android Studio SDK toolchain, including Java 21 for Capacitor 8 Android.
Run `npm run mobile:sync` after renderer changes or native plugin changes.
Do not run `cap add` on these existing directories. For a deliberately new native
checkout, the original generation commands were `pnpm exec cap add ios
--packagemanager SPM` and `pnpm exec cap add android`.

The mobile adapter uses `@capacitor/filesystem` with `Directory.Documents`,
keeping notes under `Zorid/`. It does not use browser local storage on native
platforms. Writes use a sibling temporary file and the plugin's rename operation;
deletions retain files under the vault's `.trash/`. Native rename/crash-recovery
semantics still require device testing. A two-second metadata poll detects
changes made outside the renderer while its subscription remains active.

The iOS Info.plist enables `UIFileSharingEnabled` and
`LSSupportsOpeningDocumentsInPlace` for Files integration. Its
`PrivacyInfo.xcprivacy` declares `NSPrivacyAccessedAPICategoryFileTimestamp` reason
`C617.1` and is linked into the Xcode Resources build phase. Android declares
read/write external-storage permissions through API 29 only; the installed
plugin handles the runtime permission request. On Android 11 and newer,
Documents access is restricted to files/folders created by this app. The generated
Android project targets SDK 36 and supports API 24 and newer. These settings follow
the installed plugin's README and Kotlin permission implementation; see also
[Capacitor Filesystem platform setup](https://capacitorjs.com/docs/apis/filesystem)
for native permissions and privacy requirements. Files integration and Android
document-provider behavior still need device validation.

### Native verification, 2026-10-16

- **Generated:** `cap add ios --packagemanager SPM` and `cap add android` completed.
- **Synchronized:** `cap sync` completed for both targets and registered
  `@capacitor/filesystem@8.1.5`. Copied application assets match the current
  production `dist/` files at the time of synchronization.
- **Static validation:** Apple `plutil` accepts Info.plist, PrivacyInfo.xcprivacy,
  and the Xcode project; `swiftc -frontend -parse` accepts AppDelegate,
  SceneDelegate, and the generated Package.swift. Android XML and generated
  configuration parse successfully. This is not compilation.
- **iOS compile not performed:** Xcode 26.2 is present, but this new SPM project
  references uncached remote `capacitor-swift-pm` 8.5.3 and
  `ion-ios-filesystem` 2.0.1 packages. No resolved package lock or native dependency
  checkout exists in this project. Resolving/building requires dependency access.
- **Android compile not performed:** `ANDROID_HOME` points to
  `/Users/ctk/Library/Android/sdk`, which does not exist. No Gradle distribution or
  dependency cache was found in the standard user locations. Installed Java
  versions top out at 17; the generated app/plugin require Java 21. The Gradle
  wrapper would need its 8.14.3 distribution before it can run, even with
  `--offline`. No toolchain download or global configuration change was made.

Generation, synchronization, parsing, compilation, device execution, and parity
are distinct validation stages. The first three are established here; the last
three remain open.

## Browser preview and verification limits

`npm run dev` also serves a browser preview. It keeps a separate preview vault in
localStorage, whose quota and lifecycle differ from native files. It is not a
desktop folder mount or native mobile storage implementation.

The automated platform tests cover desktop text persistence, folder inventory,
rename collision protection, recoverable deletion, traversal and symlink
rejection, external changes, and browser persistence/storage failure handling.
They do not establish native packaging, signing, mobile system integration,
adversarial concurrent filesystem mutation safety, plugin compatibility, or
pixel/interaction parity with Obsidian.
