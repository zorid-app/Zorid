# Default theme and desktop layout reference

Snapshot: 2026-10-16. This is a **bounded static audit**, not a fresh-install observation, computed-style capture, or visual-parity result. The supplied Obsidian screenshot is a static visual reference; its vault settings, OS appearance, zoom, plugins, theme, and installation history are unknown. No reference application was launched, attached to, or operated for this audit.

## Evidence and reproduction boundary

The extracted desktop payload root is `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4`. These identities were rehashed directly:

| Symbol | Artifact | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| C | `app.css` | 668,223 | `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba` |
| J | `app.js` | 3,942,126 | `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9` |
| Z | Project `src/ui/styles.css`, read-only comparison snapshot | — | `4bbd78bc0f0b9e39ce7f1630e9c2f5c38f8a49498e37df25eecd8906a42fddcb` |

`C@123` and `J@123` below mean **zero-based UTF-8 byte offsets**, not JavaScript UTF-16 indexes or line numbers. A range describes the bounded neighborhood inspected. Paths and provenance are also recorded in [source-audit.md](history/source-audit.md) and [reference-evidence.md](reference-evidence.md). The retained renderer REA record is `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`; it previously parsed one renderer bundle and retained partial semantic coverage. This document adds direct, bounded declaration/branch inspection against those exact bytes; it does **not** claim a new REA semantic run or complete CSS cascade analysis. Packaged CSS, font files, icons, and recovered implementation have not been copied into project source.

## Config defaults and system appearance

The default configuration object is at `J@1414640–1416280`. `getConfig` at `J@1422309` consults the stored config first and falls back to this object only for an undefined field. These are static fallback values, not proof of the state of any installed vault.

| Field | Shipped fallback | Location |
| --- | --- | --- |
| `theme` | `system` | J@1416099 |
| `accentColor`, `cssTheme` | Empty strings | J@1416114–1416141 |
| `enabledCssSnippets` | Empty array | J@1416141 |
| `translucency` | false | J@1416163 |
| `textFontFamily`, `interfaceFontFamily`, `monospaceFontFamily` | Empty strings | J@1416179–1416242 |
| `readableLineLength` | true | J@1414692 |
| `propertiesInDocument` | `visible` | J@1414734 |
| `showInlineTitle`, `showViewHeader`, `showRibbon` | true | J@1414765–1414816 |
| `showLineNumber` | false | J@1415031 |
| `showIndentGuide`, `foldHeading`, `foldIndent` | true | J@1415002–1415067 |
| `useTab`, `tabSize` | true, 4 | J@1415068–1415087 |
| `livePreview`, `defaultViewMode` | true, `source` | J@1415133, J@1415298 |

The appearance dropdown IDs are `obsidian` for dark, `moonstone` for light, and `system` for OS-following mode (`J@3812038`). The desktop update branch at `J@3928350` maps these to body classes `theme-dark`/`theme-light`. System mode consults `matchMedia('(prefers-color-scheme: dark)')`; desktop platforms other than macOS and Windows replace that result with Electron `nativeTheme.shouldUseDarkColors`. Media-query changes and the native theme `updated` event are registered around `J@3905840–3906200`. System mode is therefore a selection mechanism, not a third palette.

The font-size fallback constant is 16 (`J@3889244`). `getBaseFontSize` at `J@3938378` reads `base-font-size` from local storage, migrates a configured `baseFontSize` when appropriate, falls back to the constant, and clamps to 10–30. At `J@3930500–3930890`, updating font size writes the body text-size variable and the root font size using `--preferred-text-scale`. A 16px declaration alone does not establish effective font metrics or browser zoom.

Desktop dock constructor `KO` starts with `size=300` and `collapsed=false` and writes that width to its container (`J@1550920–1551840`). The no-layout path creates an expanded left desktop dock and explicitly collapses the new right dock (`J@2915244–2917000`). Existing serialized layouts override this path. Missing/unreadable workspace data falls back to an empty object (`J@2912437`). Plugin initialization can populate the docks later; exact fresh-vault contents and final bounds remain unobserved.

## Palette facts

Common semantic variable mappings are at `C@95784–97500`. Light declarations begin at `C@97680`; dark declarations begin at `C@99865`. Values below resolve direct variable references only, assuming desktop classes, no user overrides, and no later matching override.

| Role | Light | Dark | Declaration locations |
| --- | --- | --- | --- |
| Primary canvas | `#ffffff` | `#1c1c1c` | C@98005, C@100189 |
| Primary alternate | `#fafafa` | `#232323` | C@98061, C@100245 |
| Secondary panel/ribbon | `#f6f6f6` | `#282828` | C@98089, C@100273 |
| Standard border | `#e4e4e4` | `#333333` | C@98145, C@100329 |
| Hover border | `#dadada` | `#3f3f3f` | C@98173, C@100357 |
| Focus border | `#bdbdbd` | `#555555` | C@98201, C@100385 |
| Normal text | `#222222` | `#dadada` | C@98313, C@100497 |
| Muted text | `#5c5c5c` | `#b3b3b3` | C@98285, C@100469 |
| Faint text | `#ababab` | `#666666` | C@98229, C@100413 |
| Form-field background | Primary canvas | `#2e2e2e` | C@96642–96790, C@101480–101543 |

