# Embed controls by type: packaged-reference audit

This is a static audit of the supplied Obsidian 1.14.4 desktop artifact, prompted by the Live audio source button overlapping playback controls. It records observable construction and stylesheet rules, not a screenshot match or a universal embed design. No recovered implementation or assets are included here, and no reference code or native UI was executed. Zorid implementation and native verification must be tracked separately.

## Evidence and scope

The extraction receipt is `ev_ec268d4710d98bd994642c3a390b963e050880975c210f85226470c9360cd459`. The historical renderer analysis is E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`, with partial semantic coverage. An exact current-session REA lookup returned no retained E3 record; the old exported bundle is absent. We reused the extracted artifact and did not repeat its analysis. These findings are focused ordinary static reads, not a new REA trace.

Freshly checked identities:

- `app.js`: `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
- `app.css`: `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`.
- Containing ASAR, from the extraction manifest: `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`.

Every range below is a **zero-based Unicode character offset in decoded UTF-8 text**, not a byte offset. Minified class names identify this exact build only. Theme overrides, third-party plugins, platform controls and runtime focus/hit testing are not covered by these source observations. Reading mode does not automatically receive Live editor actions.

## Control matrix

| Live embed type | Editor-owned control | Placement and visibility | Source-edit path |
| --- | --- | --- | --- |
| Image | Desktop zoom plus source/code; resize corner | Toolbar top/end 8 px; hover, selection or resize; narrow-image exception | URL/alias selection and separate reveal preview |
| Audio | No overlay | Native full-width, 42 px player | Generic source-selection hook |
| Video | No overlay | Native controls; maximum width 100% | Generic source-selection hook |
| Provider iframe | No overlay | Nominal 600×350 px, constrained width | Generic hook; frame event behavior unverified |
| Raw HTML block | Source/code | Shared top/end 4 px, block-hover visibility | Select HTML source; replacement branch omitted while revealed |
| Note | Open link, not source/code | Top/end 4 px; normal icon opacity | Separate generic source-selection hook |
| PDF | Source/code plus separate viewer Open menu | Code action top 6/end 4 px, always visible; toolbar reserves space | Nonimage source-plus-widget branch |
| Bases file | Source/code plus Bases view controls | Header-centered top (default 8)/end 4 px, always visible | Nonimage source-plus-widget branch |
| Bases fence | Source/code plus rendered view controls | Direct code-widget/header rules | Rendered fence omitted while source is revealed |
| Canvas file | No dedicated button; clickable title/minimap | No Canvas-embed-specific CSS rule found | Generic hook also installed; click priority unknown |

## Shared mechanisms are conditional

At `app.js` **1949481–1951200**, the generic click hook registers widget ownership and source selection; it does not create a button. The separate edit-action helper creates a code icon and selects the owned source range. It focuses the editor, selects the full range on desktop and collapses to its start for mobile. The delayed click helper at **870659–871750** accounts for prevented events, selection and focus. Native media and cross-origin frame interaction must be tested independently; static registration does not establish which browser-control clicks reach it.

The generic action container uses absolute positioning at top/end **4 px**, a **2 px** gap, initial opacity zero and a **70 ms** opacity transition. Individual actions have **4 px vertical / 6 px horizontal** padding. This comes from `app.css` **130569–131310**, with size variables at **85969–86026**. Hover visibility for a `.cm-embed-block` is in **376547–377050**; the selector excludes table and Bases code widgets. These rules do not prove that every embed creates that container or has that wrapper class.

The local Live dispatcher at `app.js` **3029600–3031100** adds an explicit edit action only for its PDF and Bases classes. Images use their own action builder. Other local types use the generic click hook. Class definitions identify PDF at **2677016**, Bases at **2547872**, and audio/video at **2681753–2682600**.

The decoration overlap predicate at **3044850–3045200** uses the focused editor's selection ranges or search-highlight intersections; an unfocused editor supplies no selection ranges. References below to selected/revealed source describe these conditional construction branches. They establish a source-plus-render path where stated, not verified continuity of the same DOM node, player or document instance.

## Image

