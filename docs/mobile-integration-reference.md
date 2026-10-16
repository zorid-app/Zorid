# Mobile integration reference: Obsidian 1.14.4

This focused static contract audit supplements [Android reference](android-reference.md) and [source audit](source-audit.md). It covers selected bridge, vault-storage, incoming share/URL, keyboard and lifecycle paths in the user-supplied APK. It does not establish device behavior, full mobile parity, native method semantics, or iOS behavior. No APK execution, SDK installation, new broad extraction, or proprietary implementation copying occurred. The user permits a modern Android baseline; the reference's minimum SDK 23 does not require a downgrade.

## Evidence and location convention

The existing REA APK inventory (`ev_90bd2cb53a47511858df33ce3b4ad304c2af7a8d82c12035710bcabfeed4623d`) and artifact inspection (`ev_42dad07afbf7c91b8d8011cf7e05b13f32cc83da2024ecf78354ef4b96a9ffcc`) bind the archive identity. Export: `/private/tmp/zorid-reference-20261016/rea-apk-inventory.json`. This pass reuses its selected web files and the prior independent declaration-parser output. It is ordinary static inspection, not a new REA semantic analysis or JADX decompilation. The required JADX provider was previously unavailable; native bodies remain unread.

| Source | SHA-256 |
| --- | --- |
| `Obsidian-1.14.4.apk` | `b3e5bfa107bb01c4c121d810622ff2de03fd298f55fcf6268b9db50186f192a3` |
| APK `assets/public/app.js` | `b0452336e0926983c240ce168bb03bcc308d32a54fc97cdd5db72ed7f333f997` |
| APK `assets/native-bridge.js` | `6e57635767369af304b217171b84812350c117d2a94b91bfefb112d03c4169f1` |
| APK `classes.dex` | `c82c18302ab7f3e810df433a974894c68ef1049c7dad38abe4dd3ae407339855` |
| APK `AndroidManifest.xml` | `7e72fe1ef8c1980a562b2a49b7236d06707a8d7840bcf448f92e2505beeaf2a6` |
| Retained `android-dex-declarations.json` | `d614f152bec0fcbae3575317bf2a21b9e678ce1739f8cdd03651b181413d7d48` |
| Retained `android-native-declarations.json` | `e01c9bb61b9bcb0443c16c70bb4cc536cf4141ebf02a87fecfd2c23f2ee489a0` |
| Retained `android-selected-resources.json` | `5b61f3ee926c41dc37d6aa529459997ea8217ac63af514bb1d79108e0406a7aa` |

Retained JSON paths are under `/private/tmp/zorid-reference-20261016`; web files are under its `android-web` directory. Below, **JS** locations are zero-based Unicode character offsets after UTF-8 decoding `app.js`; **bridge** locations use the same convention for `native-bridge.js`. These are bounded reading windows, not AST source ranges or byte offsets. **DEX** offsets are decimal byte offsets of declared code items in `classes.dex`; they identify a body for future inspection without describing it. Registration and matching declarations corroborate an API name's presence, not successful invocation or its result/error contract.

## Bridge surface and native declaration cross-check

At JS 827267–828700 the application selects native plugin handles only when Capacitor exists and its platform is not `web`; separate Android/iOS flags select later branches. The packaged plugin list's familiar npm names do not certify stock implementations or exact versions.

At bridge 40100–42200, Android transport serializes calls to `androidBridge.postMessage`. At 42900–44900 the call envelope contains `callbackId`, `pluginId`, `methodName` and `options`, with stored callback/promise continuations. At 48100–49100 native promises wrap this transport. These observations establish the JavaScript dispatch shape only. Java-side argument validation, threading, cancellation, listener retention, origin enforcement and error delivery remain unresolved.

