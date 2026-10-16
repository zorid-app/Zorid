# Obsidian reference evidence

Reference inspection date: 2026-10-16. This report contains factual observations and implementation guidance, not recovered proprietary implementation. Recovered artifacts and complete REA output are outside this repository under `/private/tmp/zorid-reference-20261016` and are not distributable project source.

## Target identity

The requested reference is the installed **Obsidian application payload 1.14.4**. The installed desktop launcher is older than that payload; these are separate version facts.

| Artifact | Observation | Evidence |
| --- | --- | --- |
| `~/Library/Application Support/obsidian/obsidian-1.14.4.asar` | SHA-256 `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f` | REA E1 and E2 |
| Payload `package.json` | Name `obsidian-dev`, version `1.14.4`, declared main `index.js` | REA E2 package node `jag_node_3350db175d3c61cc5f94216fe218f84c206ccfe13c7814224643c2788f599ece` |
| `/Applications/Obsidian.app/Contents/Resources/app.asar` | SHA-256 `0a31162efe161023def5390fb00ef75e21cd9dc1cc71bda328508e2e8f2f8dc1` | Ordinary filesystem SHA-256 inspection, not REA |
| Launcher `package.json` | Name `obsidian`, version `1.7.4`, main `main.js` | Ordinary JSON inspection of recovered launcher manifest |
| Installed app `Info.plist` | Short version `1.7.4`; bundle version `0.14.8` | Ordinary plist inspection |
| Installed Electron framework `Info.plist` | Bundle identifier `com.github.Electron.framework`; bundle version `31.6.0` | Ordinary plist inspection at `Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist` |

The framework observation identifies the installed reference host. It does not establish that every installation of Obsidian 1.14.4 uses Electron 31.6.0. The running application's loaded payload and runtime versions have not been measured.

## REA execution and retained evidence

The installed `reverse-engineer-anything` skill, version 42, was used. Its supported public CLI fallback is installed at `$HOME/.npm/_npx/9b9809298fe40d2c/node_modules/.bin/rea`, version 6.5.0. E1/E2 used that CLI fallback. A subsequently connected REA MCP server produced E3; its complete two-record bundle was exported outside the repository.

| ID | REA Evidence ID | File outside repository | Coverage |
| --- | --- | --- | --- |
| E1 | `ev_32ee7d1a52a3881d94d24654206e1c2b5acb425f2ec1fbc76814a57a7b057dfa` | `rea-application.json`, `details.partial_observation` | Full artifact inventory; zero parsed JavaScript files after helper startup failure |
| E2 | `ev_ac5b6f0769f47603747fcf2abec7a2980bedf7d986b23bd9323df29b9cde7501` | `rea-main-cache.json`, `details.partial_observation` | Caller-selected `package.json` and `main.js`; 36 other inventoried files outside semantic analysis scope |
| E3 | `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37` | `rea-renderer-bundle.json` | MCP analysis of `package.json` and `app.js`; source parsing succeeded, expanded semantic graph exceeded its result memory budget |
| E3 summary | `ev_415d70cd7f988e2c9ed903f2b5d3be98983f690c32ec5c590ecd12621c6158cb` | Same exported bundle | Projection of E3, not a separate analysis |

E1 inventoried 38 relevant files and read 16,558,635 text bytes. Its zero browser-window/IPC counts are **not evidence of absence**: the source worker failed before parsing. The error reported macOS process ownership helper compilation failure via `xcrun`; its compiler diagnostics were truncated.

`rea doctor --client codex --json` was saved as `rea-doctor.json`. It reported Node 26.10.0, an aligned installed skill, and missing Codex MCP registration/configuration drift. It also reported no configured Ghidra, IDA, or JADX provider. These are separate issues from JavaScript helper compilation; static JavaScript analysis does not require those engines. No client configuration was modified.

The installed REA implementation exposes `REA_DARWIN_MODULE_CACHE_PATH`. Setting it to the writable `/private/tmp/zorid-reference-20261016/swift-cache` allowed the scoped E2 source analysis to run without weakening the sandbox or modifying REA. E2 parsed one JavaScript file, visited 28,792 AST nodes, and retained 87 findings with zero reported parse failures. Its source text scope was 203,962 bytes.

The command still returned `cleanup_incomplete`: process-table inspection failed with `spawn EPERM`. REA named worker PID 69583 and its retained temporary directory `/var/folders/yc/__symlbx5zxd7v1vhwh84z180000gn/T/rea-javascript-analysis-zJSGmp`. A subsequent ordinary `os.kill(69583, 0)` existence check returned `ProcessLookupError`, confirming that PID was absent at that check. This does not independently prove that all descendants were gone; REA's cleanup guarantee remains unverified. The temporary directory remained present and was preserved. At that stage further analyzer targets were not opened. E3 later ran through the connected MCP server and did not return that process-cleanup error; it does not retroactively verify E2 cleanup.

