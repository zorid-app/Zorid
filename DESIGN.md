# Design

## Source of truth
- Status: Draft
- Last refreshed: 2026-05-27
- Primary product surfaces: Electron desktop shell, future Capacitor mobile shell, shared Vue design system, Markdown editor, file explorer, metadata panels, command palette, settings, plugin surfaces.
- Evidence reviewed:
  - `docs/product/overview.md` — local-first cross-platform Markdown workspace with structured data and Obsidian-like extensibility.
  - `docs/product/frontend.md` — Vue 3 + TypeScript, Vite, Electron desktop-first, CodeMirror 6, shared `packages/ui-vue` design system, `desktop-shell` / `mobile-shell` split.
  - `docs/product/zorid.md` — open-source modern Markdown editor, complex data usage, plugin extensibility, high performance.
  - `docs/assets/desktop-layout-reference-obsidian.png` — v0 desktop layout reference.
  - `apps/desktop/src/renderer/src/App.vue` and `apps/desktop/src/renderer/src/styles.css` — current shell, hard-coded colors/spacing/components, emoji/text placeholder icons.
  - `packages/ui-vue/src/index.ts` — currently utility-only; design-system package exists but has not yet become the UI component/token source of truth.

## Brand
- Personality: fast, technical, trustworthy, local-first, extensible, keyboard-friendly.
- Trust signals: stable structure, restrained visual treatment, clear status/diagnostics, predictable controls, accessible keyboard behavior.
- Avoid: decorative inconsistency, one-off gradients/colors, emoji-as-icons in production UI, plugin-specific visual chaos, copying Obsidian styling exactly.

## Product goals
- Goals:
  - Make Zorid feel like a coherent workspace rather than a collection of prototype panels.
  - Give all desktop/mobile/plugin UI the same tokens, components, icon rules, focus states, and density rules.
  - Keep the system small enough for fast iteration and parallel development.
- Non-goals:
  - Full public component library or Storybook before v0 UI stabilizes.
  - Pixel-perfect clone of Obsidian.
  - Large third-party UI framework adoption before core shell patterns are proven.
- Success signals:
  - New app surfaces can be built using exported `@zorid/ui-vue` tokens/components without new hard-coded colors.
  - Icon usage is semantic and consistent across activity rail, toolbar, tabs, metadata panels, settings, command palette, and status.
  - Desktop can be visually refactored without touching platform APIs or plugin contracts.

## Personas and jobs
- Primary personas:
  - Power note-taker / knowledge worker managing Markdown vaults.
  - Developer-minded user who values extensibility, local files, and keyboard workflows.
  - Future plugin author extending core surfaces.
- User jobs:
  - Open a vault, navigate files, edit Markdown, search, inspect backlinks/outline/tags/fields, use views, run commands, configure settings.
- Key contexts of use:
  - Dense desktop workspace, long editing sessions, large vaults, offline-first usage, future touch/mobile adaptation.

## Information architecture
- Primary navigation:
  - Activity rail for global sections/actions.
  - Left sidebar for active section content.
  - Central workspace/editor as the primary task surface.
  - Optional right inspector panels for contextual metadata.
  - Bottom status bar for app/vault/index/plugin state.
- Core routes/screens:
  - Vault/files, editor/workspace, search, backlinks/outline/tags/fields/data views, command palette, settings, plugin status.
- Content hierarchy:
  - Current file/task first; metadata secondary; diagnostics visible but not dominant.

## Design principles
- Principle 1: Token-first. Components consume semantic tokens, not raw hex/radius/spacing values.
- Principle 2: Dense but legible. Zorid should support information-rich layouts without losing clear affordances.
- Principle 3: Shell-owned consistency. Core shell surfaces define the interaction pattern; plugins fit into provided slots.
- Principle 4: Keyboard and accessibility parity. Any clickable workflow should have focus states and command-palette/hotkey path when applicable.
- Tradeoffs:
  - Prefer a small custom Vue component layer over a large UI framework until v0 interaction patterns settle.
  - Prefer outline icons for consistency; use filled/solid icons only for selected/favorited/active state if a second style is deliberately added later.

## Visual language
- Color:
  - Use semantic CSS custom properties: `--z-color-bg`, `--z-color-surface`, `--z-color-panel`, `--z-color-border`, `--z-color-text`, `--z-color-muted`, `--z-color-accent`, `--z-color-danger`, `--z-color-warning`, `--z-color-success`.
  - Start with the existing dark palette, but move it into tokens in `packages/ui-vue`.
  - Plan light theme by naming tokens semantically now.
- Typography:
  - UI font: system sans stack already used in `styles.css`.
  - Editor font: monospace stack owned by editor component tokens.
  - Use a type scale for caption/label/body/title rather than ad-hoc sizes.
