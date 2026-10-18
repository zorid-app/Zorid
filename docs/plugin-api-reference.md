# Plugin API reference audit

Snapshot: 2026-10-16. This is a focused static compatibility inventory for the supplied Obsidian 1.14.4 desktop payload. It is not a runtime compatibility result, a complete API specification, or an audit of every exported function. No reference application or community plugin was executed, and no recovered implementation or assets are included in this document.

## Evidence boundary

The retained E3 analysis is `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`, exported in [rea-renderer-bundle.json](/private/tmp/zorid-reference-20261016/rea-renderer-bundle.json). The source module is `jag_node_621f724371e7aca9238d1f3a97fd54476f29e95749ed28f0e9b6a7f00f7078a2`. Its incomplete expanded semantic graph remains incomplete; this pass did not rerun that producer. See [reference evidence](reference-evidence.md) and [source audit](history/source-audit.md).

All source anchors below refer to [the retained app.js](/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js), SHA-256 **`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`**, 3,942,126 bytes. The hash was checked in this pass. Positions are **zero-based Unicode character offsets in Python's UTF-8-decoded text**, with end offsets exclusive, not byte offsets or source lines. These focused ordinary source readings are additional observations linked to E3's artifact identity, not new REA call-graph findings. Minified identifiers are build-local.

Coverage terms:

- **Traced:** the named local implementation and its relevant immediate branches were read. Downstream services and runtime effects may remain unknown.
- **Inventory:** an export or method assignment was identified; its full behavior was not traced.
- **Inference:** an implementation requirement derived from the observed relationships, pending runtime fixtures.

## Module boundary and shared editor identity

The `obsidian` export namespace is declared at **248450–251798**. The plugin resolver maps the literal module name `obsidian` to that same namespace at **2945601**. This connects the export inventory to plugin loading; it is stronger evidence than isolated export-name strings.

At **2955475–2956791**, `loadPlugin` reads the manifest directory's `main.js`, wraps it with CommonJS-style `require`, `module`, and `exports` parameters, assigns a `plugin:` source URL containing the encoded ID, and invokes the wrapper. It accepts a default export or the module export, constructs it with the host app and manifest, and requires the resulting instance to inherit the shared `Plugin` constructor. Export presence alone is insufficient. The wrapper is a host execution mechanism, not a sandbox established by this trace.

The resolver returns shared namespace objects for these exact specifiers (**2945601–2946198**):

| Namespace returned | Accepted current specifiers | Deprecated aliases returning the same namespace |
| --- | --- | --- |
| Obsidian API | `obsidian` | None in this map |
| CodeMirror state | `@codemirror/state`, `@codemirror/text` | `@codemirror/rangeset` |
| CodeMirror view | `@codemirror/view` | `@codemirror/gutter`, `@codemirror/panel`, `@codemirror/rectangular-selection`, `@codemirror/tooltip` |
| CodeMirror language | `@codemirror/language` | `@codemirror/fold`, `@codemirror/highlight`, `@codemirror/matchbrackets`, `@codemirror/stream-parser` |
| CodeMirror commands | `@codemirror/commands` | `@codemirror/comment`, `@codemirror/history` |
| CodeMirror autocomplete | `@codemirror/autocomplete` | `@codemirror/closebrackets` |
| Other CodeMirror modules | `@codemirror/collab`, `@codemirror/lint`, `@codemirror/search` | None in this map |
| Lezer modules | `@lezer/common`, `@lezer/lr`, `@lezer/highlight` | None in this map |

Deprecated imports log an error but still return the mapped namespace. Unknown names delegate to a captured `window.require` through the helper at **817530**. With the `emulate-mobile` body class, the plugin resolver instead reports unknown Node package requests and returns `null`. Real mobile behavior also depends on the presence of `window.require`; desktop emulation is not proof of Android behavior.

Compatibility modifications at **2944947–2945601** alias old precedence names, adapt older Lezer tree iteration callback arguments with a diagnostic, and expose a legacy `PluginField` shape whose factory functions do not produce an extension. These are concrete legacy behaviors, not evidence that every older CodeMirror plugin works.