E2 is retained **partial evidence**, not an unqualified successful full-application analysis. Its graph coverage is partial and its syntax observations do not establish runtime execution, defaults, reachability, or enforcement.

## Renderer analysis through connected REA

E3 selected only `package.json` and `app.js`, using a requested worker old-space heap of 1536 MiB. It read 3,942,386 text bytes, parsed one JavaScript file, visited 1,123,389 AST nodes, extracted 195 bundled modules, and reported 404 findings with zero parse failures. The artifact inventory still contains 38 relevant files; 36 files were outside this semantic analysis scope. The renderer source SHA-256 matches the ordinary inspection recorded below.

The expanded renderer semantic graph was **not retained in full**: its estimated retention cost of 1,287,209,784 bytes exceeded the parent's remaining result budget of 862,647,484 bytes. The complete Evidence record retains available module/static facts and an explicit resource-constraint unknown. Worker parsing success therefore does not establish complete application analysis. Increasing the worker heap alone would not fix this separate parent result budget. Repeating the unchanged producer is not the next step.

The exported 1,945,570-byte bundle contains E3 and its summary. Its top-level empty export `unknowns` list describes export bookkeeping, not the analysis's completeness. The parent graph explicitly reports partial coverage. Retained Evidence IDs are connection-local: another worker's MCP connection returned `evidence_integrity_mismatch` for the E3 ID, so that worker inspected the already-exported bundle rather than rerunning production.

Useful stable observations in this exact artifact:

| Observation | E3 node | Interpretation / boundary |
| --- | --- | --- |
| `app.js` source module | `jag_node_621f724371e7aca9238d1f3a97fd54476f29e95749ed28f0e9b6a7f00f7078a2` | Source-module identity; retained import/export relationship counts of zero do not prove there is no runtime API. |
| `app.js` asset | `jag_node_835302518ae2b71fac6b71ee3a61f27814e57673f1becaa1ae56bddc3d05be55` | 3,942,126 bytes; partial analysis status. |
| Bundler factories labeled `webpack` | For example `jag_node_92b2928089aaf212a900b70c3daa6d1765c8ea8eb53e5dc3a48a30f551ae564e` | Inert AST factory recognition, stronger than a name search; does not determine exact bundler version or distinguish all webpack-compatible producers. |
| `SecureStorageWeb` export | Same node, artifact-local module `3708` | Named static module export, not proof of its execution or package version. |
| `SecureStorageNative` export | `jag_node_b23d0e67d5b1caf55b4e93403d8248d299faf6d57007a11193026b4a6d8b00ff` | Artifact-local module `1611`; does not verify the corresponding native mobile plugin. |
| `InAppReviewWeb` export | `jag_node_2c5a792eac6ddbc1430f7a37544418400faa3e6e1e56f1253599982fbe9649f5` | Artifact-local module `9175`; native review behavior remains unknown. |

Bundled numeric module keys are valid only for this build. They are not cross-version identities. The complete public `obsidian` module export boundary, exact dependency versions, and plugin-to-host bindings remain unresolved in this retained evidence. Neither E3 nor its export ran the target application or observed UI/runtime behavior.

## Stack findings

| Component | Observation | Strength / remaining unknown |
| --- | --- | --- |
| Electron | E2 resolves literal `electron` imports and two `BrowserWindow` creation sites in `main.js`. Installed framework metadata reports 31.6.0. | Shipped-artifact observations. Runtime startup and exact window settings unverified. |
| JavaScript and CSS | Payload contains JavaScript, HTML, and CSS assets. E2 parses `main.js`; E3 parses `app.js` and recognizes webpack-format module factories. | Direct static evidence. Original authoring language, complete build pipeline, exact bundler producer/version, and dependency versions remain unknown. |
| Electron remote bridge | Launcher manifest declares `@electron/remote` 2.1.2; its installed package manifest also reports 2.1.2. | Ordinary JSON inspection. Presence does not prove every API is used. |
| Native filesystem/font helpers | Payload manifest declares `btime` and `get-fonts`; launcher also declares `vibrancy-win`. | Ordinary manifest observations. Native implementations, ABI behavior, and platform-specific use are not analyzed. |
| CodeMirror / Lezer | Ordinary literal inspection of payload `app.js` finds `@codemirror/state`, `/view`, `/language`, `/commands`, `/search`, `/autocomplete`, and other package names; also `@lezer/common`, `/highlight`, and `/lr`. | Consistent with the modular CodeMirror editor stack. Exact resolved versions, extensions, and compatibility contract remain unverified. This is not an REA semantic finding. |
| Capacitor | Ordinary literal inspection finds `window.Capacitor`, `CapacitorCookies`, and `CapacitorHttp` in desktop payload `app.js`. | Supports shared code containing Capacitor integration. Does not verify a mobile package, native project, Capacitor version, or iOS/Android runtime behavior. |
| Rendering libraries | Ordinary literal inspection finds names associated with Moment, DOMPurify, MathJax, PDF.js, Mermaid, Prism, and Pixi in `app.js`. | Candidate bundled library integrations only. Marker names alone do not establish versions, execution paths, completeness, or exact dependency requirements. |
| UI framework | Bounded case-sensitive literal searches for `React`, `Svelte`, and `Vue` in `app.js` found no occurrences. | Does **not** prove framework absence or justify claiming an exact original authoring stack. |