- Spacing/layout rhythm:
  - Base unit: 4px; common tokens: 2, 4, 6, 8, 12, 16, 20, 24, 32.
  - Compact density default for desktop shell; future comfortable density can be a token mode.
- Shape/radius/elevation:
  - Radius tokens: small 6, medium 8, large 12, modal 16, pill 999.
  - Elevation only for overlays/modals/popovers; panels should mostly use borders/surface contrast.
- Motion:
  - Minimal and fast; respect `prefers-reduced-motion`.
- Imagery/iconography:
  - Use Lucide as the default icon library via `lucide-vue-next`.
  - Default icon size 16px in dense controls, 18px in sidebars, 20px in activity rail, 24px only for empty states/large affordances.
  - Default stroke width 1.75 or 2; color should inherit `currentColor`.
  - Do not import all icons dynamically; export semantic Zorid icon aliases from `@zorid/ui-vue`.



## Color system plan
- Foundation: neutral/Notion-like grayscale surfaces for readability, with blue reserved for interaction, focus, and selected states.
- Ownership: `packages/ui-vue/src/tokens.css` owns all primitive, semantic, opacity, and component color tokens.
- Consumption: apps and shell CSS import `@zorid/ui-vue/tokens.css` once, then use `var(--z-*)` tokens instead of raw hex or ad-hoc `rgba(...)` values.
- Token levels:
  - Primitive palette: `--z-gray-*`, `--z-blue-*`, `--z-red-*`, `--z-amber-*`, `--z-green-*`.
  - Semantic app colors: `--z-color-bg`, `--z-color-surface`, `--z-color-panel`, `--z-color-text`, `--z-color-muted`, `--z-color-accent`, `--z-color-danger`, `--z-color-warning`, `--z-color-success`.
  - Component/state colors: `--z-control-bg`, `--z-control-border`, `--z-selected-bg`, `--z-hover-bg`, `--z-focus-ring`, `--z-color-overlay`.
- Opacity policy:
  - Use alpha color tokens for surfaces, borders, hover, overlays, and selected states.
  - Use whole-element opacity only for true whole-control states such as disabled/hidden: `--z-opacity-disabled`, `--z-opacity-hidden`.
  - Do not apply `opacity` to normal text/icons because it lowers contrast for children.
- Theme shape:
  - Default/root theme is dark.
  - `data-z-theme="dark"` and `data-z-theme="light"` both resolve the same semantic token names so future theme switching does not require component rewrites.
- Migration rule:
  - New UI may only introduce raw color values inside `tokens.css`.
  - Existing desktop CSS should be migrated from literal colors to semantic tokens before component extraction.
  - Component extraction should happen after token replacement so components inherit the final color language.

## Components
- Existing components to reuse:
  - `MarkdownEditor.vue` for the editor surface.
  - Current shell patterns in `App.vue` as extraction candidates, not permanent design-system components.
  - `packages/ui-vue` as the target owner for tokens/common components.
- New/changed components:
  - Tokens/theme CSS: `@zorid/ui-vue/tokens.css`.
  - Icon facade: `ZIcon` plus named semantic aliases such as `ZIconFile`, `ZIconFolder`, `ZIconSearch`, `ZIconSettings`, `ZIconCommand`, `ZIconTag`, `ZIconTable`.
  - Base controls: `ZButton`, `ZIconButton`, `ZInput`, `ZSelect`, `ZCheckbox`, `ZPanel`, `ZToolbar`, `ZTabs`, `ZModal`, `ZListItem`, `ZStatusBarItem`, `ZEmptyState`, `ZDiagnostic`.
  - Shell components later: activity rail item, sidebar section, command palette item, settings field.
- Variants and states:
  - Variants: default, subtle, primary, danger, ghost/icon-only.
  - States: hover, active, selected, focus-visible, disabled, loading, error, warning.
- Token/component ownership:
  - `packages/ui-vue`: tokens, icon facade, base Vue components.
  - `packages/desktop-shell`: desktop layout and shell composition.
  - `packages/mobile-shell`: mobile-specific navigation/sheets/gestures using the same tokens.
  - `apps/desktop`: app wiring only; avoid owning reusable UI primitives.

## Accessibility
- Target standard: WCAG 2.2 AA for core UI.
- Keyboard/focus behavior:
  - Every button/input/list item/modal path supports visible focus and Escape/Enter behavior where expected.
  - Command palette remains a first-class access path.
- Contrast/readability:
  - Token pairs must satisfy AA contrast for normal body text and critical UI labels.
- Screen-reader semantics:
  - Icon-only buttons must have labels.
  - Decorative icons use `aria-hidden="true"`.
  - Status/errors should use appropriate live regions where they change asynchronously.