Base accent H/S/L is 258 / 88% / 66% (`C@95707–95765`). Light text accent uses the base accent, while light interactive accent uses the first derived accent. Dark interactive accent uses the base accent, while dark text accent uses the first derived accent (`C@97183–97470`, `C@101686–101820`). The first derived light accent adjusts H/S/L by −1 / ×1.01 / ×1.075; the dark counterpart uses −3 / ×1.02 / ×1.15 (`C@98416`, `C@100600`). Preserve the role distinction rather than assigning one purple to all states.

Generic hover background mixes 6.7% of `--mono-100` with transparent in OKLCH; `--mono-100` is black in light mode and white in dark mode. Text selection mixes the interactive accent at 20% in the common declaration and 33% in dark mode (`C@95880–97183`, `C@101900–102100`). These are declarations, not measured composited RGB pixels. Mobile dark has its own overrides (`C@581601`: primary `#000`, alternate `#111`, secondary `#1e1e1e`); those values must not be mistaken for desktop defaults.

## Typography and document spacing

| Feature | Shipped declaration | Evidence |
| --- | --- | --- |
| Default text size | 16px; preferred size references text size | C@106856–106930 |
| Normal / tight line height | 1.5 / 1.3 | C@74691–74748 |
| UI sizes | 12 / 13 / 15 / 20px for smaller / small / medium / large | C@68501–68608 |
| Smaller text | 0.875em | C@68327 |
| Readable width | 700px | C@67711; editor C@118300–118700; preview C@150200–150378 |
| Main document margins | 32px on each axis | C@67770–67907; unit C@86146 |
| Sidebar document margins | 20px | C@224725–225061 |
| Paragraph spacing | 1rem; empty paragraph spacing 0rem | C@82022–82069 |
| List spacing | 0.075em | C@75613 |
| List indentation | 4 × 0.5625em = 2.25em; editing extra indent 0.75em | C@72937–72983, C@75489–75613 |
| Inline title | H1 typography; bottom margin 0.5em; letter spacing −0.015em | C@73451–73790, C@148555–149010 |

Main editor scroller and preview view apply the file-margin variable (`C@132139`, `C@149689`). Their readable content is separately centered within the scroller. Padding and content max width should be represented separately; a horizontal padding formula alone does not reproduce gutter, scrollbar, folding, or narrow-view behavior.

Heading scales H1–H6 are 1.618, 1.462, 1.318, 1.188, 1.076, 1em (`C@70737–70865`). Line heights are 1.2, 1.2, 1.3, 1.4, normal, normal (`C@70543–70737`). H1 weight is 700. H2–H6 fallback to 600; the `font-variation-settings` support branch uses 680, 660, 640, 620, 600 (`C@56297–56638`). H1/inline title is therefore arithmetically 25.888px with a 16px inherited text size, with 31.0656px line height, before zoom and actual font metrics. This is a derived value, not a measurement.

At `C@105800–106856`, the default sans stack begins with `ui-sans-serif`, Apple/Blink system selectors and `system-ui`, followed by platform/fallback families including Segoe UI, Google Sans Flex, Roboto, Inter, and emoji fonts. The monospace stack begins with `ui-monospace`, SFMono-Regular, Cascadia Mono, Roboto Mono, DejaVu Sans Mono and Liberation Mono, with further platform fallbacks. Interface, text, and monospace each have independent override/theme slots; the text font does not simply alias the interface font. Placeholder slots use a deliberately empty glyph-range family. Exact selected fonts, supported variable weights, glyph advances, fallback behavior, and loaded font assets remain unknown without runtime evidence.

## Workspace chrome, properties, tasks and tables