The inspected `app.js` digest was `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`. These marker searches were ordinary read-only inspection, clearly distinct from REA Evidence. No recovered code or CSS is included here.

## Electron surface observed by REA

E2 records two BrowserWindow sites, 47 literal main-side IPC operations, and one sender-validation observation. Window options are partly dynamic. No renderer source was selected, so zero renderer transmissions/listeners or paired channels cannot establish that none exist.

Observed channel names cover vault management (`vault`, `vault-open`, `vault-list`, `vault-move`, `vault-remove`, `vault-message`), filesystem/OS integration (`open-file`, `open-url`, `trash`, `documents-dir`, `desktop-dir`, `file-url`), menus (`context-menu`, `set-menu`, `render-menu`, `update-menu-items`), and lifecycle/update operations (`is-closing`, `is-quitting`, `relaunch`, `check-update`, `update`). Their names are investigation entry points; they do not define arguments, response shapes, or user-visible behavior.

Two relevant browser-window node IDs are `jag_node_449c356539a6a8a103c587379984ec0acec47bd44512b1d460332bae28fb07f9` and `jag_node_d0d729d0e9485c6021e26baec89fd3cde6af1e3052894b986a1a3b4efc3d73d3`. A proven literal Electron import node is `jag_node_61561f95fa66efe6525b31567954c8a58bd0f3667b208e85d3c7d760ec396cdd`.

## Focused Markdown embed and properties inspection

This follow-up reused E3's exported bundle; it did not rerun analysis or execute Obsidian. The behavior candidates below come from focused ordinary reading of the same digest-bound `app.js`, not new REA semantic facts. E3 identifies that source as node `jag_node_621f724371e7aca9238d1f3a97fd54476f29e95749ed28f0e9b6a7f00f7078a2`, under Evidence `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. Positions below are zero-based Unicode character offsets in Python's UTF-8-decoded source, not byte offsets or REA line/column ranges. They are reproducible only for the stated digest.

### YAML dependency and serialization