**Presence and action.** The image builder at `app.js` **3022600–3023550** creates an image wrapper and installs image selection. Clicking an unselected image selects it; clicking the selected image invokes the image display action. At **3027420–3028070**, desktop images with an actual image element get a zoom action, followed by a source/code action. The source action selects the image and reveals its URL segment; it is not the generic full-embed range selection. The code action is still added without the desktop-only zoom action. A desktop resize corner is created at **3025940–3027440**; its double-click resets dimensions and its drag writes a width back into the source. These are image-specific affordances.

The selected-image method at **1710824–1711054** first focuses the editor and moves a collapsed caret to the source start when a physical keyboard is available or the editor already has focus; it then records the selected image range. An unfocused touch editor without a physical keyboard skips that focus/caret step. This does not itself reveal source. Reconciliation at **1711267–1711610** preserves image selection for a single collapsed caret exactly at either range boundary, clears it for other selection changes, and maps its range through document changes. An outside-image mousedown clears image selection (**1714375–1714570**). These are static handler observations; physical-keyboard detection and actual focus sequencing still need platform verification.

**Geometry and visibility.** `app.css` **371023–375900** makes image embeds fit-content, with actions **8 px** from the top and logical end, at z-index 2. The toolbar has its own themed background, blur, shadow, radius and 2 px container padding (**366066–366385**, **66900–67470**). Desktop action padding falls back to the shared rule; mobile image actions use 8 px padding and the larger icon variable. Hover reveals the toolbar; resizing and image selection also reveal it. Images narrower than 80 px get a no-hover-actions class (`app.js` **3023040–3023200**), which hides and disables the toolbar until selection. The resize hit region is 30×30 px at bottom/end; its visible corner is a separate 10×10 px decoration, inset 6 px. The selection outline is distinct from the toolbar.

**Source and renderer coexistence.** `app.js` **1715171–1716350** selects the requested URL/alias substring and records reserved image height. The source-reveal state maps through document edits (**1709770–1710400**). The image replacement path at **3045550–3046800** and preview construction at **3050500–3053000** use an image reveal tooltip, with a separately built image and reserved-height handling. This is evidence for a dedicated preview while source is edited, not proof that the original image DOM node is retained in place. Its precise coordinates, focus transitions and visual continuity require runtime verification.

## Audio

**Presence and action.** The local audio class is a media embed, not a PDF/Bases/image subclass. Its inspected Live path creates no edit overlay, zoom button or resize corner. It receives the generic source-selection hook. `app.js` **851525–851867** creates a native audio element with controls and `controlsList="nodownload"`; browser transport buttons are not editor overlay buttons.

**Geometry and visibility.** The wrapper is directly a block-level internal media embed; the helper appends the audio element there. `app.css` **331675–332200** sets audio to **100% width, 42 px height**, caps rendered width, and styles the native controls enclosure using theme background, border and radius. The default radius expression is 8 minus 1 px; border width is theme-dependent. **370156–370310** makes nonimage internal embeds block-level and caps media at 100%; **376473–376580** sets normal whitespace. No ordinary audio wrapper padding/margin rule was found in the inspected audio/internal-embed selectors; popover and Canvas rules are separately scoped. A full-width player is supported by the source. A code overlay and generic 12 px top/bottom widget padding are not supported by this path.

**Source coexistence.** The common nonimage decoration path at `app.js` **3044850–3047350** uses a block replacement for an embed beginning its own line with only trailing whitespace. When its source is revealed it uses a point widget after the source line instead. The inline path likewise has a distinct revealed-source widget branch. This establishes a source-plus-renderer path statically; exact player identity and playback continuity across editing still need runtime verification. Blank lines and native inline baseline behavior cannot be reduced to an exact pixel gap from this CSS alone.

## Video

The local video class shares audio's generic source-selection route and has **no editor edit overlay** in the inspected path. The helper at `app.js` **851867–852400** creates native controls with metadata preload, temporarily hides height while loading, and restores it on settlement. Zero video dimensions can switch to the audio helper; this does not add an editor action. `app.css` **350444–350520** and **370156–370310** cap video at 100% width without imposing a common fixed player height. There is no ordinary-video hover toolbar rule in the audited route. Source coexistence follows the nonimage decoration path described for audio; native video full-screen/transport menus and pointer behavior are runtime unknowns.