| Surface | Static layout facts | Evidence |
| --- | --- | --- |
| Ribbon | Width 44px; padding 8px 4px 12px; outer gap 4px; action/settings groups gap 6px | C@83747–83840, C@151620, C@257569–257720 |
| Ribbon icon | Medium icon 16px, stroke 2px; generic clickable padding 4px 6px, height auto | C@72380, C@72496, C@257972, C@258650–259080 |
| View header | Height 40px; horizontal padding 12px; gap 8px; title uses 13px/400 and start alignment | C@67907–68270, C@145557, C@146500 |
| Tab strip | Height 40px; side padding 8px; 1px bottom outline; inner top margin 5px with further inner padding | C@89821–90098, C@212688–213895 |
| Root tabs | Preferred width 200px, max 320px, min-width 0, flex `1 1 0`; active corner radii 10px 10px 0 0 | C@90195–90280, C@227840–228150 |
| Tab contents | 13px type, inner gap 2px, root inner start/end padding 6px/3px | C@89691, C@219180–220100 |
| Title bar | Base variable 30px; hidden-frameless rule uses header height minus 1px (39px); fullscreen hides it | C@138501, C@139652–140438 |
| macOS frame space | Left space calculated as 80px minus left ribbon contribution; RTL/fullscreen have separate branches | C@138700–139410 |
| Navigation rows | 13px type; padding 4px 8px 4px 24px; 2px bottom margin; 8px radius; children inset/margin 4px/12px | C@75998–76827 |
| Status bar | Fixed at bottom and inline-end, auto width, 18px minimum height, 4px padding/gap, 12px text; items add 3px vertical / 4px horizontal padding | C@87840–88190, C@196065–196947 |
| Property container | 8px vertical padding, no default border, bottom margin 2rem, desktop note translation −4px in LTR | C@78620–79000, C@379465–380116 |
| Property rows | Flex layout, 3px vertical gap, no row padding, 6px radius; key width/min-width 9em | C@79120–79294, C@80262, C@380601, C@383186, C@384962 |
| Property inputs | Preferred text size ×1.75 height (28px at 16px); label/value fonts 0.875em; input padding 4px 8px; value flexes | C@80016–80776, C@385584, C@386680 |
| Task checkbox | Preferred text size square (16px at default); 4px radius; checked text muted and struck through | C@63996–64478, C@433935–434600 |
| Reading task placement | Checkbox relative top 0.2em, end margin 0.6em, list start margin −1.5 × checkbox size | C@434027–434360 |
| Editing task placement | Top −0.1em, middle alignment, start/end margins 0.85em/0.25em; ordered-list start margin 2px | C@435469–435810 |
| Table text | Preferred text size; line height 1.3; header inherits size, uses bold modifier, normal text color | C@91596–91922, C@422400–423264 |
| Table cells | 4px vertical / 8px horizontal padding; 1px border; minimum 6ch; top alignment; `break-spaces` | C@91222–91382, C@91922, C@92692, C@422559–424150 |
| Live table cells | Outer cell padding 0, wrapper padding 4px 8px; table scroller line height uses table variable | C@121302, C@123880, C@128600–128800 |
| Table fill | Transparent by default for table/header/alternating rows; border uses standard border role | C@91222–92347 |
| Scrollbars | Width/height 12px; border widths 3px 3px 3px 2px | C@83859–83959 |

Tab height is governed by its strip and nested margins/padding; this audit does not assert a universal standalone 35px tab height. File/empty tab icons are conditionally hidden in the root strip (`C@213900–214340`). Controls and titlebar also have platform, focus, popout, fullscreen, mobile and hover branches, so a single screenshot is insufficient to choose all variants.

## High-priority differences in the comparison snapshot

This table compares shipped declarations with the **Z hash above**, not necessarily the latest working tree after parallel implementation. It is an implementation backlog, not a runtime defect count. Source references point to [styles.css](../src/ui/styles.css).

| Priority | Clone declaration | Shipped target and consequence |
| --- | --- | --- |
| High | Dark primary/secondary `#1e1e1e` / `#262626`; border `#363636`; muted/faint `#a6a6a6` / `#777` | Palette above differs across virtually every panel and text hierarchy. Light border/muted/faint also differ. |
| High | Text line height 1.6; H1 1.8em; all headings weight 650 and line height 1.35 | Target normal height 1.5 and per-level heading metrics change wrapping, document length, and alignment. |
| High | Title 30px, 1.3 line height, 19px bottom margin | Target title follows H1 scale/height and 0.5em margin; title footprint is materially smaller at base 16px. |
| High | Note top margin 20px; non-readable horizontal padding 30px; readable minimum 24px | Target main file margins are 32px and readable sizer is a separate max-width layer. |
| High | Sidebar CSS widths 240px left / 260px right | Static new desktop dock constructor starts at 300px each; right is collapsed in missing-layout path. Runtime/restored widths require separate state handling. |
| High | Workspace reserves full-width 24px status-bar grid row | Target status bar is fixed, bottom-end and auto width. This changes the usable content/sidebar height and bottom corner geometry. |
| High | Property editor grid has separate key/type/value/remove columns; 14px container, 4px row padding, 22px bottom margin | Target rows are key/value flex regions with icon/key area, 9em key width, 28px minimum value/input height and 2rem bottom margin. Control structure needs review alongside CSS. |
| High | Tables use 0.9em, 7px 12px padding, shaded headers, 60px live minimum width | Target tables use preferred text size, 4px 8px padding, transparent fill, 6ch minimum and 1.3 line height. |
| Medium | View header minimum 43px, 5px 13px padding, centered breadcrumbs | Target 40px, 0 12px padding, start-aligned title container. |
| Medium | Tab min-width 70px, fixed 35px height, 8px active radius, 7px inner gap; icons always styled | Target flexible root tab min-width 0, max-width 320px, 10px active radius, 2px inner gap and conditional icon visibility. |
| Medium | Ribbon buttons fixed 32×30px; ribbon top padding 44px; group gap 5px | Target uses distinct header reservation plus ribbon padding and auto-height icon buttons. Matching one total top offset does not establish the hierarchy. |
| Medium | Text font aliases interface; shortened system/mono fallback lists; root font size 14px | Target keeps independent text/interface override paths; root size is set from base text size, affecting rem-based spacing. |
| Medium | Tasks rely on native checkbox sizing and an 8px end margin | Target declares size and separate editing/reading placement; platform-native rendering is not evidence of equivalence. |
| Medium | Navigation row radius 4px, uniform 4px 8px padding and minimum 28px; scrollbars 10px | Target navigation uses its own indent/margin/radius variables; scrollbars are 12px. |