| Surface | Web-side contract observed | Native declaration anchor and limit |
| --- | --- | --- |
| App extensions | `requestUrl` receives URL, method, content type, headers, body and binary flag (JS 1260675); tab preview calls `takeScreenshot` with path and rectangle and consumes `screenshotSaved` URI (3076265–3079300); quick actions carry IDs/icons/titles and consume `quickActionSelected` IDs (3084971–3085585). | `AppPlugin` class definition 1160984; `requestUrl` code 2456428, `takeScreenshot` 2456924, `setQuickActions` 2456472. Same observed bridge annotation type as conventional App methods. No native transport, screenshot or shortcut body inspected. |
| App state and incoming intents | Listeners for `appStateChange`, `pause`, `resume`, `backButton`, `appUrlOpen`, `appShareIntent`. Startup reads `getInfo`, `getManagedPolicy`, `getLaunchUrl`; font enumeration calls `getFonts`. | `handleOnNewIntent` 2455220, `handleOnPause` 2455724, `handleOnResume` 2455768, `getManagedPolicy` 2455036, `getFonts` 2454520. Lifecycle method declarations do not prove event payloads, ordering or retention. |
| Filesystem extensions | `choose`, `checkPerms`, `requestPerms`, `startWatch`, `stopWatch`, `watchAndStatAll`, `setTimes`, `open` accompany read/write/stat/list/copy/rename operations. | `FilesystemPlugin` class definition 1161880; selected code offsets below. A replacement using only generic read/write methods would leave observed contracts uncovered. |
| Keyboard extensions | `hasPhysicalKeyboard()` expects `hasPhysicalKeyboard` result (3862301). `isMultiWindowMode()` expects `isMultiWindowMode`; a window `multiWindowModeChanged` event updates that state (3082100–3082800). | `KeyboardPlugin` class definition 1162840; `hasPhysicalKeyboard` 2478264, `isMultiWindowMode` 2478352, `onKeyboardEvent` 2478656, configuration handler 2478100. Exact native computation/event generation unverified. |

The shared web wrapper also contains `verifyIcloud` and `trash` calls. Neither appears in the retained selected Android `FilesystemPlugin` method list. Their presence in cross-platform JavaScript must not be promoted into an Android capability claim; registration through another route, platform reachability and behavior remain open. Similarly, an App `setBackgroundColor` call exists in the web bundle but is absent from the selected App declaration list.

## Vault paths, filesystem and providers

| Question | Bounded observation | Source / remaining gap |
| --- | --- | --- |
| Storage roots | Startup creates the ordinary filesystem handle using `Documents` on iOS and `External` otherwise, then creates a separate Android handle with `directory: null`. Its `init` requests `getUri` for an empty path. | JS 2745200–2745600, 3944920–3945700. The native interpretation of `External`/null is not established by these names. |
| Selected vault location | Android locations containing `/` use the null-directory handle and the location unchanged; other locations use the ordinary handle. Vault enumeration stats remembered external paths and lists ordinary-root child directories, omitting hidden names in that listing. | JS 3935500–3936800, 3937350–3937850. Persisted grant handling, removable media, provider compatibility and path normalization remain unresolved. |
| Folder picker | `choose()` is consumed as an optional object with `path` and `isRoot`. The chooser rejects a reported root, stats the selected path and requires type `directory`; cancellation messages containing `canceled` are suppressed in the observed external-vault flow. | JS 3949700–3950600. DEX `choose` 2465856 and `onOpenDocumentTree` 2467108 corroborate method/callback declarations only. They do not prove use of a particular Android intent or durable SAF grants. |
| Permission gate | Android readiness uses resolved/rejected `checkPerms()` to set a boolean; selected UI paths invoke `requestPerms()` and then recheck. The separate `requestPermissions()` startup branch is reached outside Android's branch. | JS 3935100–3935500, 3931224, 3939747, 3942880–3945200. DEX `checkPerms` 2465808, `requestPerms` 2469076, `requestPerms2` 2469124, `requestPerms3` 2469300. No effective OS grants inferred. |
| Text and metadata | Text IO sends `encoding: UTF8`; list consumes `files`; stat consumes type, size, ctime and mtime. Directory create/remove request recursive behavior. `setTimes` passes ctime and mtime. A wrapper maps errors whose message contains `does not exist` to `ENOENT`; `exists` returns false after any caught stat failure. | JS 2744900–2751100. Native units, rounding, error taxonomy, atomicity and durability remain open; higher adapter rounds ctime/mtime. DEX `setTimes` 2470004. |
| Binary IO | Below 5,242,880 bytes, read uses bridge base64 data; larger reads fetch a converted file URL. Large writes append base64 chunks of at most 1,048,576 bytes. A failed large replacement write attempts deletion, whereas append failure does not take that deletion branch. | JS 2746200–2748100. No throughput or crash safety demonstrated; append can have partial effects. |
| Watches | Adapter registers a `change` listener, reads its `path`, removes a base-path prefix and queues reconciliation. `stopWatch` errors are caught and the handler cleared. Wrapper exposes `watchAndStatAll` and `startWatch`. | JS 2745671, 2749102, 2763500–2764300. DEX `startWatch` 2470416, `stopWatch` 2470696, `watchAndStatAll` 2470740. Event coalescing, recursive completeness, rename handling and background watch survival remain open. |
| Resource URLs and export | URI builder joins individually encoded path segments, then converts `file://` URLs through Capacitor. Text export creates a cache export directory, writes the sanitized filename and calls filesystem `open`. | JS 2751000–2751400, 2758900–2760100. DEX `open` 2467460. No chooser UI, MIME, grant duration or external-app success verified. |

