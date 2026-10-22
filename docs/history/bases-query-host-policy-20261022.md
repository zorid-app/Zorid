# Bases query host policy — source audit, 2026-10-22

Owner: `bases_docs_model`; branch `codex/bases-query-host-policy`, worktree
`.worktrees/bases-query-host-policy`; frozen source **`80135256`**. This records
the existing host-selection behavior for Q7 of the
[implementation goal](../plans/bases-implementation-goal.md) and
[acceptance matrix](bases-acceptance-audit-20261022.md). It introduces no API,
host restriction or feature disablement. No app, build or tests were run.

## Selection and failure policy

The desktop/current-browser product target uses shared Rust query semantics.
The controller nevertheless retains a separate TypeScript compatibility path
for adapters **without** `documentSemantics`; it is not a recovery evaluator for
a failed Rust request. This is a source-derived boundary, not a claim of complete
support or parity for every no-service host.

| Condition | Current behavior / source |
| --- | --- |
| `adapter.documentSemantics` exists | [controller.ts:264](../../src/bases/controller.ts#L264) captures saved definition/current-file witnesses and invokes `SharedBaseQueryRunner`; it does not inspect a `baseAvailable` flag to choose another evaluator. `DocumentPin.base` is required by [document-semantics.ts:119](../../src/core/document-semantics.ts#L119). |
| Service is absent | [controller.ts:307](../../src/bases/controller.ts#L307) builds the legacy input from `Vault.entries` plus cached frontmatter/tags and calls `executeBaseQuery`. This branch has its own TS expression/query implementation. |
| Shared query, metadata, index catch-up, transport or projection fails | The outer [controller catch at line 321](../../src/bases/controller.ts#L321) publishes error state. It does not call the legacy evaluator, clear the service to force another branch, or convert a core error into empty-success rows. Existing coherent rows can remain visible with an error; they are not a successful replacement query. |
| Shared identities or source are unavailable/stale | [shared-query.ts:167](../../src/bases/shared-query.ts#L167) and its subsequent definition/settings checks fail explicitly. No row/path-derived identity or detached-metadata evaluation substitutes for the admitted snapshot. |
| Caller supplies TS custom functions on a shared host | [shared-query.ts:166](../../src/bases/shared-query.ts#L166) rejects them. The controller does not rerun the request on the JS path to accommodate callbacks. The legacy evaluator's callback surface is not a shared-host feature guarantee. |
| Optional indexing preview is absent | The published Rust query path remains. [shared-query.ts:169](../../src/bases/shared-query.ts#L169) gates previews separately from saved queries; inline Bases and property-settings cases can omit previews without changing the authoritative evaluator. |
| Preview is positively advertised but malformed | Missing preview methods/capability composition fail explicitly. A transient preview read can report preview status while the saved Rust path continues; that status handling does not evaluate rows in JS. |
| Index is not ready or a request retires | [shared-query.ts:222](../../src/bases/shared-query.ts#L222) waits on actual maintenance updates when available, or returns a clear indexing error; cancellation fences delivery and retires owned handles. It does not start a different evaluator. |

After catch-up and identity checks, the runner calls `pin.base` at
[shared-query.ts:282](../../src/bases/shared-query.ts#L282), checks the returned
definition/snapshot/coverage, and projects typed values. Optional feature flags
such as property targets, metadata rows and read-only previews do not mean the
entire Base query may silently move to TypeScript. `VaultAdapter.documentSemantics`
is explicitly optional in [types.ts:36](../../src/core/types.ts#L36); presence is
therefore a real boundary to inspect in each adapter, not infer from a host name.

## Host and adapter matrix

| Host/path | Actual initialization route | Query boundary and supported-scope evidence |
| --- | --- | --- |
| Current Electron/macOS product | [desktop/main.cjs:10](../../desktop/main.cjs#L10) requests the document runtime. The Rust host advertises document capabilities at [lib.rs:1300](../../crates/zorid-desktop-host/src/lib.rs#L1300); [client-admission.cjs](../../desktop/client-admission.cjs) retains only admitted operations; [editor-core.cjs:30](../../desktop/editor-core.cjs#L30) exposes document semantics. [platform/index.ts:141](../../src/platform/index.ts#L141) creates a service and attaches the same instance to the platform and adapter at lines 149/156. | Service-present controller path uses Rust. Missing or inconsistent positively advertised dependent capabilities fail during initialization. The platform factory also retains compatibility with older contexts that do not advertise a service; do not call that absence a successful current-core query. Final Electron journey/visual acceptance is separate. |
| Normal browser product | [browser-default.ts:175](../../src/platform/browser-default.ts#L175) requires Rust assets, opens the Worker/WASM runtime with `documentMaintenance: true`, admits its consumer and builds `defaultBrowserAdapter`. [browser-default.ts:120](../../src/platform/browser-default.ts#L120) attaches `createDocumentService(consumer.documentIndex)` when that admitted provider exists. [browser-core-runtime.ts:144](../../src/platform/browser-core-runtime.ts#L144) rejects missing requested maintenance; lines 150–170 construct the actual index/Base provider. [browser-client-admission.ts:159](../../src/platform/browser-client-admission.ts#L159) retains guarded provider calls. | This is the current Rust/WASM + IndexedDB route. Missing assets/requested runtime capabilities reject opening; normal startup does not choose the old localStorage preview vault as a repair. A lower-level adapter factory without a provider still lacks a service, so verify the exact constructed adapter in a fixture. |
| Independent CLI | [main.rs:788](../../crates/zorid-cli/src/main.rs#L788) dispatches `base-query` to [documents.rs:414](../../crates/zorid-cli/src/documents.rs#L414) on its native vault. | Rust query path, independent of the TS controller and Electron/daemon ownership. There is no JS fallback here. [Recorded CLI acceptance](../../tests/bases-cli-integration/acceptance-20261022.md) applies to its exact earlier closure and JSON/raw/guarded-write surface, not all later semantics or UI export commands. |
| iOS native-owned shell | [platform/index.ts:193](../../src/platform/index.ts#L193) selects `openNativeMobileVault`. [mobile/rust/src/lib.rs:476](../../mobile/rust/src/lib.rs#L476) advertises `documentSemantics: true`; older binaries may omit it. [mobile-native.ts:564](../../src/platform/mobile-native.ts#L564) conditionally creates the service and attaches it at lines 839/900. | Existing basic shared-service wiring is present; it is incorrect to say all mobile adapters lack it. The binding passes no desktop metadata/property-target/preview/maintenance options, which default false in [desktop-document-semantics.ts:52](../../src/platform/desktop-document-semantics.ts#L52). The platform returns `editorOnly: true`. Mobile Bases acceptance remains deferred; neither basic wiring nor omission of optional flags establishes full desktop capability. |
| Android filesystem route | [platform/index.ts:197](../../src/platform/index.ts#L197) retains [MobileAdapter](../../src/platform/mobile.ts#L7) until the native/JNI binding is ready. That class does not declare `documentSemantics`. | A BaseController instantiated on this adapter follows the no-service TS branch. This is existing source behavior, not new mobile acceptance, support expansion or a decision to disable it. |
| Older/custom desktop or other no-service adapters | `VaultAdapter.documentSemantics` is optional; the desktop platform attaches documents only when the admitted binding advertises them. | Existing TS compatibility evaluation remains reachable. Its supported extent is limited to its actual source/tests; no full rich-property, relation, shared-snapshot or current Rust semantic equivalence is established. Do not delete or widen it through this documentation audit. |
| Memory preview/test adapter | [memory-adapter.ts:4](../../src/core/memory-adapter.ts#L4) declares no document service. Basic controller/session fixtures construct it directly. | Those fixtures exercise the no-service path unless they explicitly inject a service. Passing component tests on MemoryAdapter do not prove Rust execution, admitted snapshots or native/browser integration. |
| Build-gated browser-core fixture | [platform/index.ts:203](../../src/platform/index.ts#L203) can select [browser-core-fixture.ts:35](../../src/platform/browser-core-fixture.ts#L35). It returns `new BrowserCoreAdapter(runtime)`; [browser-core.ts:52](../../src/platform/browser-core.ts#L52) has a `documentIndex` getter but does not attach `documentSemantics`. | **Concrete evidence trap:** Rust-backed storage does not make a mounted Base's query Rust-backed. This fixture's adapter selects the TS controller branch. It is deliberately build-gated fixture routing, not the normal browser startup path. |
| Dedicated Bases browser integration fixture | [fixture.mjs:43](../../tests/bases-browser-integration/fixture.mjs#L43) uses `defaultBrowserAdapter` and explicitly asserts its document service. | Appropriate route for the actual Worker/WASM Base campaign. Its semantics-page screenshot is not mounted product UI parity; a complete matched campaign is still required. |

The retained [BrowserAdapter](../../src/platform/browser.ts) localStorage class
and its tests are not evidence normal browser startup silently falls back to it.
Search of `src` finds its class declaration, while ordinary startup explicitly
calls `openDefaultBrowserVault`. Memory/mock service injection, a low-level
`documentIndex` getter and a production adapter's `documentSemantics` attachment
are three different facts.

## Scope of the retained no-service evaluator

The TS path reads ordinary file properties/tags and supports its existing query,
formula, search, sort and group behavior. Generic writable sessions still require
the existing buffer host ([session.ts:95](../../src/bases/session.ts#L95)); absence
of the query service does not itself make every legacy session read-only.
Conversely, its results have no Rust `shared` proof or captured core witnesses.

The source does not establish complete modern feature equivalence. For example,
[query.ts:279](../../src/bases/query.ts#L279) explicitly rejects resolved-link
metadata members `file.links`, `file.backlinks` and `file.embeds`. The controller's
legacy request supplies cached frontmatter/tags, not the Rust property-definition,
reverse-relation/rollup or prepared-namespace pipeline. Target pickers separately
report unavailable capability rather than run their target filter locally; see
[property-targets.ts](../../src/bases/property-targets.ts). Do not disguise these
limits as successful Rust queries or promise all current rich semantics on a
no-service adapter. No new restriction or removal is enacted here.

## Focused authored checks and execution limits

| Existing check | What it actually exercises |
| --- | --- |
| [bases-shared-controller.test.ts:55](../../tests/bases-shared-controller.test.ts#L55) | Injected service returns a value distinct from cached TS metadata, receives captured options/witnesses, and surfaces `Rust unavailable` after a forced service failure. This is a focused guard against silent JS recovery; its service is mocked. |
| [bases-controller.test.ts:10](../../tests/bases-controller.test.ts#L10), [bases-session.test.ts:15](../../tests/bases-session.test.ts#L15) | No-service MemoryAdapter controller/session behavior, including ordinary edits through NoteBuffer. These are valuable legacy/component checks, not a Rust implementation oracle. |
| [bases-preview-controller.test.ts:123](../../tests/bases-preview-controller.test.ts#L123), [bases-freshness-cancel.test.ts](../../tests/bases-freshness-cancel.test.ts) | Positive malformed preview capability fails; absent preview still permits published queries; request cancellation/handle retirement stay explicit. |
| [bases-property-targets.test.ts:83](../../tests/bases-property-targets.test.ts#L83) | Absent service or positively advertised missing target method is unavailable without a local filter fallback. |
| [browser-default-adapter.test.ts:38](../../tests/browser-default-adapter.test.ts#L38), [browser-core-runtime.test.ts](../../tests/browser-core-runtime.test.ts), [platform-desktop-durable.test.ts:147](../../tests/platform-desktop-durable.test.ts#L147) | Normal browser assets are required, runtime capability/ownership rules are tested, and desktop optional capabilities are not granted to legacy contexts. These use controlled host/transport fixtures. |
| [mobile-native.test.ts](../../tests/mobile-native.test.ts), [platform-dispatch.test.cjs](../../tests/platform-dispatch.test.cjs) | Existing mobile/platform dispatch contracts; they do not constitute this pass's deferred actual mobile Bases acceptance. |

This audit did not execute those checks. The
[coordinator checkpoint](../deferred-product-roadmap.md) records partial actual
Electron/browser campaigns and the earlier exact CLI pass separately. They do
not establish that every adapter above has completed the latest full runtime
campaign. A future passing fixture must identify its exact adapter/service,
native/WASM source hashes and observed query route; storage provenance alone is
insufficient.

Minimum acceptance evidence for the normal shared path:

- Identify the normal platform initialization route and assert that the **adapter
  passed to the mounted session/controller** has `documentSemantics`; a separate
  runtime's `documentIndex` property is insufficient.
- Observe the admitted Base invocation (`pin.base` and its actual desktop or
  Worker `document-index-base` transport) and validate independent returned
  identities/values against the recorded native/WASM artifact. A mocked pin proves
  routing only; a fixture's Rust storage calls do not prove Base evaluation.
- Keep the no-service fixture expectation distinct, and retain the focused
  service-error assertion that reports the error instead of returning cached TS
  results. Do not change fixture dispatch or mobile support to manufacture proof.

## Q7 disposition

The current selection policy and supported-host evidence boundary are now
explicit: current Electron/browser/CLI target Rust; service failure never requests
JS recovery; no-service compatibility remains with its bounded, unverified full
feature extent; native mobile acceptance remains later work. The concrete
browser-core fixture distinction must remain visible in future evidence reports.
Final matched desktop/browser/WASM runs, any intentional future change to legacy
host support, and main integration belong to their existing owners. This document
does not mark runtime acceptance or change which code paths execute.