**Implementation inference:** the plugin resolver and active editor must share actual module instances and constructors. A second copy of `@codemirror/state`, a second `Plugin` class, or wrapper classes with different identity can fail extension recognition or `instanceof` checks. The state extension recognizer itself mentions duplicate state packages near **286545**. Exact dependency versions are still unknown. Registration at **2944529–2944733** updates workspace editor options on both addition and removal; [editor reference](reference/editor-reference.md) covers the dynamic editor compartment.

## Discovery, gating, and lifecycle

| Area | Anchor | Traced local behavior and boundary |
| --- | --- | --- |
| File names | 1598669–1598720 | Manifest, entry point, and optional stylesheet names are `manifest.json`, `main.js`, and `styles.css`. |
| Manifest discovery | 2954119–2955475 | The manager lists folders under the vault configuration directory's `plugins` folder, parses each manifest, requires a truthy `id`, sets `dir`, and keys the manifest map by ID. Missing author and author equal to `obsidian` ignoring case become an empty author string. Errors are logged and discovery continues. This path does not establish comprehensive schema validation or a folder-name/ID match requirement. |
| Restricted mode | 2957009–2959155; 2962464–2963190 | Enabled IDs come from the `community-plugins` configuration array. Loading also depends on a per-app local-storage switch, `enable-plugin-` plus app ID, being the string `true`. Saved enabled IDs and currently loaded instances are distinct state. |
| Policy gating | 2959155–2959400; 1260774 | `enablePlugin` requires a plugin policy that is `true` or an array containing the ID. Desktop bootstrap obtains policy through IPC near 3934608. Policy source/administration is outside this trace. |
| Compatibility exclusions | 2959400–2959867; 2964033 | Enable checks an externally refreshable deprecated-version list and explicit plugin/version exclusions. It rejects `settings-search`; observed older-version exclusions cover `cmdr` below 0.5.4 and `obsidian-image-toolkit` below 1.4.3; `better-pdf-plugin` 1.4.0 is also rejected. This is release-specific behavior, not a general schema rule. |
| Desktop-only gate | 2959867 | A truthy `isDesktopOnly` prevents enable when `Platform.isDesktopApp` is false. The install modal also disables unsupported installation around 2851708–2852300. |
| Version selection | 1259216–1259690; 2852086; 2967138 | Install/update selection considers `minAppVersion`; if the current release is too old, it reads the repository's `versions.json` and selects a compatible version. This is separate from loading an already installed plugin. No general `minAppVersion` rejection appears in the bounded local `loadPlugin`/`enablePlugin` bodies. |
| Version utility | 1255153–1255540; 3884053–3884170 | `apiVersion` starts as 1.14.4 and can be set from desktop version IPC. `requireApiVersion` negates the internal less-than comparator. The comparator parses dot-separated components with `parseInt`; it is not established as a full semantic-version implementation. |
| Successful load | 2955475–2956791 | An existing instance is returned without reloading. A missing manifest yields `null`. The constructed instance is stored before its async `load` finishes. The manager then awaits `load`, awaits optional CSS loading, and invokes `onUserEnable` only for the user-enable path. |
| Load failures | 2959890–2960293 | The outer enable path clears the loading-ID marker, reports failure, and returns false. No rollback/unload of the already stored instance is visible in this catch. A rejected `onload` or stylesheet load therefore needs explicit runtime investigation; do not claim transactional cleanup. |
| Disable and unload | 2956791–2957009; 2960293–2960717 | Unload sets the instance's user-disabled flag, calls synchronous `unload`, then removes it from the manager map. Disable reports thrown errors. If unload throws before deletion, the subsequent map deletion is not reached in this body. |
| Persistent enable/disable | 2960717–2961247; 2962464–2963190 | Successful user enable adds the ID and requests configuration save. User disable removes the ID and requests save before unloading. Globally disabling iterates loaded plugins but retains saved enabled IDs for a later re-enable. |

The local minimum-version observation is deliberately bounded. An implementation should keep installation version selection, runtime API checks, policy, desktop-only status, and restricted mode separate. Adding a universal local version rejection would be a design choice until reference behavior is measured.

## Component and event semantics

`Component` is traced at **882880–884160**, and `Events` at **1411407–1412236**. The base `Component` sets its loaded flag before calling `onload`; it invokes child loads immediately after that hook call, collecting returned promises with the hook's promise. It does not wait for an asynchronous base-component hook before starting children. `Plugin.load` overrides this at **2946411–2946691**: it awaits its own `onload` before loading a snapshot of children, without collecting the children's returned promises in that override.

