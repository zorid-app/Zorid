Here’s the research-backed picture: **Obsidian’s public plugin API is designed as a typed, local, lifecycle-managed extension layer over the running Obsidian app**, not as a remote API or a locked-down browser-extension-style permission system.

## 1. The core design: one plugin class, one app gateway

Every plugin is expected to ship a `manifest.json` plus a compiled `main.js`. The manifest declares identity and compatibility fields such as `id`, `name`, `version`, `minAppVersion`, `description`, and `isDesktopOnly`; the `main.js` file is the plugin entry point, imports the API from `obsidian`, and must export a default class extending `Plugin`. External dependencies are bundled into that single entry bundle. ([GitHub](https://github.com/obsidianmd/obsidian-api "GitHub - obsidianmd/obsidian-api: Type definitions for the latest Obsidian API. · GitHub"))

At runtime, the main mental model is:

```text
manifest.json + main.js + optional styles.css
        |
default class extends Plugin
        |
this.app
        |
Vault / Workspace / MetadataCache / FileManager / UI / Editor APIs
```

Obsidian explicitly describes `App` as the object that “owns everything else,” accessed through `this.app` inside a plugin. The major modules exposed through this gateway are `Vault` for files/folders, `Workspace` for panes/leaves/views, and `MetadataCache` for parsed Markdown metadata such as headings, links, embeds, tags, and blocks. ([GitHub](https://github.com/obsidianmd/obsidian-api "GitHub - obsidianmd/obsidian-api: Type definitions for the latest Obsidian API. · GitHub"))

The most important design choice is that Obsidian does **not** ask plugin authors to wire themselves into arbitrary internals first. It gives them a base class with a lifecycle, then exposes narrow-ish extension methods from that class: add a command, add a ribbon icon, add a status bar item, register a view, add a settings tab, save/load plugin data, register Markdown processors, and register editor extensions. ([GitHub](https://github.com/obsidianmd/obsidian-api/raw/refs/heads/master/obsidian.d.ts "raw.githubusercontent.com"))

## 2. The API surface is TypeScript-first and docs-generated

Obsidian’s public API is distributed as TypeScript declaration files in the `obsidian-api` repository; the repo describes itself as “Type definitions for the latest Obsidian API.” ([GitHub](https://github.com/obsidianmd/obsidian-api "GitHub - obsidianmd/obsidian-api: Type definitions for the latest Obsidian API. · GitHub")) The sample plugin also states that it depends on the latest `obsidian.d.ts` TypeScript definition file, which includes TSDoc comments. ([GitHub](https://github.com/obsidianmd/obsidian-sample-plugin "GitHub - obsidianmd/obsidian-sample-plugin: Template for Obsidian community plugins with build configuration and development best practices. · GitHub"))

That matters architecturally: the `.d.ts` file is not just an optional autocomplete helper. It is effectively the public contract. The raw `obsidian.d.ts` starts with a warning that it is automatically generated, and the developer-docs repo says the `References/TypeScript API` pages are generated from Obsidian’s codebase. ([GitHub](https://github.com/obsidianmd/obsidian-api/raw/refs/heads/master/obsidian.d.ts "raw.githubusercontent.com"))

So Obsidian’s API design seems to follow this pattern:

```text
Internal app code
   -> generated TypeScript public declarations
   -> developer docs / references
   -> sample plugin template
   -> community review guidelines
```

That gives developers strong typing and IDE support while letting Obsidian evolve the app internally. The downside is that some API documentation can feel like a typed reference rather than a fully explained conceptual guide, because the formal source of truth is the generated declaration surface.

## 3. Lifecycle is the organizing primitive

The `Plugin` class defines the plugin lifecycle with `onload()` and `onunload()`. Obsidian’s docs say `onload()` runs when the user starts using the plugin, while `onunload()` runs when the plugin is disabled and should release resources so the disabled plugin does not keep affecting app performance. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Getting%20started/Anatomy%20of%20a%20plugin.md "obsidian-developer-docs/en/Plugins/Getting started/Anatomy of a plugin.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

That lifecycle model is reinforced by helper registration APIs. Obsidian recommends `registerEvent()` for app/vault/workspace events so event handlers are automatically detached on unload, `registerDomEvent()` for persistent DOM listeners, and `registerInterval()` for timers. ([GitHub](https://github.com/obsidianmd/obsidian-api "GitHub - obsidianmd/obsidian-api: Type definitions for the latest Obsidian API. · GitHub"))

This is a very deliberate API design choice. Instead of making every plugin author manually track teardown functions, Obsidian makes “register this with the plugin” the common path:

```ts
import { Plugin } from "obsidian";

export default class ExamplePlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: "do-something",
      name: "Do something",
      callback: () => {
        console.log("Action");
      },
    });

    this.registerEvent(
      this.app.vault.on("create", file => {
        console.log("Created", file.path);
      })
    );

    this.registerInterval(
      window.setInterval(() => {
        console.log("tick");
      }, 1000)
    );
  }
}
```

The design principle is: **extension points should be lifecycle-owned**. If the plugin unloads, Obsidian should be able to clean up most of what the plugin registered.

## 4. The API is vault-centric, not database-centric

Obsidian’s core domain is the vault: a folder of notes and subfolders. The Vault API is the preferred abstraction for visible files inside Obsidian, even though desktop plugins can access the filesystem using Node APIs. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Vault.md "obsidian-developer-docs/en/Plugins/Vault.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

Obsidian distinguishes between `read()` and `cachedRead()`: `cachedRead()` is recommended when displaying content, while `read()` is recommended before modifying and writing content back, to avoid overwriting a newer version with stale data. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Vault.md "obsidian-developer-docs/en/Plugins/Vault.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

The guidelines go further: for background file changes, use `Vault.process()` instead of `Vault.modify()` because it modifies atomically and avoids conflicts with other plugins. For frontmatter, use `FileManager.processFrontMatter()` rather than parsing and rewriting YAML manually. Obsidian also recommends the Vault API over the lower-level Adapter API because Vault has a cache layer and serializes file operations to avoid race conditions. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Plugin%20guidelines.md "obsidian-developer-docs/en/Plugins/Releasing/Plugin guidelines.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

That tells us a lot about the API philosophy: **give plugin authors high-level safe operations for the user’s notes, then keep lower-level escape hatches available but discouraged for routine work.**

## 5. Workspace design mirrors Obsidian’s UI model

Obsidian’s UI is modeled around a workspace tree made of splits, tabs, and leaves. A leaf displays content using a view type, such as Markdown view, graph view, file explorer, or a custom plugin view. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/User%20interface/Workspace.md "obsidian-developer-docs/en/Plugins/User interface/Workspace.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

Plugins can register custom views by creating an `ItemView` subclass and registering a factory through `registerView()`. Obsidian’s view docs emphasize that each view has a unique type string and lifecycle-like methods such as `onOpen()` and `onClose()`. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/User%20interface/Views.md "obsidian-developer-docs/en/Plugins/User interface/Views.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

The docs also warn plugin authors not to manage long-lived references to custom views; Obsidian may create view instances multiple times, and plugins should instead find views through workspace leaf queries like `getLeavesOfType()`. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/User%20interface/Views.md "obsidian-developer-docs/en/Plugins/User interface/Views.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

This is a good example of Obsidian’s API style: **the public API exposes the app’s real conceptual model, but asks plugins to interact through lookup/registration patterns rather than owning internal objects indefinitely.**

## 6. Commands are first-class, user-facing extension points

Commands are actions exposed through the Command Palette and optionally hotkeys. Plugins register commands through `addCommand()` inside `onload()`. Obsidian supports different command callback types: unconditional `callback`, conditional `checkCallback`, editor-specific `editorCallback`, and editor-specific conditional callbacks. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/User%20interface/Commands.md "obsidian-developer-docs/en/Plugins/User interface/Commands.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

The command system shows another API design principle: **capabilities are exposed in the same way users discover features**. A plugin action is not merely a function; it can become a command, appear in the Command Palette, and integrate with keyboard shortcuts. Obsidian discourages default hotkeys for public plugins because they often conflict with user or plugin shortcuts. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/User%20interface/Commands.md "obsidian-developer-docs/en/Plugins/User interface/Commands.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

## 7. Editor APIs are layered: simple abstraction first, CodeMirror escape hatch second

For editing Markdown, Obsidian exposes an `Editor` abstraction for reading and manipulating the active Markdown document. The docs say this abstraction bridges CodeMirror 6 and the legacy CodeMirror 5 editor available on desktop, so using `Editor` instead of raw CodeMirror improves cross-platform compatibility. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Editor/Editor.md "obsidian-developer-docs/en/Plugins/Editor/Editor.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

For deeper editor customization, Obsidian exposes CodeMirror 6 extensions through `registerEditorExtension()`. The docs explicitly say Obsidian uses CodeMirror 6 for the Markdown editor, and that an Obsidian editor extension is effectively a CM6 extension. They recommend Markdown post processors for Reading view rendering changes, and CM6 editor extensions when changing Live Preview behavior. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Editor/Editor%20extensions.md "obsidian-developer-docs/en/Plugins/Editor/Editor extensions.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

This is a strong design pattern: **Obsidian gives a simple stable abstraction for common text edits, then exposes the underlying expert system for advanced use cases.** That keeps simple plugins simple, while still enabling complex editor tooling.

## 8. Markdown rendering is extensible after parsing

For Reading view, plugins can register Markdown post processors. These run after Markdown has been converted to HTML and can add, remove, or replace HTML elements in the rendered document. Obsidian also exposes `registerMarkdownCodeBlockProcessor()` for custom fenced code blocks, similar to how built-in Mermaid blocks render diagrams. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Editor/Markdown%20post%20processing.md "obsidian-developer-docs/en/Plugins/Editor/Markdown post processing.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

This design avoids asking plugins to replace the whole Markdown parser. Instead, plugins can hook into a safe stage of the rendering pipeline: after Markdown is parsed into HTML, but before the user sees the final customized rendering.

## 9. UI design is DOM-based, but with Obsidian helpers and style conventions

Obsidian plugin UI is built with normal `HTMLElement` objects, but Obsidian adds helper methods like `createEl()` and provides UI wrapper classes such as settings tabs and `Setting`. The HTML docs explicitly describe container elements as normal `HTMLElement` objects and show `createEl()` for building UI inside them. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/User%20interface/HTML%20elements.md "obsidian-developer-docs/en/Plugins/User interface/HTML elements.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

Settings are treated as a standard plugin feature. The settings docs show a pattern where plugins define a settings interface, load settings with `loadData()`, save them with `saveData()`, and add a settings tab with `addSettingTab()`. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/User%20interface/Settings.md "obsidian-developer-docs/en/Plugins/User interface/Settings.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

The UI guidelines also reveal the safety model. Obsidian warns against `innerHTML`, `outerHTML`, and `insertAdjacentHTML` with user input, recommending DOM APIs or Obsidian helpers like `createEl()`, `createDiv()`, and `createSpan()` instead. It also recommends CSS classes and Obsidian CSS variables rather than hardcoded inline styles, so plugins respect themes and snippets. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Plugin%20guidelines.md "obsidian-developer-docs/en/Plugins/Releasing/Plugin guidelines.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

So the UI API is pragmatic: **plugins can use the DOM directly, but Obsidian nudges them toward safer construction and theme-compatible styling.**

## 10. Platform design: cross-platform until you opt into desktop-only power

Obsidian plugins can run on desktop and mobile, but Node.js and Electron APIs are only available on desktop. Submission requirements say that if a plugin uses Node or Electron APIs, it must set `isDesktopOnly` to `true` in `manifest.json`. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Submission%20requirements%20for%20plugins.md "obsidian-developer-docs/en/Plugins/Releasing/Submission requirements for plugins.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

The manifest itself includes `isDesktopOnly`, described as whether the plugin uses NodeJS or Electron APIs. ([GitHub](https://github.com/obsidianmd/obsidian-api "GitHub - obsidianmd/obsidian-api: Type definitions for the latest Obsidian API. · GitHub")) The public API also exposes platform information such as mobile, iOS, Android, macOS, Windows, Linux, and Safari flags. ([GitHub](https://github.com/obsidianmd/obsidian-api/raw/refs/heads/master/obsidian.d.ts "raw.githubusercontent.com"))

The design tradeoff is clear: Obsidian keeps the plugin API broad and powerful on desktop, while using manifest compatibility and platform checks to handle mobile constraints.

## 11. Distribution is GitHub-centered, versioned, and review-gated

For community plugins, Obsidian’s distribution model is not an app-store upload flow. The official flow is: publish source on GitHub, include `README.md`, `LICENSE`, and `manifest.json`, create a GitHub release whose tag matches the manifest version, and attach `main.js`, `manifest.json`, and optionally `styles.css`. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Submit%20your%20plugin.md "obsidian-developer-docs/en/Plugins/Releasing/Submit your plugin.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

After a plugin is accepted into the Community directory, users can install it from inside Obsidian; future updates are downloaded from GitHub releases. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Submit%20your%20plugin.md "obsidian-developer-docs/en/Plugins/Releasing/Submit your plugin.md at main · obsidianmd/obsidian-developer-docs · GitHub")) The sample plugin also uses `versions.json` to map plugin versions to minimum Obsidian versions, allowing older Obsidian versions to download compatible older plugin releases. ([GitHub](https://github.com/obsidianmd/obsidian-sample-plugin "GitHub - obsidianmd/obsidian-sample-plugin: Template for Obsidian community plugins with build configuration and development best practices. · GitHub"))

This means Obsidian’s public API is designed together with a distribution contract:

```text
manifest.json says what the plugin is
versions.json says which app versions it supports
GitHub release assets provide installable files
community review/guidelines shape acceptable behavior
```

## 12. The deeper design principles

My read is that Obsidian’s API is built around these principles:

**First, expose the real product model.** Plugins work with vaults, files, leaves, views, commands, Markdown rendering, metadata caches, and editor state—the same concepts users experience in the app. ([GitHub](https://github.com/obsidianmd/obsidian-api "GitHub - obsidianmd/obsidian-api: Type definitions for the latest Obsidian API. · GitHub"))

**Second, make registration the default extension mechanism.** Instead of “go mutate internals,” plugins register commands, views, events, post processors, editor extensions, ribbon icons, status bar elements, and settings tabs. Those registrations can then be cleaned up when the plugin unloads. ([GitHub](https://github.com/obsidianmd/obsidian-api "GitHub - obsidianmd/obsidian-api: Type definitions for the latest Obsidian API. · GitHub"))

**Third, provide safe high-level paths before low-level escape hatches.** Use `Editor` for active document edits, `Vault.process()` for background file changes, `FileManager.processFrontMatter()` for YAML, and Vault APIs over Adapter APIs. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Editor/Editor.md "obsidian-developer-docs/en/Plugins/Editor/Editor.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

**Fourth, rely on TypeScript as the public contract.** The API is heavily typed, generated, annotated, and consumed by the sample plugin template. ([GitHub](https://github.com/obsidianmd/obsidian-api "GitHub - obsidianmd/obsidian-api: Type definitions for the latest Obsidian API. · GitHub"))

**Fifth, use guidelines and review rather than a granular permission system.** The official docs focus on submission requirements, safe DOM construction, resource cleanup, appropriate file APIs, command behavior, and styling conventions. Node/Electron power is controlled mainly by platform availability and the `isDesktopOnly` manifest flag. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Submission%20requirements%20for%20plugins.md "obsidian-developer-docs/en/Plugins/Releasing/Submission requirements for plugins.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

## 13. Strengths and tradeoffs

The strengths are strong developer ergonomics, a simple starting model, excellent TypeScript support, and a powerful extension surface. A beginner can add a command or settings tab quickly, while advanced developers can write CodeMirror 6 extensions, custom views, Markdown processors, and deep vault automation. ([GitHub](https://github.com/obsidianmd/obsidian-sample-plugin "GitHub - obsidianmd/obsidian-sample-plugin: Template for Obsidian community plugins with build configuration and development best practices. · GitHub"))

The tradeoffs are also real. Because plugins are powerful local code, safety depends heavily on user trust, community review, and developer discipline. The DOM API is flexible enough to create XSS risks if authors use unsafe HTML APIs, which is why Obsidian’s guidelines explicitly warn against them. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Plugin%20guidelines.md "obsidian-developer-docs/en/Plugins/Releasing/Plugin guidelines.md at main · obsidianmd/obsidian-developer-docs · GitHub")) Desktop/mobile differences also leak into plugin design because Node and Electron APIs are desktop-only. ([GitHub](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Submission%20requirements%20for%20plugins.md "obsidian-developer-docs/en/Plugins/Releasing/Submission requirements for plugins.md at main · obsidianmd/obsidian-developer-docs · GitHub"))

The API is best understood as a **native-app plugin API**, closer to VS Code or a desktop editor extension model than to a web SaaS API. It prioritizes local power, user-owned files, typed extension points, and lifecycle cleanup over capability sandboxing.

## What to copy from Obsidian if you’re designing your own plugin API

The most reusable ideas are: make one lifecycle base class; expose the app through a small set of domain modules; make extension points registration-based; auto-clean registered resources; publish a typed API contract; provide an official sample plugin; prefer safe high-level APIs over raw storage access; and tie distribution to manifest compatibility plus review guidelines. Obsidian’s design works because the public API mirrors the app’s conceptual architecture while giving plugin authors clear, typed places to attach behavior.