The decoded manifest declares a non-exported FileProvider with URI grants. Resource `0x7f110001` resolves to `res/8K.xml` at resource-table offset 886996; the prior selected XML parse records file, external-file, external, cache, external-cache and root path entries using `.`. This is broad configuration evidence, not proof of paths actually shared or a recommendation to reproduce its scope. Its bytes are SHA-256 `47e368339bba23e8ce59d90d8ec3fd5344264200467ea4a98a5d6966094099a0`.

The Filesystem class declares native `nativeListFoldersRecursive`, `nativeStat`, `nativeStatRecursive` and `nativeUtimes` methods with no DEX code item. The APK contains `libfs.so` for four ABIs, inventoried in [source audit](source-audit.md). The relationship, JNI binding, implementation and error handling remain unverified; neither Java declarations nor library filenames cover that native code.

## Incoming shares, URLs and navigation

The manifest registers SEND for plain text and image/audio/video/PDF, SEND_MULTIPLE for image/audio/video/PDF, and browsable VIEW with the resource-resolved `obsidian` scheme. This declares routing eligibility, not successful OS dispatch or decoding. The scheme is resource `0x7f0e0029`, offset 604664 in the recorded resource table.

At JS 3085650–3091000, `appShareIntent` branches on `type: text` with `text`, or `type: files` with a `files` array. Text presents insertion choices through the workspace `receive-text-menu` event. Files first present Import/Cancel. Import fetches each converted `uri`, reads an ArrayBuffer and uses supplied `name` or the URI basename. Markdown uses the ordinary available-path allocator; other files use attachment destination allocation relative to the active file. Imports run sequentially. The observed catch reports the failed filename and exits the loop; this branch does not roll back files already created. The success menu emits `receive-files-menu` with created files, allowing link/embed insertion. Native URI copying, temporary-file cleanup, content permissions, names/MIME provenance and queued intent delivery are still unknown.

At JS 2827450–2829100, `appUrlOpen` passes the URL to the protocol parser. A different named vault stores the URI in session storage and reloads; the current vault dispatches the parsed action. The observed open handler resolves a file/subpath and opens it, while unknown actions show an error. Startup at 3946300–3947450 checks the stored URI and `getLaunchUrl`, includes a short event-listener coordination branch, and resolves the requested vault. This does not establish all URI actions, exact cold/warm-start delivery, duplicate suppression or error ordering.