For a loaded component, unload sets the loaded flag false, pops and unloads children in reverse insertion order, pops registered cleanups in reverse insertion order, and finally calls `onunload`. There is no per-child or per-cleanup exception catch in this body. An exception can stop the remaining cleanup sequence. An unloaded component's unload is a no-op. Registered cleanup callbacks are stored even while unloaded; automatic immediate disposal of late registrations is not visible here. Children and cleanups are removed from the arrays during unload.

`addChild` appends and immediately loads a child when the parent is already loaded. `removeChild` removes the first matching child and unloads it. The bounded implementation does not enforce exclusive ownership, duplicate prevention, or cycle rejection. `registerEvent` calls the event reference's emitter `offref`; DOM registration removes the same callback using the supplied options; `registerScopeEvent` unregisters a scope binding; `registerInterval` returns the supplied interval ID and registers its clearing.

`Events.on` returns a reference carrying emitter, name, function, and context. Dispatch copies the listeners array and invokes that copy. Thus removing a listener during dispatch does not remove its already-copied invocation from that dispatch; newly added listeners wait for the next dispatch. Callback exceptions schedule a zero-delay timer that throws the exception, while iteration continues. This differs from queueing a microtask and from skipping callbacks whose references were detached mid-dispatch. `off` with a falsy callback removes the entire named listener list in the observed body; its declared public typing has not been checked here.

These observations describe reference behavior, including failure behavior. They do not recommend preserving every weakness without a deliberate compatibility decision.

## Plugin registration and persistence surface

The `Plugin` class spans **2946198–2952088** approximately. Its registrations delegate to real host managers and usually register corresponding cleanup callbacks. The following immediate delegation paths were read; their downstream UI/rendering implementations are not fully traced.

| Surface | Anchor | Compatibility requirement |
| --- | --- | --- |
| Construction and manifest | 2946198–2946411 | Stores the supplied app and manifest objects, initializes settings-change tracking, and debounces external configuration handling by 50 ms. Manifest identity is retained. |
| `addCommand`, `removeCommand` | 2947183–2947506 | Addition mutates the supplied command's ID and display name with plugin prefixes, registers it, returns the same object, and registers removal on unload. Removal prefixes the supplied local ID. No local duplicate-ID rejection appears here; command-manager behavior is a separate question. |
| `addRibbonIcon`, `addStatusBarItem` | 2946723–2947183 | Return host-created DOM elements and register their removal. Ribbon identity includes plugin ID and title; status items receive a plugin-derived class. |
| `addSettingTab` | 2947506–2947689 | Stores one `settingTab` reference, delegates registration, and removes the tab and clears that reference during cleanup. Tab hide behavior is downstream, not explicit in this method. |
| `registerView`, `registerExtensions` | 2947689–2947901; 2948092–2948274 | Register creators and extension-to-view associations. View cleanup unregisters the creator; it detaches leaves of that view type only when the plugin's user-disabled flag is set. |
| Markdown processors | 2948274–2948932 | `registerMarkdownPostProcessor` and `registerMarkdownCodeBlockProcessor` install renderer callbacks, return the registered processor, trigger `post-processor-change`, and unregister/trigger again on unload. Code-block registration has both generic and language-specific registration. |
| Editor integrations | 2949389–2949621; 2949791–2949979 | `registerEditorExtension` delegates to workspace registration with cleanup; `registerEditorSuggest` delegates to the suggestion manager with cleanup. `registerCodeMirror` has an empty body in this build. |
| Links and protocols | 2947901–2948092; 2949621–2949791 | `registerHoverLinkSource` and `registerObsidianProtocolHandler` register against workspace services and undo registration on unload. |
| Bases and expressions | 2948932–2949389 | `registerBasesView` returns false when the Bases core plugin is unavailable; otherwise registers/unregisters the view and returns true. `registerGlobalFunc` and `registerInstanceFunc` register functions and remove them by name on cleanup. See [Bases reference](reference/bases-reference.md). |
| CLI | 2949979–2950192 | `registerCliHandler` adds a plugin-labelled description and registers corresponding handler cleanup. Full CLI argument/error contracts remain untraced. |
| `loadData`, `saveData` | 2950192–2950787 | Delegate to vault plugin-data methods using `manifest.dir`, not just plugin ID. Saving records a timestamp and forwards it as `mtime`. Loading updates the tracked modified time when data is truthy and an external-settings callback exists. |
| CSS | 2950787–2951266 | Loads optional `styles.css`, inserts a style element before the host custom-CSS element, and registers element removal. Browser cascade behavior, popout propagation, and failure fixtures remain open. |
| External settings | 2951304–2952088; 2953882–2954119 | Manager raw-file events route exact plugin `data.json` changes to the instance. The instance compares mtime, calls optional `onExternalSettingsChange`, updates the settings tab, and records mtime. |
| `PluginSettingTab` | 2952088–2952691 | Takes its ID/name from the plugin manifest; default definitions are empty. Default getters/setters use `plugin.settings`; setting a value delegates to `saveData`. |