The embedded YAML implementation is strongly attributable to the **`yaml` package by Eemeli Aro**. At character offset 654741 it declares the same seven global YAML node identity symbols used by `yaml` 2.x. At offsets 752134–753000 its parser composes a document, rejects multiple documents, handles parse errors, then converts the document to JavaScript. The public `parseYaml` and `stringifyYaml` exports point into that implementation. These observations were corroborated against the installed open-source `yaml` 2.9.0 package's `dist/nodes/identity.js` and `dist/public-api.js`, located in REA's npm dependency tree. The upstream [parser/stringifier API](https://github.com/eemeli/yaml/blob/main/src/public-api.ts) supports the same public concepts.

This is stronger evidence than a `yaml` string alone and favors `yaml` over `js-yaml` for the reconstruction. It does **not** identify the exact version embedded by Obsidian. No `eemeli`, `yaml@`, ISC license notice, or semantic `x.y.z` version literal was found in the bounded embedded YAML section at offsets 654600–753000. The known local 2.9.0 version is a possible implementation dependency, not an established Obsidian dependency version. The [upstream package metadata](https://raw.githubusercontent.com/eemeli/yaml/v2.8.1/package.json) identifies the package as ISC-licensed; no such license declaration was recovered from the bounded Obsidian section.

At offsets 1620035–1620515, `parseYaml` delegates with default parser options. `stringifyYaml` supplies an empty null representation, disables line wrapping, and disables creation of aliases for duplicate object references. These correspond to the public `nullStr`, `lineWidth`, and `aliasDuplicateObjects` options in the [upstream documentation](https://github.com/eemeli/yaml/blob/main/docs/03_options.md). Parser and serialization compatibility tests should therefore cover nulls, quoted strings that resemble booleans/numbers/dates, multiline strings, arrays, nested mappings, duplicate keys, aliases, invalid YAML, and multiple documents.

The `processFrontMatter` implementation near offsets 1802594–1804530 performs a vault text-processing operation for Markdown files. Its helper parses frontmatter into a JavaScript value, uses an object fallback when appropriate, invokes the supplied callback, then serializes the resulting object and replaces the frontmatter text. If no keys remain, it removes existing frontmatter. The properties editor serializes its current property entries to an object near offset 1853947; its save operation forwards that object to the owner. A Markdown view owner near offset 3088029 replaces frontmatter using the same serializer family.

Consequently, comment/quote/spacing preservation is **not an observed property of these reference write paths**. Plain-object serialization does not retain a YAML document's comments and formatting metadata. A CST-preserving writer in Zorid may be a deliberate preservation feature, but cannot be described as verified reference parity on this evidence. Actual reference outputs for these cases still require runtime fixtures.

### Property metadata candidates

The manager around offsets 1767800–1774300 tracks assigned property types using case-insensitive property-name keys while retaining a display name. It reads and writes vault configuration `types.json`, with an object under the key `types`. It maintains built-in assignments for `aliases`, `cssclasses`, and `tags`. Observed widget registrations include text, number, checkbox, date, datetime, list-like `multitext`, tags, aliases, file, folder, and property. Registration alone does not establish that every widget is exposed in the default property-type menu.

Static type inference distinguishes null/text, date-like and datetime-like strings, numbers, booleans, compatible arrays, and unsupported values. When an assigned type and an inferred type differ, property rendering near offset 1862179 retains both and can show a type-mismatch warning. Thus coercing arbitrary values to text would lose observed distinctions. The manager also listens for metadata-cache changes and configuration changes; a whole-vault rescan on every keystroke is not required by this evidence.

### Markdown embed candidates

The parser near offset 756362 creates internal-embed nodes for embed syntax. The embed resolver near offset 2686058 resolves the link relative to its source note using the metadata cache, selects an extension-specific embed creator, increments nesting depth, and permits that creator only while the resulting depth is at most five. Fallback handling exists for unsupported or unresolved targets. This is evidence for bounded recursive embed handling, not a complete description of each fallback's UI.

One Markdown embed path near offsets 2040000–2041600 reads the target through the vault's cached-read API, resolves its subpath against metadata, slices selected content when a subpath resolves, renders/sanitizes the content, and invokes Markdown postprocessors with the **embedded note's path** as the source path. That path matters for links and attachments inside an embedded note. The static path also waits for postprocessor promises. Missing or stale metadata and malformed subpaths remain runtime test cases.

A separate editable Markdown embed implementation follows the depth resolver near offset 2686200. It includes an open-link affordance, title handling, property editor, preview/editor modes, and subpath-aware saving. Therefore full Markdown-embed parity extends beyond displaying static rendered HTML. The ordinary reading above is intentionally bounded and does not establish all heading/block extraction rules, refresh behavior, or editor interactions.

### Performance boundary

The observed cached reads, metadata cache, asynchronous postprocessors, change listeners, and bounded embed depth provide architectural candidates. They are **not performance measurements**. No reference latency, memory, throughput, large-vault capacity, or rendering benchmark was obtained. Zorid's own benchmarks must state workload, hardware/runtime, and measured operation; a passing self-benchmark cannot certify reference performance parity.

## Parity evidence still required

- Fresh-install runtime screenshots and interaction recordings at a fixed OS, viewport, theme, scale, and Obsidian version. Static CSS or class names do not establish a visual match.
- Startup, vault chooser, note editing, live preview, selection/cursor behavior, menus, dialogs, settings, tab/split layout, focus, shortcuts, drag/drop, accessibility, and session persistence comparisons.
- Completion of the resource-limited renderer/editor analysis and behavior tests for Markdown, properties, links, backlinks, search, graph, Canvas, attachments, PDF, audio, workspaces, and each built-in plugin.
- Native helper analysis and OS integration behavior where required. No native decompilation was performed in this pass.
- Matching mobile device/simulator observations. The subsequently supplied Android APK was inspected separately in `android-reference.md`; no IPA or native runtime equivalence is established. Desktop Capacitor markers alone do not prove mobile parity.
- Plugin API and editor extension compatibility fixtures using real third-party plugins, with versioned expected behavior. Import names and IPC inventories alone do not prove plugin compatibility.
- Exact dependency and runtime versions beyond the direct manifest/plist facts above. A candidate package choice in Zorid must remain labeled as an implementation choice until confirmed.

Full feature, UI, UX, vault, mobile, and plugin parity remains unverified and incomplete. This report is evidence for further reconstruction work, not a parity certification.