At JS 2862200–2862950, the native back-button listener first uses the active navigation stack, then collapses eligible sidebars, then goes back through leaf history. With none available, a second press within five seconds requests `minimizeApp`; the first shows a notice. This is the inspected web decision order, not a predictive-back or OS task-stack test.

## Keyboard, safe area and lifecycle

| Area | Observed web behavior | Boundary |
| --- | --- | --- |
| Keyboard state and scrolling | Will-show consumes `hasPhysicalKeyboard`, `screenHeight`, `keyboardHeight`; updates soft/hardware state and, on the inspected transition, scrolls the active selection above keyboard plus toolbar/autoscroll padding. Did-show and hide events update soft-keyboard state. | JS 3942880–3944500. Native event coordinate space, ordering, IME composition and floating keyboard behavior untested. |
| Editing toolbar | Visibility requires a focused active editor; on Android it additionally requires keyboard-visible or multiwindow state. Toolbar commands come from vault configuration; mousedown prevents default to preserve focus. It reads `--keyboard-height` and animates position changes. | JS 3082100–3084000. No measured toolbar geometry, timing, accessibility or rotation behavior. |
| Safe area | Popup placement consumes top/bottom/left/right safe-area CSS values; mobile settings swipe edge threshold consumes inline-start safe area. | JS 870900–871600, 3841650–3842150. These are consumers, not evidence of the native producer or effective insets. Packaged keyboard resize `none` and viewport-fit `cover` are recorded separately in Android reference. |
| State change save | An inactive `appStateChange` invokes a helper that calls save for dirty file views after layout readiness. Unlike the quit path, this listener does not hand returned save promises to an explicit completion barrier. | JS 2850300–2851050. This establishes a save request path, not completion before suspension or process death. |
| Resume policy | Pause records time; resume after more than 900,000 ms runs configured opening behavior and clears the timestamp. A separate resume listener can trigger an enabled automatic update check. | JS 3875050–3875580, 2919127. Background indexing/sync/work scheduling and process-restoration guarantees remain open. |
| Focus and awake | State changes dispatch focus/blur; an awake-token list calls KeepAwake when the first token is acquired and allows sleep after the last release. | JS 3942880–3943350, 827700–828100. No native wake-lock scope or background-execution guarantee follows. |

## Permission and camera boundary

The parsed manifest includes external-storage read/write/manage, coarse/fine location, record-audio, modify-audio-settings, vibration, wake-lock, network-state, boot-completed and foreground-service permissions. A declaration neither proves a grant nor identifies all callers. It does not mandate duplicating these permissions in Zorid.

The complete retained permission list has no `android.permission.CAMERA`, and the 13 packaged plugin registrations contain no Camera plugin. Those are bounded absence observations. They do **not** prove camera capture is impossible: WebView file inputs, external activities, platform delegates or another bridge route have not been audited. Generic `camera`/`capture` strings in the application bundle include icon/editor uses and are not reliable capability evidence. Camera/photo picker behavior remains unresolved, as do microphone/location request flow, denial/retry UX and permission revocation.

## Closure ledger

| Question | Status | Required evidence to close |
| --- | --- | --- |
| Selected JS bridge argument/result/event expectations | Partial | Complete call-site inventory, native bodies and error/event ordering. |
| Arbitrary-vault selection versus ordinary app storage | Partial | Native path/provider resolution, picker result/grant persistence, removable storage and revoked-access behavior. |
| Share and open-in | Partial | Native incoming intent decoding, URI lifecycle, outbound MIME/grants and real receiving/sending apps. |
| Keyboard/toolbar/safe-area | Partial | Native event/inset production and measured touch, hardware keyboard, split-screen, rotation and IME cases. |
| Save/lifecycle/background | Partial | Save completion under suspension, process death/restoration, native scheduling and watch/sync survival. |
| Camera and OS permission flows | Unresolved | Relevant native/WebView/file-input paths and controlled device observations. |

No subsystem is complete. This report specifies evidence-backed contracts for independent implementation and future verification; it does not assert that Zorid currently implements them or that passing a generic Capacitor smoke test would establish equivalence.
