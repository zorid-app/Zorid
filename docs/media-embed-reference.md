# Audio/video embed audit and implementation boundary

This is a static audit of the supplied Obsidian 1.14.4 desktop artifact, plus a plan against Zorid checkpoint `ba27454`. It does not implement media playback or establish browser/native codec, interaction, or visual parity. The only project change in this lane is this document.

## Evidence identity

The prior REA renderer analysis is E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`, with partial semantic-graph coverage, described in [reference-evidence.md](reference-evidence.md). Its current-session lookup failed because the record is no longer retained; the old portable bundle is also absent. No producer was rerun. The external source was restored separately by the PDF audit using REA extraction `ev_ec268d4710d98bd994642c3a390b963e050880975c210f85226470c9360cd459`; `/private/tmp/zorid-reference-restored.json` records the extraction directory and compatibility path. This pass checked the recovered file hashes directly:

- ASAR identity from the restoration manifest: `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`.
- `app.js`: `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
- `app.css`: `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`.

Source anchors below are **zero-based Unicode character offsets** in Python-decoded UTF-8 text, not byte offsets. They are focused ordinary source observations tied to the checked artifact, not new REA call-graph results. Recovered implementation and assets remain outside the project; no reference code was executed.

## Accepted files and link routing

| Contract | Anchor in app.js | Observation |
| --- | --- | --- |
| Extension sets | 1258760–1259140 | Audio: `mp3`, `wav`, `m4a`, `3gp`, `flac`, `ogg`, `oga`, `opus`. Video: `mp4`, `webm`, `ogv`, `mov`, `mkv`. These are routing lists, not guarantees that each codec/container plays on every platform. |
| Extension extraction | 543708–543850 | Extension text is lowercased. |
| Wiki syntax | 654442–654690; 756100–756650 | `![[path|label]]` produces an internal embed with target and label. The first alias separator divides path from label; target whitespace/NBSP/NFC normalization is shared with ordinary wiki links. |
| Markdown image syntax | 653653–654250; 763750–764100 | Image destinations beginning `./` or `../`, or containing no colon, become internal embeds after URI decoding and normalization. This is not the same as classifying all Markdown destinations by extension. |
| Resolved local embed | 2684300–2686350 | The target is split into path/subpath, resolved through metadata relative to its source note, and dispatched by the resolved file extension. Audio/video creators ignore the passed subpath. Unknown file types receive the generic attachment embed. |
| Remote image destinations | 1996500–1998000; 2028259–2028800; 3028000–3028900 | Recognized YouTube and Twitter/X destinations can become provider iframes. Otherwise an external Markdown image remains an image widget. The inspected path does not promote an arbitrary `https://host/movie.mp4` or `.mp3` image destination into a native media player. |

Examples within the supported local route include `![[Recording.MP3]]`, `![[clips/demo.webm|Demo]]`, and `![caption](../clips/demo%20one.mp4)`. Ordinary links without `!` remain links. A local media `#fragment` is parsed for file resolution but is not passed into these media loaders, so timestamp support must not be inferred from URL syntax alone. Explicit raw HTML media and provider iframes are separate paths; they are outside the proposed first implementation.

## Media elements, sizing, and readiness

The native audio helper at **851525–851867** creates an `audio` element with `controls` and `controlsList="nodownload"`. It assigns the resource URL and settles its readiness promise on metadata, error, or a five-second timeout. It does not set autoplay or loop. Settled readiness means loading has reached a stopping point, not necessarily successful playback. The timeout and event details are observations, not a lifecycle implementation to copy.

The video helper at **851867–852400** creates `video` with `controls` and `preload="metadata"`. It temporarily hides height while loading and appends `#t=0.001` to the resource URL. Metadata, error, or a five-second timeout restores height and settles readiness. If metadata gives both video dimensions as zero, the video source is cleared and its element is replaced by the audio helper. This is an audio-only-content fallback, not a fallback for every decoder failure. There is no autoplay, custom transport UI, playback-rate menu, subtitle picker, or poster attribute in these inspected constructors.

