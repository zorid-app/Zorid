# Android reference evidence: Obsidian 1.14.4

This report records static evidence from the user-supplied `$HOME/Downloads/Obsidian-1.14.4.apk`, inspected on 2026-10-16. It does not certify mobile parity. No application execution, device session, UI automation, or original proprietary implementation is included in the project.

## Identity and REA coverage

APK SHA-256: `b3e5bfa107bb01c4c121d810622ff2de03fd298f55fcf6268b9db50186f192a3`.

| Evidence | ID |
| --- | --- |
| REA artifact inspection | `ev_42dad07afbf7c91b8d8011cf7e05b13f32cc83da2024ecf78354ef4b96a9ffcc` |
| REA APK inventory | `ev_90bd2cb53a47511858df33ce3b4ad304c2af7a8d82c12035710bcabfeed4623d` |
| REA inspection summary | `ev_6b30e9e3f8a20085802ba40b8e77b187edcaddc275a780f8d61a88566c3cf7df` |

The portable export is `/private/tmp/zorid-reference-20261016/rea-apk-inventory.json`. It contains five Evidence records, including earlier desktop records; those earlier records are not Android semantic evidence. The inventory has 1,831 occurrences, 1,731 unique nodes, and zero recorded integrity contradictions. Its coverage is ZIP central-directory entries, excluding non-entry bytes such as the APK Signing Block. No package signature validation is implied. REA reports case-folded path collisions, so the complete archive was not blindly extracted to the case-insensitive host filesystem.

This pass reused that inventory. Focused file reads used Python's ZIP reader against exact entry names and independently checked SHA-256 against the REA nodes. Selected reference-only files were retained under `/private/tmp/zorid-reference-20261016/android-web`. No broad REA analysis was repeated. The interpretations below are ordinary JSON/HTML/JavaScript static inspection linked to inventoried bytes, not new REA runtime or semantic claims.

## Web artifact identity

| Entry | Bytes | SHA-256 |
| --- | ---: | --- |
| `assets/capacitor.config.json` | 516 | `538f87b25f2a21514c87a26581814aa5d90a050f725b76d0357960a402b6bba7` |
| `assets/capacitor.plugins.json` | 1,424 | `4e610603aa04e675ddc22f7e33ea9cd2a54d7505e485fa0f1a22149d505e7ab8` |
| `assets/native-bridge.js` | 49,718 | `6e57635767369af304b217171b84812350c117d2a94b91bfefb112d03c4169f1` |
| `assets/public/index.html` | 1,489 | `37417dcebc4c3d5ed419699a2e710f5e84807cf7a3e8dfc2a96b35156c24d7ed` |
| `assets/public/app.js` | 3,968,611 | `b0452336e0926983c240ce168bb03bcc308d32a54fc97cdd5db72ed7f333f997` |
| `assets/public/lib/pdfjs/version.json` | 65 | `0a8ac68bb7f1845ad8eb795e7147abf66f75c79b5e585c5985dbad4d42ad1eec` |
| `assets/public/lib/codemirror/codemirror.js` | 400,161 | `2150c2e30dcc28427b0cacb31c8073e2f8cdbeb1b03d61214a7200809bf21a43` |

