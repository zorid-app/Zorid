# Reusable UI component inventory

This inventory is the deterministic source of truth for the first reusable Vue component pass. The pass intentionally keeps plugin extensibility unchanged: plugins still mount DOM views through the existing platform/plugin APIs and do **not** receive a UI component API in this iteration.

## Shared package: `@zorid/ui-vue`

Shared components live under `packages/ui-vue/src/components/` and are exported from `packages/ui-vue/src/index.ts`. App renderers import these wrappers, not `reka-ui` directly. Style order is explicit: consumers import `@zorid/ui-vue/tokens.css`, then `@zorid/ui-vue/components.css`, then app-specific CSS.

| Component | Implementation | Intended use | Reka usage |
| --- | --- | --- | --- |
| `ZDialogWindow` | Vue SFC wrapper around Reka Dialog | In-app floating dialog/window with modal focus behavior, Esc close, outside/backdrop close, and dimmed backdrop | Yes: `DialogRoot`, `DialogPortal`, `DialogOverlay`, `DialogContent`, `DialogTitle`, `DialogDescription` |
| `ZModalWindow` | Vue SFC wrapper over `ZDialogWindow` | Explicit modal alias for app windows that should always be modal | Indirect |
| `ZDialogBackdrop` | Vue SFC wrapper around Reka `DialogOverlay` | Shared dialog overlay/backdrop with dimming | Yes |
| `ZConfirmDialog` | Vue SFC wrapper around Reka Alert Dialog | Destructive/confirmation flows with cancel/confirm events | Yes: `AlertDialog*` primitives |
| `ZPromptDialog` | Vue SFC composition over `ZDialogWindow` + `ZTextField` | Prompt dialogs that collect a string and close on submit/cancel | Indirect |
| `ZWindowFrame` | Plain Vue/CSS | Reusable floating window chrome/header/body | No |
| `ZButton` | Plain Vue/CSS | Shared button variants | No |
| `ZIconButton` | Plain Vue/CSS | Borderless icon-only toolbar/action buttons with required labels | No |
| `ZTextField` | Plain Vue/CSS | Labelled text/search/number/etc. input | No |
| `ZCheckboxField` | Plain Vue/CSS | Labelled checkbox input | No |
| `ZPanel` | Plain Vue/CSS | Sidebar/card panels | No |
| `ZBadge` | Plain Vue/CSS | Small inline status/count badges | No |
| `ZTag` | Plain Vue/CSS | Clickable tag pills with optional count | No |
| `ZStatusBar` | Plain Vue/CSS | App status footer shell | No |
| `ZResizeHandle` | Plain Vue/CSS | Accessible vertical resize separator | No |
| `ZVisuallyHidden` | Plain Vue/CSS | Accessible hidden text utility used by dialog semantics | No |

## Desktop app-specific components

Desktop app components live under `apps/desktop/src/renderer/src/components/`. They keep desktop-specific classes and state wiring while composing shared primitives where behavior or chrome is reusable.

| Component | Uses shared primitives | Migrated responsibility |
| --- | --- | --- |
| `CommandPaletteWindow` | `ZDialogWindow` | Command palette floating window; closes on Esc/outside via shared dialog behavior |
| `SettingsWindow` | `ZDialogWindow`, `ZButton` | Settings floating window and editable app/plugin settings |
| `TopTabStrip` | None yet | Titlebar traffic-light spacing, tab strip, status context |
| `ActivityRail` | None yet | Rail buttons and command/settings launch actions |
| `FileTree` | None yet | Root/nested file tree rendering and open-entry eventing |
| `RightSidebarPanels` | `ZPanel`, `ZTag` | Search, outline, backlinks, tags, fields, types, bases/data views, embeds, status, plugin and settings panels |
| `AppResizeHandle` | `ZResizeHandle` | Left/right pane resize handles preserving desktop grid classes |
| `AppStatusBar` | `ZStatusBar` | Footer status summary preserving desktop status-bar classes |
| `MarkdownEditor` | None | Existing editor wrapper; unchanged by this pass |

## Boundary rules

- `reka-ui` imports are allowed only in `packages/ui-vue/src/`.
- Desktop renderer code imports `@zorid/ui-vue` wrappers only.
- No platform/plugin UI component API is added in this pass.
- Existing visual classes remain on app-specific components to avoid a visual redesign while centralizing behavior. If shared and app classes overlap, app classes own desktop layout and shared classes provide baseline reusable behavior only.
- `@zorid/ui-vue` is source-aliased for local workspace development and also copies SFC/CSS assets into `dist` during its package build so declared exports remain consumable.
