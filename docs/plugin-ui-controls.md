# Plugin settings control foundation

`src/plugins/ui-components.ts` supplies original implementations of `BaseComponent`, `ValueComponent`, `AbstractTextComponent`, `TextComponent`, `TextAreaComponent`, `ToggleComponent`, `ButtonComponent`, `DropdownComponent`, and `Setting`. These are DOM controls, separate from the plugin `Component` load/unload hierarchy. The module has no global DOM requirements at import time and creates descendants through the supplied container's `ownerDocument`. It does not modify native prototypes or introduce an App facade.

## Evidence

This is a bounded static compatibility implementation, not reference runtime or visual parity. The artifact identity and prior E3 analysis are documented in [plugin-api-reference.md](plugin-api-reference.md). E3 is `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`; its current REA session lookup returned no retained records, so no analysis producer was rerun. This pass used the supplied retained source at `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js`, with SHA-256 rechecked as `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`. No recovered implementation or assets are included in the project.

Source positions below are zero-based Unicode character offsets in Python's decoded text, not byte offsets. These are ordinary bounded readings of the identified artifact, not new REA graph conclusions.

| Contract | Source anchor | Observed behavior used |
| --- | --- | --- |
| Export identity | 248450–251798 | The named classes are exports in the shared `obsidian` namespace. |
| Setting row | 1263267–1267178 | Name/description accept text or fragments. Controls are stored before configuration callbacks run. Disable visits current controls; later controls start enabled. Clear removes controls, component references, and validation error state, preserving metadata. |
| Base/value controls | 1270025–1270429 | Fluent `then` invokes immediately. Option listener writes only when the argument is not undefined, then returns the current value. |
| Button | 1270429–1271896 | Latest click callback replaces prior callbacks. Disabled blocks invocation. Callback is awaited with a loading class removed in `finally`. CTA/destructive styles compose. |
| Toggle | 1273124–1274199 | Programmatic changes invoke the latest callback only when the value changes. Disabled blocks activation, including Space/Enter activation; it does not block programmatic changes. |
| Text | 1274199–1275090; 1275932–1276031 | Input events notify the latest callback. Programmatic string setters are silent; `onChanged` explicitly notifies. Textarea shares the same base implementation. |
| Dropdown | 1277075–1278504 | Native select/options and change callbacks; setters are silent. Options map uses own properties. |
| Tooltips | 1212600–1212980 | Tooltip text is the element's accessible label; placement, class, delay, and gap options are stored as data attributes. |

Public types were cross-checked against the [official Obsidian API declarations](https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts), retrieved 2026-10-16. This upstream branch is mutable; the pinned artifact governs behavioral claims.

## Supported boundary

The controls support fluent configuration, callback replacement, values, native disabled state, tooltip metadata, and standard setting row composition. Rows also support error messages, visibility, heading/class styles, custom control registration, and clear/rebuild. The base classes retain shared inheritance identity for namespace consumers.

Deliberate original additions are native title tooltips, a button type that does not submit enclosing forms, and synchronized checkbox/ARIA state for accessible toggles. Toggle disabled state also disables its underlying native checkbox. Callback exceptions are not swallowed. As in the observed button callback, an asynchronous rejection is propagated after loading cleanup.

This module does **not** supply a settings host, a plugin settings tab, CSS parity, a custom tooltip renderer, a complete icon registry, button/row `setIcon`, text `autoSelect`, dropdown fitted-width measurement, row navigation/actions, or other control families. Mobile keyboard and vibration behavior have not been implemented. Setting clear detaches controls; it does not cancel pending user callbacks or erase listeners on detached elements held by a plugin. Consumers must not advertise full UI API compatibility from these exports.

## Verification

`node --test --test-concurrency=1 tests/plugin-ui-components.test.ts` passes seven focused tests: cross-document construction without prototype helpers; text/option callback contracts; toggle transition and keyboard behavior; dropdown option ownership and selection; asynchronous button loading; row metadata/fragments/tooltips; and disable/clear/rebuild lifecycle.

The implementation also passes a focused strict TypeScript check. These checks establish DOM contract behavior in JSDOM. Host integration, installed plugin fixtures, native Electron display, mobile behavior, and reference visual equivalence remain unverified.