The mobile `app.js` differs from desktop payload `app.js` (3,942,126 bytes, SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`). A digest difference establishes different bytes, not the nature or extent of behavioral differences. No complete cross-version or cross-platform semantic comparison has been performed.

## Capacitor configuration and versions

The packaged configuration declares application ID `md.obsidian`, name `Obsidian`, web directory `mobile`, background `#000000`, and appended user-agent token `obsidian/1.14.4`. Android's configured scheme is `http` and web-content debugging is enabled. Keyboard resize is configured as `none`. Splash-screen configuration requests an 8,000 ms launch duration, zero fade duration, and automatic hiding.

The same JSON also contains iOS settings (`contentInset: never`, debugging enabled, and scheme `Obsidian`). These settings inside an APK do not establish an iOS binary, native implementation, or runtime behavior. The config does not itself establish the final resolved WebView origin or Android window inset behavior.

`assets/native-bridge.js` identifies Capacitor and an MIT license in its header. No Capacitor version constant was found in this bridge or the selected config/plugin JSON. The bridge's bytes differ from the project's locally installed `@capacitor/android` 8.5.3 bridge (SHA-256 `44ae55c944c91d5ebeb1ca2374e831d7920d1af6464faef8f0001a96252109bc`). This excludes byte identity with that local file, but does not identify the reference version or establish that its public API is incompatible. **The reference Capacitor version remains unknown.** Choosing 8.5.3 in Zorid remains an implementation choice, not a verified reference version.

There are stronger direct version facts for two web dependencies:

- `lib/pdfjs/version.json` declares PDF.js version **5.3.34**, build **34**, commit **cc1e2a3e0**.
- The shipped legacy `lib/codemirror/codemirror.js` declares **CodeMirror 5.64.0** and carries an MIT license header. Its presence alongside bundled modular CodeMirror code does not prove which editor implementation is active in each mode, or establish the modular editor's exact versions.

The two Cordova-named compatibility assets, `assets/public/cordova.js` and `assets/public/cordova_plugins.js`, are empty. Their filenames are not evidence that a working Cordova plugin runtime is bundled.

## Packaged plugin registrations

`capacitor.plugins.json` lists the following 13 package/class registrations. It contains no package versions.

| Package | Native class |
| --- | --- |
| `@aparajita/capacitor-secure-storage` | `com.aparajita.capacitor.securestorage.SecureStorage` |
| `@capacitor-community/in-app-review` | `com.getcapacitor.community.inappreview.InAppReviewPlugin` |
| `@capacitor-community/keep-awake` | `com.getcapacitor.community.keepawake.KeepAwakePlugin` |
| `@capacitor/app` | `com.capacitorjs.plugins.app.AppPlugin` |
| `@capacitor/browser` | `com.capacitorjs.plugins.browser.BrowserPlugin` |
| `@capacitor/clipboard` | `com.capacitorjs.plugins.clipboard.ClipboardPlugin` |
| `@capacitor/device` | `com.capacitorjs.plugins.device.DevicePlugin` |
| `@capacitor/filesystem` | `com.capacitorjs.plugins.filesystem.FilesystemPlugin` |
| `@capacitor/haptics` | `com.capacitorjs.plugins.haptics.HapticsPlugin` |
| `@capacitor/keyboard` | `com.capacitorjs.plugins.keyboard.KeyboardPlugin` |
| `@capacitor/preferences` | `com.capacitorjs.plugins.preferences.PreferencesPlugin` |
| `@capacitor/splash-screen` | `com.capacitorjs.plugins.splashscreen.SplashScreenPlugin` |
| `@capacitor/status-bar` | `com.capacitorjs.plugins.statusbar.StatusBarPlugin` |

These names are declarative registrations, not proof of invocation, successful native loading, permissions, stock upstream implementations, or complete available APIs. In particular, the JavaScript calls a Keyboard `isMultiWindowMode` method and listens for `multiWindowModeChanged`; whether these arise from a fork or another native extension remains unresolved in this web-only pass. A matching npm package name alone is insufficient to certify equivalent functionality.

## Web entry point

The HTML viewport uses device width, initial/maximum scale 1, disabled user scaling, and `viewport-fit=cover`; a text-scale metadata entry requests scaling. The initial body class is dark theme. This is initial markup, not proof of the final theme selected after startup.

The document references app CSS and deferred scripts for legacy CodeMirror plus addons/Vim/mode metadata, Moment, Pixi, i18next, scrypt, Turndown, application enhancements, translations, and `app.js`. Its inline CSP metadata specifically declares a style source policy. The file alone does not establish the complete effective WebView security policy, execution order effects, feature availability, or third-party library versions beyond the explicit facts above.

## Mobile editing and embed behavior candidates

The following positions are zero-based Unicode character offsets in UTF-8-decoded mobile `app.js`, tied to its recorded digest. They are ordinary static readings and not REA AST locations or byte ranges. Platform conditionals can be present in both desktop and mobile bundles; their presence is not itself a demonstrated cross-platform behavior change.

| Subsystem | Static observation | Location / limit |
| --- | --- | --- |
| Native bridge activation | Checks Capacitor's platform and selects native-facing App, Browser, Clipboard, Filesystem, SplashScreen, StatusBar, Device, KeepAwake, Keyboard, and Haptics handles. | Around 827267; no native invocation was observed. |
| Mobile workspace | Creates mobile toolbar, navigation bar, tab switcher, and quick-action components when its mobile flag is set. | Around 3868738; initial flag calculation and runtime layout are not fully validated. |
| Editor pointer handling | Has separate mobile/Android/iOS and desktop event branches, including trusted/synthetic click distinctions. | Around 2518621; not equivalent to desktop Ctrl/Command-click behavior by assumption. |
| Titles and text input | Editable note and embed titles request Android `enter` versus `done` hints on other paths. | Around 2622380 and 3046863; OS keyboard appearance is unobserved. |
| Checkboxes | A checkbox-edit path performs haptic vibration and has Android-specific scroll-position handling. | Around 2979955; exact touch lifecycle and timing need device tests. |
| Keyboard and viewport | Handles will-show/did-show/hide events, physical-keyboard state, keyboard/screen heights, and scroll adjustment to keep selection visible. | Around 3943354–3944208; no measured geometry or IME behavior. |
| Mobile toolbar | Uses editor focus, keyboard visibility, and Android multiwindow state to select visibility; responds to keyboard-height changes. | Around 3082121–3083972; static animation durations do not establish observed motion. |
| Recursive embeds | Resolves links through metadata relative to source notes and gates extension-specific embed creators at depth at most five. | Around 2621195; matches the desktop candidate but is not full equivalence proof. |
| Reading embeds | Cached-read target note, resolve/slice a subpath, render and sanitize, invoke postprocessors using the embedded note's path, and await asynchronous postprocessor work. | Around 1968960–1970450; refresh/cancellation edge cases untested. |
| Editable embeds | Contains an open-note affordance, conditional editable title, property editor, preview/editor insertion, and Android input hint. | Around 2621750–2623200; selection, editing and save behavior have not been exercised. |

These observations mean mobile parity requires native keyboard/viewport, pointer and touch behavior in addition to loading the shared web UI in Capacitor. The report does not establish that every observed feature is reachable, enabled by default, or correctly represented by Zorid.

## Native declaration supplement

A separate original Python standard-library parser decoded selected AXML, resource-table, and DEX declarations into `/private/tmp/zorid-reference-20261016/android-native-declarations.json`, `android-manifest-decoded.xml`, `android-selected-resources.json`, `android-dex-declarations.json`, and `android-library-metadata.json`. The APK digest in that report matches this report. These are **ordinary custom-parser observations**, not REA/JADX decompilation. REA's Android code inspection was unavailable because the caller-supplied `jadx-headless-mcp` 0.7.1 JAR was missing. No code-body or runtime behavior is inferred solely from declarations.

The decoded manifest declares `md.obsidian`, versionName 1.14.4, versionCode 389, compile/target SDK 36, and minimum SDK 23. The user explicitly waived legacy minimum-SDK parity: Zorid may retain its modern baseline. SDK 23 is a reference fact, not an instruction to lower Zorid's baseline. Packaged Android build metadata separately declares Android Gradle Plugin 8.13.1.

MainActivity declares SEND handling for plain text and image/audio/video/PDF content, SEND_MULTIPLE for image/audio/video/PDF content, and a browsable VIEW intent whose resource-backed scheme resolves to `obsidian`. Five widget receivers and five quick-settings tile services declare open-app, new-note, daily-note, open-note and search entry points; a setup activity is also declared. This establishes registration intent, not successful processing, ordering, persisted configuration, or UI fidelity.

Storage permissions include READ_EXTERNAL_STORAGE, WRITE_EXTERNAL_STORAGE and MANAGE_EXTERNAL_STORAGE, with `requestLegacyExternalStorage` declared true. Application flags declare backup disabled, cleartext traffic enabled, RTL support and resizeability. These declarations do not establish effective grants on a particular Android release or mandate copying the permission configuration. An app-local Documents vault alone does not cover the reference's apparent broader storage integration.

The non-exported FileProvider grants URI permissions and declares file, external-file, external, cache, external-cache and root path entries. The selected XML paths use `.`. This is a configuration observation, not a claim about actual paths exposed at runtime or a recommendation for Zorid's provider scope.

The selected DEX declaration for `com.capacitorjs.plugins.keyboard.KeyboardPlugin` includes public `isMultiWindowMode` and `hasPhysicalKeyboard` methods. `isMultiWindowMode` has code offset 2478352 in `classes.dex` and the same observed runtime annotation type as other bridge methods; its class annotation names the Keyboard plugin. This corroborates the JavaScript call's native method presence. Exact Capacitor versions and those method bodies remain unknown. The bounded searches of DEX strings, class descriptors and packaged library-version markers did not identify a Capacitor version or literal BuildConfig class.

## Remaining verification

- Exact Capacitor core/Android and plugin versions, forks, and public/native contracts.
- Native Android bridge behavior, effective permissions, storage access framework, lifecycle, URI handling, sharing, background behavior, and build compatibility. The decoded declarations above do not verify these runtime behaviors.
- Active editor implementation/version and mobile editing behavior with a real keyboard, composition, touch selection, clipboard, undo/redo, and hardware keyboards.
- Android measurements for keyboard insets, toolbar placement, navigation, rotation, split-screen, edge-to-edge layout, and WebView versions.
- Markdown embed subpath extraction, recursion/fallback visuals, edit/save/refresh lifecycle, and plugin postprocessor compatibility on device.
- Cold-start, note-open, typing, search/indexing, memory, and large-vault performance. No runtime benchmarks were collected.
- iOS artifacts and device behavior. iOS configuration strings inside the APK are insufficient evidence.

The prior absence of an Android reference artifact is now resolved. Full mobile stack identification and feature/UI/UX parity remain incomplete.
