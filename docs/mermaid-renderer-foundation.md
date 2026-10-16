# Shared Mermaid renderer foundation

`src/ui/mermaid-renderer.ts` is an original, injected-engine component based on the bounded [reference audit](mermaid-reference.md). It does not import recovered assets or install/load an actual Mermaid dependency. This checkpoint validates lifecycle using fake engines, not real Mermaid parsing, pixels, native geometry or mobile behavior.

## Host contract

Create one `createMermaidRenderer({loadEngine(document)})` service per workspace lifetime. The loader must return the **public** `initialize(configuration)` / asynchronous `render(id, source, container)` API from an independently acquired local Mermaid 11.13.0 runtime. An engine object is initialized once per service with the audited strict configuration and protected configuration keys. The loader is cached per owner document and retried after failure. It must provide correct owner-window execution: returning an engine bound to another window's global document is not supported merely because an owner document argument was supplied.

Mount with `renderer.mount(host, options)`:

- `source`: exact fenced body, preserved on errors. `normalizeMermaidCodeText(text)` removes one terminal newline when adapting a Reading `code` node; do not apply that helper repeatedly or blindly trim the already-extracted Live body.
- `sourcePath`: owning note path for link resolution.
- `trust.isAllowed()`: reads the owning vault's decision synchronously. Only boolean true permits rendering. No trust is stored globally or inside the service.
- `trust.requestAllow()`: persists approval for that same vault. The renderer waits for completion and rereads the decision; it never assumes a resolved callback granted permission. Hosts must not bind this closure to a mutable “current vault” variable.
- `openLink(event, target, sourcePath, kind)`: routes internal/external links through host services and handles modifiers. Native anchor navigation is prevented. Without this callback, diagrams remain visible but their links are inert.
- `onMeasure()`: requests editor/layout measurement. It is called on state changes and owner-window ResizeObserver notifications.
- `onError(error)`: reports load, render, trust-callback and host-callback failures. Errors from this observer cannot strand the queue.
- Optional `isVisible()` supplements the connected/hidden-ancestor checks. Call `refreshVisibility()` after changing a custom visibility policy that does not alter DOM attributes.
- Optional `guardText` supplies localized title, description and Allow text. Defaults are original copy because exact reference localization remains unverified.

A mount exposes the current generation's `ready`, `update(source)`, `refreshTrust()`, `refreshVisibility()` and `destroy()`. `ready` resolves for guard, rendered output, displayed error or cancellation; it is not a canvas/native-paint guarantee and does not reject on parse failure. `update` returns the new generation's promise and settles the prior generation immediately. Unchanged source preserves the current render. `refreshTrust` invalidates existing output; the settings owner must call it on every affected mount after approval/revocation, including changes made elsewhere. Destroy the handle on note close/replacement and destroy the service on workspace/vault teardown.

## Rendering and lifecycle

The service serializes calls through the public API. Pending obsolete jobs are pruned; a queued destroyed block never executes. Active Mermaid work cannot be interrupted by this API, but stale results and late failures cannot attach or overwrite newer source. Closing a mount settles its promise and removes owned measurement/error nodes immediately. The active operation still consumes its eventual completion and cleans late artifacts. An indefinitely pending engine call can delay later work; no false cancellation guarantee is made.

Hidden or detached hosts wait without loading the engine. Pending visibility subscriptions share one MutationObserver per document, released when no mount waits. Measurement width uses host width, parent width, then owner-window inner width. Temporary measurement DOM belongs to the host's document. The renderer does not rerender on each ResizeObserver callback; it asks the host to measure, avoiding self-induced layout/render loops.

Output consumes only `render().svg`, never `bindFunctions`. Strict Mermaid output is the security boundary; the wrapper is **not a general-purpose raw SVG sanitizer**. Additional checks reject invalid/non-SVG output and remove active elements, event-handler attributes and executable anchor schemes. DOM-based internal-link adaptation passes the original note target to the host while using a harmless local anchor href. Marker IDs and marker URL/style references are namespaced per render. No mutable SVG node is shared between mounts.

On load/parse/draw/invalid-output errors, the renderer displays the audited error prefix and error description as text, alongside the exact original source. Keeping both message and original source is an intentional recovery behavior; the inspected reference replaces code text with its error message. The recovered fractional-width patch is **not implemented**. The audit identifies its behavior, but real upstream/reference fixtures and review are still required before proposing an original compatibility correction.

## Integration still required

The component is not wired into Reading Markdown or Live Edit. Host integration must provide vault settings/persistence, the Allow broadcast, link routing, fenced source/reveal mapping, lifecycle registration, source-action placement, and CodeMirror measurement. Reading and Live must share this component while keeping editor selection ownership separate. Use the audited classes for corresponding layout: `.mermaid`, `.mermaid-wrapper.is-guarded`, guard header/text/actions/source; `.zorid-mermaid-error` is original recovery UI. Shared CSS still needs the reference-backed border/header spacing, font variable, horizontal overflow and dark-theme filter.

Root must acquire/package official Mermaid 11.13.0 locally under its license and test actual Electron/file and Capacitor loading, dependency asset closure, CSP compatibility and all diagram families. No CDN fallback, broad security-policy relaxation, real-engine rendering or native test is part of this isolated patch.

## Focused verification

Fake-engine tests cover strict settings and source preservation, per-mount trust isolation, approval/revocation, permission changes during load/render, serialized execution, obsolete queued work, update races, immediate ready settlement, measurement/error DOM cleanup, late rejection consumption, retry after module-load failure, deferred visibility, internal/external link routing, inert callbacks, marker isolation, safe error text and service disposal. Serial invocation is `node --test --test-concurrency=1 tests/mermaid-renderer.test.ts`; no full suite or production build is required for this new isolated module.

Unit tests establish these ownership contracts only. Native reference comparison, actual upstream sanitization/configuration behavior, diagram geometry, HTML-label wrapping, font timing, source gesture parity, clipboard and memory under expensive diagrams remain outstanding acceptance work listed in the reference audit.

Independent lifecycle review cleared the requested scope: all 14 repository tests plus five temporary probes passed. The additional probes covered abandoned queue entries, queued trust revocation, stale Allow closures/microtask cancellation, shared observer teardown and punctuated marker-selector repair. No real engine, native UI or host integration was exercised by that review. TypeScript and diff checks pass for this checkpoint.
