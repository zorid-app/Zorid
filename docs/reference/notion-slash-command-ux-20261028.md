# Notion slash command reference — 2026-10-28

Scope: user requests the current Notion slash layout, interaction and motion for
Zorid’s supported editor commands. The reference was inspected in a tab-scoped
Chrome session on the agent-created disposable Notion page “Zorid interaction
re”. Sidebar closed before visual capture. No recovered proprietary code or SVG
paths were added to Zorid. Earlier REA evidence is retained with the database
interaction delivery; current slash measurements use live public DOM/computed CSS
and real keyboard experiments.

## Measured layout and motion

| Element | Observed current Notion value |
| --- | --- |
| Popup | 324px width, white background, 10px radius |
| Shadows | rgba(25,25,25,.05) 0 20px 24px; rgba(25,25,25,.027) 0 5px 8px; rgba(42,28,0,.07) 0 0 0 1px |
| Options | 32px high, horizontal margin4px, inner padding8px, radius6px |
| Icon | 20px slot, 16px glyph; label begins40px from popup left |
| Label | 14px, weight400, line-height16.8px |
| Group heading | 12px, weight500, muted |
| Shortcut | faint right-aligned Markdown mark |
| Footer | 42px; Close menu14px/16.8px normal; esc12px/16.8px faint, no border/padding |
| Hover selection | background transition20ms ease-in; selected color approx normal text at5.1% opacity |
| Position wrapper | computed opacity/transform transition1ms ease |

Popup computed animation was none. The browser inspection proxy does not expose
Element.getAnimations; subframe JavaScript animation curves remain unmeasured.
Do not infer exact motion parity from the computed CSS. A cropped reference
screenshot was emitted in the conversation. Final Zorid screenshots and native
receipts are in `tmp/bases-edit-performance-20261028`.

## Actual keyboard experiments

Typing `/` in an empty prose block opens the grouped menu and retains editor
focus. Typing `heading` produces Filtered results. ArrowDown advances the active
descendant without moving focus; Enter accepts the selected Heading2, removes
the query and leaves an empty heading. Typing `/` inside that empty heading opens
the menu again. Escape dismisses and retains the slash query. These experiments
used the actual editor root, not direct DOM mutation or private product handlers.

Zorid keeps19 supported commands: basic text, H1–H4, bulleted/numbered/task lists,
quote, existing table/callout/code/math/divider/link/image/footnote insertion,
and its existing inline/full-page Base creation. It omits Notion-only AI, toggles,
media upload and unsupported view creation. The command catalogue delegates to
existing guarded insertion planners and existing Base creation hooks.

## Guards and limits

Acceptance requires the exact document, selection, writable authoring lease,
current editor and non-composing state. Conversion removes the query and the
single top-level block marker in one undo transaction. Code/HTML/math/table
contexts stay literal. Nested containers and parent list/quote blocks with
following child/continuation content are rejected to preserve hierarchy.
Keyboard roving selection, Home/End, Enter/Escape/Tab dismissal, pointer hover,
outside dismissal, accessible labels, viewport placement and reduced-motion
behavior have focused coverage. Final native/package verification is recorded
separately; this document is reference evidence, not an exact-parity claim.
