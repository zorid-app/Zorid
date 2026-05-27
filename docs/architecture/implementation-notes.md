# Implementation Notes

Status: v0 implementation evidence  
Date: 2026-05-27

## Architecture lock preserved

- Public plugins use the typed `ZoridPluginContext`; `AppAPI` remains metadata-only with no public `getService()`.
- `FieldsAPI` and `DataViewsAPI` are host-owned public-prealpha proxies on `ctx.fields` and `ctx.dataViews`.
- First-wave core plugin manifests remain desktop-only unless explicitly mobile-tested.
- Plugin UI ABI is framework-neutral DOM mount/unmount; Vue remains shell implementation detail.
- Plugin Power / Shell UI replacement remains deferred to `docs/product/v1-features/plugin-power-and-shell-ui-extensibility.md`.

## Mobile skeleton

The mobile workspace is intentionally a placeholder: `apps/mobile/capacitor.config.json` declares the app identity and `packages/mobile-shell` exposes a primary-surface state model without claiming mobile parity.

## Performance/reactivity guardrails

- `packages/ui-vue` exposes a pure virtual-window helper for large lists.
- `scripts/perf-smoke.mjs` records a deterministic local budget for large-list filtering.
- Editor text and index records stay in services/CodeMirror/index stores rather than deep Vue state.