## Web and iframe: distinguish three paths

**Recognized provider image syntax.** At `app.js` **1996500–1998420**, recognized YouTube and Twitter/X URLs can become provider iframes. Live construction at **3028164–3029338** uses the iframe plus the generic click hook and resize measurement, without adding image or edit actions. The frame is an external embed that receives events. `app.css` **370890–371023** gives external iframes a nominal **600×350 px** size with maximum width 100%; the Twitter message handler can adjust height, capped at 1000 px. Provider controls belong inside the frame, not an editor-owned toolbar. The common nonimage source-reveal path applies, but cross-origin event propagation and actual provider focus/navigation require runtime checks. No provider URL was fetched in this audit.

**Ordinary remote Markdown image destinations.** An arbitrary web URL is not promoted into a generic webview merely because it has image syntax. Without a recognized provider mapping, the Live external path builds an image and its image actions (**3028164–3029338**); the Reading postprocessor has the same provider-or-image distinction (**2028250–2029000**). A URL ending in `.mp4` alone does not establish a video embed.

**Raw HTML iframe.** The raw HTML widget at **3037900–3038500** is a separate route: block HTML receives a generic edit action and a `.cm-embed-block` wrapper; inline HTML does not receive that action. Its edit action uses full source selection and shared 4 px top/end geometry and block-hover visibility. The parser/decoration branch at **3048730–3049400** excludes selected/revealed HTML ranges from normal replacement, unlike the explicit retained point-widget branch for local media. Do not promise persistent iframe DOM while raw HTML source is edited. HTML parsing, safety filtering, author-supplied dimensions and remote availability remain separate constraints; this observation is not a proposal to enable arbitrary remote content in Zorid.

## Note

The note reviewer independently checked the same artifact hashes. The Live note renderer at `app.js` **2686240–2688300** creates an **Open link** action with a maximize-style icon. It opens the referenced note and subpath, honoring primary/middle-button modifier routing. It does not edit the enclosing Markdown source. An optional inline title is placed above the embedded content. `app.css` **367934–368650** places the action absolutely at top/end **4 px**, uses the small icon size and 4 px padding, and applies normal icon opacity; it is not a hidden-until-hover action. Hover changes color/background.

The local Live dispatcher at **3029573–3031850** assigns notes the generic source-selection click hook rather than the shared code/edit action. Therefore an Open link control and generic source reveal can coexist without a `</>` overlay. The Reading note class at **2039400–2041600** constructs title and preview content, with no dedicated open/source button in that inspected class. This is a bounded construction observation, not a claim that no containing host can add navigation. As a local nonimage file embed, note source reveal uses the common decoration branch described for audio. Nested interactive content, actual opening destinations and native hit testing remain runtime checks.

## PDF

The PDF reviewer independently checked the same file hashes and the following anchors. The Live local dispatcher explicitly calls the generic edit-action helper for PDF (**3029880–3030580**). This is a source/code action, separate from the PDF viewer's own controls. `app.css` **366806–367295** makes PDF actions **always visible**, at top **6 px**, logical end **4 px** inherited from the shared rule, z-index 1, with a primary background. The neighboring toolbar reserves **36 px** at its end. Hover changes action color/background rather than being required to reveal it.

The shared PDF embed separately creates a toolbar-right vertical-more control with an Open tooltip (`app.js` **2677288–2678060**). It invokes the source link's context menu, anchored below the control. That viewer control can exist in Reading too; it is not the Live source/code action. The file-embed decoration branch at **3045350–3046300** places the rendered nonimage widget after revealed source instead of replacing it. The edit action does not explicitly destroy the viewer. Native toolbar hitboxes, focus timing, nested/list geometry and theme overrides remain unverified.

## Bases