Dimension parsing at **754226–754760**, Reading transformations at **766300–766800**, and Live `applyTitle` at **3030673–3031100** accept an integer width or width-by-height in the final label segment. For local media, those attributes are applied to the outer embed; the Live path applies them directly to the child element only for images. The inspected media helpers do not copy the embed's width/height onto audio/video. Therefore `![[clip.mp4|320x200]]` must not be claimed to produce an exact 320×200 player from static attributes alone.

Relevant stylesheet observations:

- **331675–332100:** audio width is 100%, height 42 px; rendered audio is capped at 100% width. Native WebKit controls receive theme rules.
- **350444–350520:** rendered video is capped at 100% width, without a fixed height in this rule.
- **370080–370340:** nonimage internal embeds are block-level; internal audio/video have maximum width 100%.
- **210650–210950:** standalone media containers center their contents and constrain width.
- **297450–298080:** hover-popover rules have separate fit-content and maximum-size behavior. They are not evidence for ordinary embed dimensions.

## Source reveal and context menus

Live local embed construction at **3029600–3030673** gives media the generic widget click/source-selection hook, whereas images receive image-specific controls and PDFs receive an edit button. The base hook at **1949481–1951200**, together with the deferred click helper at **870659–871750**, checks prevented events, selection, focus, and interactive descendants before selecting the widget's source range. How native media control events interact with that hook requires runtime verification; clicking Play must not be assumed equivalent to clicking unused embed space.

Reading event delegation at **2020970–2022830** forwards `img,video` click/contextmenu events to an optional owner callback when the event is not already prevented and the node belongs to the current renderer. Audio is absent from that selector. The inspected registration calls at **2040743** and **2577923** do not themselves provide the optional media callback. The ordinary Live editor contextmenu path begins at **2592017** and can still receive bubbled events. These observations do **not** establish a complete ordered audio/video menu or that browser-native controls always keep their default menu. No image-only Copy image/Swap file/Remove image/Reset size actions should be assigned to media from analogy. Exact native menus and menu ownership remain an explicit gap.

## Resource ownership

Audio and video views obtain their source through `vault.getResourcePath` (**2630943–2631740**, **2678211–2678990**), and local media embed classes reuse those display helpers (**2681753–2682600**). Media unload clears every descendant audio/video `src` and `srcObject` through the cleanup helper at **860398–860540**. The source code does not require a JavaScript Blob for these local reference players:

- Vault forwarding: **1424098–1424200**.
- Desktop adapter: **553063–553460**, native resource URL with modification-time cache busting.
- Mobile adapter: **1350689–1350870**, URI supplied by its filesystem bridge.

This explains why Zorid's Blob approach is an original adapter choice, not exact reference storage parity. Zorid currently reads entire attachment bytes, coalesces loads, and shares refcounted object URLs through `AttachmentResources`. Four bounded reads limit concurrency, but do not bound the total size of a large media file. Streaming/range loading is a separate future adapter capability and must not be claimed by the initial embed implementation.

## Minimal implementation plan against Zorid

`MarkdownEmbeds` already receives `{ target, kind, label }`, resolves local files through metadata, owns lazy visibility/generation state, and supports both Reading and Live Edit. At this checkpoint it has image and PDF branches; local audio/video fall through to “Attachment viewer is not implemented yet.” All HTTP(S) Markdown image requests take the external image branch, consistent with the bounded remote route above. The existing Live embed wrapper already excludes audio/video from source-reveal clicks and exposes an explicit Edit embed source button.

The smallest isolated implementation is:

1. **New `src/ui/media-view.ts`, `src/ui/media-view.css`, and `tests/media-view.test.ts`:** a destination-document-owned audio/video view. Proposed API: `mediaKind(path): 'audio' | 'video' | null` and `createMediaView(container, path, resources, options?) -> { ready: Promise<void>, destroy(): void }`. The module owns one lease, media event handlers, metadata timeout, fallback transition, error display, and idempotent disposal. `destroy` detaches handlers/timers, stops/resets sources before releasing the URL, and makes late acquisition release immediately without attaching. The public `ready` must settle on destroy even while acquisition is pending. A video-to-audio fallback retains the same lease until the replacement audio is destroyed; removing the video alone must not revoke that source. The module does not open files, edit Markdown, or invent a menu. A host/test factory injection can mirror `pdfFactory`.
2. **Narrow `src/ui/attachments.ts` MIME additions and `tests/attachments.test.ts`:** preserve existing shared resource semantics; add missing routing formats (`3gp`, `flac`, `oga`, `opus`, `ogv`, `mkv`) without treating MIME mapping as a codec guarantee. Do not create a second URL cache or native filesystem path bypass.
3. **Host-owned `src/ui/embeds.ts` plus embed tests:** add a local media branch before the unsupported-attachment branch and one media-view handle to state. Destroy that handle before refresh/replacement/release. Keep the handle responsible for its lease, avoiding a second outer lease. Build on teardown commit `ed3b84f` or its integrated successor; preserve the new math/code subtree disposal and stale-owner checks.
4. **Host-owned CSS import only in `src/main.ts`:** load the scoped media stylesheet. Preserve the existing explicit source-reveal affordance and interactive-control exclusions in `src/editor/live-embeds.ts`. Add integration tests there if media controls expose a regression; no parser rewrite is needed for basic local embeds.

`render_teardown_embeds`/the rendering integration lane owns the shared embed host. `AttachmentResources`, workspace menu policy, and new-view code need explicit ownership coordination before implementation. Workspace currently sends every resolved embed's contextmenu to the generic file menu; media menu interception must be tested separately before claiming the reference's native-control behavior. Standalone audio/video tabs, provider iframes, raw HTML players, recording, streaming, and mobile permissions are excluded from this minimum change.

## Focused acceptance tests and remaining uncertainty

Use original tiny audio/video fixtures and fake metadata events for unit tests; do not import reference media. Test every accepted extension including uppercase, rejected unknown extensions, native attributes, metadata/error/timeout settlement, zero-dimension video fallback, no autoplay, and destination document ownership. Test a deferred acquisition followed by destroy, refresh races, repeated destroy, two players sharing one URL, modification invalidation, and release ordering with no stale errors or media attachment. Test wiki and relative/encoded Markdown embeds, the deliberate external-image boundary, native-control clicks preserving playback interaction, and source edits unmounting exactly one media instance.

No tests or native playback were run in this documentation-only lane. Codec availability, seek/range behavior, actual native control menus, Play versus source-reveal hit testing, label dimensions, accessibility of native controls, mobile suspend/background playback, and Electron/Capacitor visual appearance remain unverified. The next code lane should establish ownership tests first; root retains native verification.

The embed teardown owner reviewed this plan read-only against `ed3b84f` and found no lifecycle/API ownership conflict. The immediate `ready` settlement and shared fallback-lease requirements above incorporate that review. This is an implementation-plan review, not code or runtime verification.

## Isolated media module implementation

`src/ui/media-view.ts` now implements `mediaKind(path)` and `createMediaView(container, path, resources)` with a `{ ready, destroy }` handle. No fourth options argument is currently needed. It accepts resolved local paths only, creates elements through the destination document, owns one attachment lease through video-to-audio fallback, and displays loading/decoder/read errors as text. `ready` resolves on metadata, native error, acquisition failure, five seconds after source acquisition, or destroy; it does not certify playback. Destroy settles immediately during pending acquisition, releases any eventual late lease without mounting, clears timers/listeners/native media sources, then releases the active lease. The scoped stylesheet adds native audio sizing and bounded media width. The attachment MIME map now includes the six previously missing extensions.

Nine module tests use fake acquisition/events and original RIFF marker bytes, including two-player sharing through the real `AttachmentResources` class. Eight existing attachment regressions and a scoped strict TypeScript check pass. No native decoding was exercised. The module is not yet imported into the application or called by `MarkdownEmbeds`; host state/factory integration, stylesheet import, media context-menu ownership, parser-to-player integration tests, and native verification remain pending.

Independent module review found no ownership blocker and passed additional destination-document and late-rejection-after-destroy probes. The fallback deliberately retains one overall five-second readiness deadline: switching to audio near that deadline does not restart it. In the inspected reference, the video timer likewise remains live while its separate audio helper starts another timer; the original outer readiness can therefore settle first. Zorid does not retain that extra inner timer. Both early settlement and late metadata/fallback continue to be distinct from playback success.