- Reduced motion and sensory considerations:
  - Keep transitions optional and tokenized; disable non-essential animation under reduced motion.

## Responsive behavior
- Supported breakpoints/devices:
  - Desktop minimum currently 960x640 from `styles.css`.
  - Future mobile shell should use the same tokens but not the same layout.
- Layout adaptations:
  - Desktop: activity rail + sidebar + workspace + optional inspector.
  - Mobile: one main surface with navigation sheets and contextual inspectors.
- Touch/hover differences:
  - Do not make hover the only discoverability mechanism.
  - Touch targets on mobile should be at least 44px; desktop dense targets can be smaller with keyboard support.

## Interaction states
- Loading: skeleton or compact inline status for panels; avoid blocking editor unless necessary.
- Empty: explain the next action, e.g. open vault, select file, no backlinks, no tags.
- Error: inline diagnostic near the failing panel/action plus persistent status where relevant.
- Success: subtle confirmation for save/settings; avoid noisy toast spam during editing.
- Disabled: disabled controls must indicate prerequisite via title/label/help text when not obvious.
- Offline/slow network: v0 local-first; future sync state belongs in status bar and sync surfaces.

## Content voice
- Tone: concise, calm, technically precise.
- Terminology:
  - Use “vault”, “note”, “Markdown file”, “fields”, “types”, “views”, “plugins”, “index”.
  - Keep “command palette” spelling consistent.
- Microcopy rules:
  - Prefer action labels over vague labels.
  - Diagnostics should state what happened and the next available action.

## Implementation constraints
- Framework/styling system:
  - Vue 3 + TypeScript + Vite + Electron desktop-first.
  - Plain CSS custom properties are the initial token system; no Tailwind or heavy UI framework required for v0.
- Design-token constraints:
  - Export token CSS from `packages/ui-vue` and import once in app/shell entry.
  - Preserve semantic names so themes can change values without component rewrites.
- Icon library decision:
  - Choose `lucide-vue-next` for v0.
  - Rationale: official Vue package, TypeScript support, tree-shakable standalone components, broad icon count, clean outline style that matches dense productivity software.
  - Avoid importing all icons with `import * as icons`; define a semantic icon map/facade so the bundle only includes used icons.
  - Alternatives:
    - Heroicons: polished and Vue-supported, but smaller and more Tailwind-shaped; good fallback if Lucide feels too generic.
    - Phosphor: flexible weights, but the multi-weight system invites inconsistency unless strictly constrained.
    - Radix Icons: crisp small UI icons, but less ideal as the app-wide Vue-first library and smaller catalog.
- Performance constraints:
  - Tree-shake icons by direct named imports.
  - Keep design-system components thin and side-effect-light.
  - Virtualize large lists/tables as already planned.
- Compatibility constraints:
  - Plugin UI ABI should remain framework-agnostic; do not expose Vue component internals as plugin API.
- Test/screenshot expectations:
  - Component contracts should have unit tests for behavior/state classes where useful.
  - Desktop UI changes should be booted with `pnpm desktop:dev` and visually inspected.

## Initial setup plan
1. Add dependency: `pnpm --filter @zorid/ui-vue add lucide-vue-next`.
2. Convert `packages/ui-vue` from utility-only to a Vue-capable package:
   - include `src/**/*.vue` in `tsconfig.json`,
   - add `vue` as peer dependency/dev dependency as needed,
   - export token CSS and components from `src/index.ts`.
3. Create `packages/ui-vue/src/tokens.css` with semantic color/type/space/radius/focus tokens.
4. Create `packages/ui-vue/src/icons.ts` with direct Lucide imports and semantic aliases.
5. Create base components starting with `ZIcon`, `ZIconButton`, `ZButton`, `ZInput`, `ZPanel`, and `ZModal`.
6. Import token CSS in `apps/desktop/src/renderer/src/main.ts` or the desktop shell entry, then replace hard-coded styles in `styles.css` incrementally.
7. Replace emoji/text placeholders in the activity rail and file tree with semantic icons from `@zorid/ui-vue`.
8. Add a lightweight component/demo surface or screenshot fixture before expanding the component set.

## Open questions
- [ ] Confirm brand direction: darker developer/workspace feel vs warmer note-taking feel. Impact: color palette and typography tone.
- [ ] Confirm whether Zorid should support user-customizable themes in v0 or only token-ready architecture. Impact: token API and settings UI.
- [ ] Confirm if public plugin UI should eventually consume CSS tokens only or also optional web-component primitives. Impact: plugin ABI.
- [ ] Confirm whether to add Storybook/Histoire later. Impact: design-system documentation workflow.