**Embedded `.base` file.** The Live local dispatcher adds the generic source/code action for the Bases embed class, alongside its own interactive view controls. `app.css` **445335–445952** gives direct `.cm-content` Bases embeds and Bases code widgets a header-end reserve of icon size plus 16 px (default **32 px**). Their actions are **always visible**. Top is computed from header height, icon height and 4 px padding: default desktop header 40 px and icon 16 px yield **8 px**. Logical end remains **4 px**. These selectors have a direct-child scope; do not assume identical nested placement. The `.base` file renderer at `app.js` **2547840–2549970** does not independently add a Reading-mode source-edit button. The controller's view/results/sort/group/filter/property, phone display, search and new-item controls at **2534780–2535400** are separate from the source action.

**Fenced `base` block.** This is a different construction path. The code widget and source action are created at **3031400–3032990**; the Bases postprocessor registers its interactive renderer and source replacement at **3231080–3231650**. The decoration path at **3049380–3050450** omits the rendered code fence when selection/search intersects its source. Therefore the file-embed source-plus-preview behavior must not be generalized to a fenced Bases block. Actual editing transitions and mobile placement remain runtime unknowns.

## Canvas file embedded in a note

At `app.js` **3428550–3429900**, the Canvas embed adds its own class and, for inline display, a title with a dashboard-style icon and file basename. It constructs **no dedicated edit or open button**. Its container click invokes link opening with modifier-aware leaf selection. The renderer at **3427616–3428530** produces a static SVG minimap of rectangles and edges from the Canvas document; it is not the full interactive Canvas card editor. No Canvas-embed-specific selector was found in the checked `app.css`.

The Live dispatcher also gives this type the generic source-selection hook. The nonimage source-plus-widget path at **3045544–3046600** applies to note and Canvas file embeds. The interaction priority between the Canvas container's open-link handler and the generic deferred source-selection hook is **unknown without runtime observation**. Do not infer either that every click edits source or that every click opens the Canvas.

**A note card inside Canvas is a separate surface.** `app.js` **3380500–3383100** loads a note renderer for an editable/iframe-capable card; `app.css` **553318–554743** hides its direct note Open link button. The outer card label has its own visibility setting and opening behavior (**3380500–3383100**, **3383392–3383670**). Its CSS at **547625–548850** places it above the card with negative top/translation and zoom scaling; hover-label mode reveals it on hover or touch focus, and zoomed-out mode hides it. This is not a note-embed toolbar or a universal top-right edit button.

## Remaining verification

The static distinctions above support type-specific original implementations. They do not certify native pixel parity, dark/light theme equivalence, touch behavior, iframe event forwarding, browser control menus, or playback continuity. Root owns native checks using original test content. Keep controls used to edit source distinct from native/player actions and from Reading-mode navigation affordances. Do not generalize an image toolbar, generic code action or audio spacing fix to all embed types.

## Proposed implementation scopes

These are bounded next changes derived from the audit, not completed parity claims or new public plugin APIs:

1. **Image controls:** own the desktop zoom/source toolbar, selection and narrow-image visibility, resize affordance, and source-segment editing together. Test multiple images, mapped source ranges, menus and renderer lifetime; verify reveal-preview geometry natively.
2. **Note navigation:** replace the generic visible source/code overlay with the note-specific Open link control while preserving a distinct source-selection path. Verify nested interactive content and modifier destinations.
3. **PDF and Bases controls:** separate source/code actions from the viewer/controller menus, reserve their actual toolbar/header space, and preserve always-visible rules. Treat `.base` file embeds and fenced Bases source editing as different lifecycles.
4. **Audio and video:** suppress editor overlays on their own local media wrappers, preserve native controls and generic source selection, and audit spacing per type. The audio-only fix is tracked separately; it does not establish video parity.
5. **Canvas file embeds:** use a title/minimap navigation surface without inventing an edit toolbar. Resolve click/open/source-selection priority in the reference runtime before changing those event semantics. Keep Canvas-card editing and card labels separate.
6. **Web embeds:** distinguish provider frames, ordinary remote images and raw HTML blocks. No new remote-content capability is implied by this audit; any implementation must first agree on the supported route and source-edit lifetime.

The PDF/Bases reviewer supplied its entries. The note/Canvas reviewer checked the integrated shared/note/Canvas claims; corrected minimap/label anchors and the focused-selection predicate were incorporated. No production files changed in this documentation lane.