Plugin-data storage is traced at **1417753–1419035**: paths are normalized to `<manifest.dir>/data.json`. JSON read returns `null` for `ENOENT`; other failures log and result in `undefined`. Writes serialize with two-space indentation and catch write failures in the inspected helper. Error propagation must therefore be tested per API rather than assumed uniform.

## App, Vault, MetadataCache, and Workspace

The exported constructors are the same constructors used by the host. The initialization path at **3899730–3900580** creates `Vault`, `Workspace`, `FileManager`, `MetadataCache`, core plugins, community plugins, and settings managers on the app. The App constructor near **3892290** also creates command, hotkey, view, embed, keymap/scope, secret-storage, and CLI services. Passing a small registration-only object as `plugin.app` cannot provide this observed surface.

| Constructor | Source body / selected methods | Coverage and actionable surface |
| --- | --- | --- |
| `App` | Constructor 3892290; initialization 3899730–3900580 | **Partial trace.** Real object graph includes `vault`, `workspace`, `metadataCache`, `fileManager`, `commands`, `hotkeyManager`, `viewRegistry`, `embedRegistry`, `scope`, `keymap`, `setting`, `plugins`, `internalPlugins`, `secretStorage`, and `cli`. Lifecycle and all method contracts remain incomplete. |
| `Vault` | 1414538–1430973 | **Method inventory plus selected traces.** Exposes adapter/configuration, file/folder lookup, `create`, `createBinary`, `createFolder`, `read`, `cachedRead`, `readBinary`, `getResourcePath`, `delete`, `trash`, `rename`, `modify`, `modifyBinary`, `append`, `appendBinary`, `process`, `copy`, `getAllLoadedFiles`, `getAllFolders`, `getMarkdownFiles`, `getFiles`, and event methods. File objects must share `TFile`/`TFolder` constructor identity. |
| `MetadataCache` | 1748537–1767432 | **Method inventory plus selected traces.** Holds `resolvedLinks`, `unresolvedLinks`, file/metadata caches and asynchronous work queues. API candidates include `getFileCache`, `getCache`, `getFirstLinkpathDest`, `getLinkpathDest`, `fileToLinktext`, `getTags`, `getBacklinksForFile`, and events. Worker parse, invalidation, link ordering, and event timing need separate fixtures. |
| `Workspace` | 2882244–2944947 | **Method inventory plus selected traces.** Holds roots, side docks, active leaf/editor state and extension registrations. API candidates include `getLeaf`, split/duplicate/popout operations, `openLinkText`, `setActiveLeaf`, `getActiveViewOfType`, `getActiveFile`, leaf iteration/lookup, `getLeavesOfType`, `detachLeavesOfType`, `revealLeaf`, `onLayoutReady`, `requestSaveLayout`, and events. Complete layout and view semantics remain open. |

Selected details that materially constrain a reconstruction:

- **Vault reads (1423205–1424086):** text read strips a leading BOM and updates the file cache; cached read reuses a cached entry when present. Binary read can cache decoded Markdown within the configured size limit. Resource paths delegate to the adapter. These are separate operations, not interchangeable file-system wrappers.
- **Vault processing (1426694–1427070):** delegates transformation to adapter `process`, tracks the file's saving state with `finally`, invalidates the cache through an immediate callback, then caches and returns the result. This does not by itself prove the adapter's concurrency guarantees.
- **File lookup (1419370–1420178):** `getFileByPath` and `getFolderByPath` filter by constructor type. Abstract lookup also has platform-dependent external-file fallback. Missing results use `null` in these paths.
- **Metadata reads (1752229–1752645):** `getFileCache` delegates by path. Cache lookup returns `null` for an unknown file; recognized non-Markdown files can return an empty object. Markdown metadata is found through the file's content hash. External files follow a separate branch.
- **Link resolution (1750678–1751979):** an empty link can resolve to the source file; relative, root-relative, extensionless Markdown and external-path cases have separate handling. General lookup lowercases names, tests direct matches, then orders suffix candidates with local-folder candidates ahead of others. The candidate comparator and all ambiguity behavior remain partially traced.
- **View identity (2932022–2932149):** active-view lookup uses `instanceof` the caller-supplied constructor. A string view-type lookup is a different API.
- **Layout readiness (2907779–2909362; 2912505–2912672):** queued callbacks capture the loading plugin ID. Loading the layout triggers `layout-ready`, clears the callback queue sentinel, and starts deferred callback iteration, yielding before each callback and catching synchronous callback errors. Later `onLayoutReady` calls invoke immediately. Callback-returned promises are not awaited in the observed loop. Readiness is not equivalent to plugin `onload` completion.
- **Initialization ordering (3906031 onward):** community-plugin initialization precedes the shown vault-load phase. Plugins cannot assume the entire file/index/layout state is ready simply because their app object exists.

## Complete named export inventory

The following 159 names are the complete named entries in the inspected namespace declaration at **248450–251798**. This is a runtime namespace inventory, not a claim that every name is a documented, stable public API. It does not include prototype extensions installed on browser/native objects or reconstruct TypeScript-only interfaces. Except for the focused rows above, bodies are **inventory-only**.

`AbstractInputSuggest`, `AbstractTextComponent`, `App`, `BaseComponent`, `BasesEntry`, `BasesEntryGroup`, `BasesQueryResult`, `BasesView`, `BasesViewConfig`, `BooleanValue`, `ButtonComponent`, `CapacitorAdapter`, `ColorComponent`, `Component`, `ConfirmationButton`, `ConfirmationModal`, `DateValue`, `DropdownComponent`, `DurationValue`, `EditableFileView`.

`Editor`, `EditorSuggest`, `Events`, `ExtraButtonComponent`, `FileManager`, `FileSystemAdapter`, `FileValue`, `FileView`, `FuzzySuggestModal`, `HTMLValue`, `HoverPopover`, `IconValue`, `ImageValue`, `ItemView`, `Keymap`, `LinkValue`, `ListValue`, `MarkdownPreviewRenderer`, `MarkdownPreviewSection`, `MarkdownPreviewView`.

`MarkdownRenderChild`, `MarkdownRenderer`, `MarkdownView`, `Menu`, `MenuItem`, `MenuSeparator`, `MetadataCache`, `Modal`, `MomentFormatComponent`, `NotNullValue`, `Notice`, `NullValue`, `NumberValue`, `ObjectValue`, `Platform`, `Plugin`, `PluginSettingTab`, `PopoverState`, `PopoverSuggest`, `PrimitiveValue`.

`ProgressBarComponent`, `QueryController`, `RegExpValue`, `RelativeDateValue`, `RenderContext`, `Scope`, `SearchComponent`, `SecretComponent`, `SecretStorage`, `Setting`, `SettingGroup`, `SettingPage`, `SettingTab`, `SliderComponent`, `StringValue`, `SuggestModal`, `TAbstractFile`, `TExternalFile`, `TFile`, `TFolder`.

`TagValue`, `TextAreaComponent`, `TextComponent`, `TextFileView`, `ToggleComponent`, `UrlValue`, `Value`, `ValueComponent`, `Vault`, `View`, `ViewRegistry`, `Workspace`, `WorkspaceContainer`, `WorkspaceFloating`, `WorkspaceItem`, `WorkspaceLeaf`, `WorkspaceParent`, `WorkspaceRibbon`, `WorkspaceRoot`, `WorkspaceSidedock`.

`WorkspaceSplit`, `WorkspaceTabs`, `WorkspaceWindow`, `addIcon`, `apiVersion`, `arrayBufferToBase64`, `arrayBufferToHex`, `base64ToArrayBuffer`, `debounce`, `displayTooltip`, `editorEditorField`, `editorInfoField`, `editorLivePreviewField`, `editorViewField`, `finishRenderMath`, `fuzzySearch`, `getAllTags`, `getBlobArrayBuffer`, `getFrontMatterInfo`, `getIcon`.