## Bounded implementation: base defaults

[reference-defaults.css](../src/ui/reference-defaults.css) is an independently authored override layer for the clone's existing DOM. Integration must import it **after** `styles.css`; this workstream does not change the entry point. Its palette declarations implement the desktop values above and preserve distinct light/dark text and interactive accents. The derived HSL components are arithmetic from the cited formulas. UI text uses 15px and tight line height, as additionally observed in the shipped body rule at `C@108623`; root rem sizing follows the existing user-controlled `--font-text-size` variable. Interface and document fonts have independent variable values, but custom font configuration and font loading are not implemented here.

Document and editor typography use the cited heading scales, weights, line heights and letter spacing. CodeMirror's existing measured heading padding is retained. Desktop documents use 32px scroller padding and separately centered direct content blocks capped at 700px. Inline titles track the configured text size. Desktop headers use 40px height and start-aligned breadcrumbs; dock CSS fallback widths become 300px above 800px. The existing compact 701–800px dock fallback remains an intentional responsive accommodation, not a reference-derived default. Inline user resize widths retain precedence.

The desktop status bar moves out of the grid into a fixed bottom-right strip, with empty save-state text hidden. Desktop ribbon buttons use the cited icon/padding dimensions. The ribbon's 48px top padding combines the 40px header reservation with 8px ribbon padding because this clone has one ribbon element. Similarly, the clone's existing sidebar toggle is positioned in its tab header rather than keeping an additional 38px row. These two rules adapt verified dimensions to this DOM; they do not establish equivalent window-frame architecture. Tab preferred width remains 200px with zero minimum and a 320px cap; preserving `flex: 0 1 200px` is deliberate because this clone has no reference-style inner tab-strip wrapper. Conditional note-tab icon hiding, focus-window state, curves, and exact tab compression remain open.

Desktop geometry selectors are restricted to `min-width: 701px`, preserving the existing small-screen drawers, control sizes, note padding, safe areas and in-flow status bar. Common colors and typography still inherit on small screens; mobile-specific palette and font scaling are not claimed. There are no selectors for properties' internal grid, table controls, image/attachment/embedded-view layout, task decoration, or native menus. The readable-width rule constrains the existing outer properties host as part of the document column, without changing its internals.

The missing-layout right-dock collapse requires workspace state initialization and was reported to the workspace/integration owner. CSS does not hide that dock or override its toggles. System selection and preference listeners likewise remain workspace responsibilities. The supplied screenshot has not been used as a fresh-install configuration oracle.

Validation: webpack 5 with the project's existing `style-loader`/`css-loader` successfully compiled this stylesheet independently to `/private/tmp/zorid-theme-defaults-validation/theme-defaults.js`. `git diff --check` passed. No test that merely asserts copied CSS constants was added. These checks establish stylesheet compilation, not computed layout, screenshot matching, or reference behavior. Browser capture and interaction validation belong to the integration pass after import.

## Open verification work

The bounded questions above are answered as declaration/config facts. Runtime resolution remains open: actual font selection; computed styles and winning selectors; window scale/device-pixel ratio; system-theme transitions; exact fresh-vault plugin and tab population; Electron titlebar/traffic-light geometry; responsive dock behavior; focused/inactive colors; popout state; scrollbar allocation; checkbox rendering; and editor measurements. None can be inferred from the supplied screenshot or static fallback object alone.

For a later authorized runtime pass, record viewport, OS/theme state, zoom, settings, layout file and content fixture; compare both themes and explicit/system selection, readable width on/off, empty and populated properties, tasks, and tables. This document authorizes no reference runtime or UI action. Until such evidence exists, mark visual equivalence unverified even after adopting these independent factual values.