`getIconIds`, `getLanguage`, `getLinkpath`, `hexToArrayBuffer`, `htmlToMarkdown`, `iterateCacheRefs`, `iterateRefs`, `livePreviewState`, `loadMathJax`, `loadMermaid`, `loadPdfJs`, `loadPrism`, `moment`, `normalizePath`, `parseFrontMatterAliases`, `parseFrontMatterEntry`, `parseFrontMatterStringArray`, `parseFrontMatterTags`, `parseLinktext`, `parsePropertyId`.

`parseYaml`, `prepareFuzzySearch`, `prepareQuery`, `prepareSimpleSearch`, `removeIcon`, `renderMatches`, `renderMath`, `renderResults`, `request`, `requestUrl`, `requireApiVersion`, `resolveSubpath`, `sanitizeHTMLToDom`, `setIcon`, `setTooltip`, `sortSearchResults`, `stringifyYaml`, `stripHeading`, `stripHeadingForLink`.

## Current Zorid mapping and work remaining

The comparison below is limited to `src/plugins/component.ts`, `src/plugins/events.ts`, and `src/plugins/plugin.ts`. A follow-up implementation pass aligned the audited primitive behaviors below. It does not assert completeness of unrelated files or runtime plugin compatibility.

| Existing primitive | Observed gap against this reference | Next discriminating fixture |
| --- | --- | --- |
| `Component` | Implemented the observed base load promise behavior, child snapshots, reverse child/cleanup removal before `onunload`, exception propagation without rollback, late registrations, duplicate/shared ownership, and `registerScopeEvent`. Removed the former `whenLoaded` host extension; callers consume `load()` directly. | Static-contract tests cover ordering, synchronous throws, rejected hooks, duplicate children, removal/reload, reentrancy, and late registration. Reference runtime corroboration remains open. |
| `Events` | Implemented emitter/name/function/context references, copied dispatch that invokes removed listeners, direct `tryTrigger`, and default timer-based error reporting. The optional injected reporter remains a Zorid host extension. | Static-contract tests cover mutation during dispatch, reentrant dispatch, context, individual/removal-all subscriptions, and timer versus microtask ordering. |
| `Plugin` | Implemented manifest identity, command input mutation/identity, direct host command removal, and the separate async load override that awaits the plugin hook but not child promises. Removed wrapper-local ID/duplicate validation; collision policy belongs to the host. Most registration methods and data/CSS/external-settings behavior remain incomplete. | Static-contract tests cover object identity, repeated command registration/removal, cleanup reading a changed command ID, hook failure, and child-load timing. User disable/global disable and external settings remain open. |
| `PluginHost` | A narrow registration/data interface does not supply the observed App graph or shared constructors. | A tiny original CommonJS fixture imports `obsidian`, uses app vault/cache/workspace services, and asserts identities and returned shapes. |
| Module loading | The three inspected files provide no CommonJS resolver or shared CodeMirror namespace map. | Load default and direct exports; reject non-Plugin exports; assert alias identity; register an actual editor extension and unload it from existing editors. |

The follow-up reread the original bodies at 882880–884160, 1411407–1412236, and 2946198–2947689 before changing reentrant/error behavior. Twenty focused tests in `tests/plugin-lifecycle.test.ts`, the full 312-test suite, and TypeScript checking passed in the isolated implementation worktree. These tests exercise an original implementation against static expectations; they are not measurements of a running reference. The narrow `PluginHost` now requires `removeCommand`, and its remaining data/settings API still differs from the real App graph.

A practical implementation sequence is: establish shared constructors and module resolution; align component/events/plugin ownership behavior; expose the real App service graph; implement registry and persistence delegation; then exercise editor, Markdown, workspace, and UI integrations. Every fixture should name whether its expectation comes from this static trace or a measured reference run.

Remaining questions include exact dependency versions, complete method signatures and overloads, EventRef stability as a supported public contract, DOM/prototype helper APIs, all settings widgets, adapter filesystem/error guarantees, command collision handling, async failure rollback, layout/index event ordering, real mobile imports, native modules, popout CSS propagation, and representative third-party plugin compatibility. No complete plugin parity claim is justified by this inventory.
