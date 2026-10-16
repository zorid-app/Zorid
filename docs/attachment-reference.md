# Attachment reference findings

Focused static inspection of Obsidian 1.14.4, 2026-10-16. This pass reused existing evidence and read selected source ranges without target execution or another broad analysis. No recovered source, CSS, or assets are part of Zorid.

Desktop source: `app.js`, SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`, identified by REA E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. E3 is partial static analysis; this report's detailed behavior readings are ordinary source inspection, not additional REA semantic findings. APK source: `assets/public/app.js`, SHA-256 `b0452336e0926983c240ce168bb03bcc308d32a54fc97cdd5db72ed7f333f997`, inventoried under `ev_90bd2cb53a47511858df33ce3b4ad304c2af7a8d82c12035710bcabfeed4623d`. Reference artifacts remain outside the repository.

Positions below are zero-based Unicode character offsets in the UTF-8-decoded desktop source unless stated otherwise. These positions are build-specific, not byte offsets or stable API identifiers.

## Image format declarations

The image-view extension registry around 1258768 lists **bmp, png, jpg, jpeg, gif, svg, webp, avif**. The APK has the same list around 1266521. The standalone image-view implementation uses this extension list to accept files. This establishes declared routing, not successful decoding of every file variant by Chromium/WebView.

A separate MIME-to-extension map near 544209 includes `image/avif`, `image/bmp`, `image/gif`, `image/jpeg`, `image/pict`, `image/png`, `image/svg+xml`, `image/tiff`, and `image/webp`. Presence of PICT/TIFF in that utility map does **not** establish support in the image-view extension registry. MIME handling and view registration must remain separate claims.

## Dimensions and alternative text

The dimension parser around 754216 accepts:

- An unsigned integer width, with optional surrounding whitespace.
- Optionally a lowercase `x` followed by an unsigned integer height; whitespace may surround the separator and dimensions.
- Leading zeros are parsed numerically. Zero values pass syntax recognition.

It does not recognize a percentage, decimal, signed number, CSS unit, uppercase `X`, or omitted width in the inspected matcher. For example, `300`, `300x200`, and ` 300 x 200 ` are recognized candidates; `50%`, `300px`, `300X200`, and `x200` are not.

The shared title helper near 754352 tests the suffix after the **last** pipe for dimensions, retaining preceding text as alt text. Without a pipe, a valid dimension-only title becomes size metadata with empty remaining alt. The internal-embed AST transformer near 766626 uses that last-segment rule and falls back to the link destination if alt becomes empty. The Markdown-image transformer near 766471 also tests the last pipe suffix; its bare dimension-only alt path retains that original alt value. Therefore wiki and Markdown-image alt fallback are not assumed byte-identical.

Reading-renderer dimension attributes and live-preview attributes differ in a bounded edge case: the AST helper near 754552 emits width even when zero, and omits height when zero; the live-preview helper near 3028012 removes either dimension attribute when its numeric value is zero. Actual rendered size for zero, invalid, very large, or constrained dimensions remains a runtime/CSS test case.

The image loader near 850592 copies available alt, width, and height attributes from the embed container to an `img`. It resolves its load promise on load/error or a five-second fallback. This is not evidence that failures are visually identical or that all image decoding completes within five seconds. The APK has the same dimension matcher around 760669; a full renderer-equivalence claim has not been established.

## Internal and external sources

For internal embeds, the live widget around 3030200 resolves the target through the metadata cache relative to the source note, then obtains the vault resource URL. It invokes the extension-specific embed loader. The image embed class near 2681967 delegates to the same image display helper as the standalone image view.

The external-image widget around 3028170 uses its URL directly for image creation, except for recognized external media sources that route to an iframe/embed handler. Its external-media helper near 1996871 recognizes particular video/social URL shapes. Those media cases are not interchangeable with arbitrary image URLs. The Markdown parser's relative-path classifier near 653653 treats explicit `./` and `../` paths, and paths without a colon, as local candidates. Final vault lookup, protocol handling, encoding, and invalid URL behavior remain distinct test cases.

Desktop resource URLs near 553053 are adapter-generated URLs based on the file path and modification time (with a time fallback), rather than embedding raw binary bytes into note text. The reading pipeline's Publish-specific internal-URL implementation is a different surface and should not be used as a desktop vault specification.

## Standalone image file and lightbox

The standalone image view near 2631713 declares view type `image`, accepts the registered extensions, clears its content area, creates an image container, and displays the vault resource URL. No dedicated zoom/pan bindings were found within that small class. This does not establish absence of global or shared handlers.

A separate shared lightbox begins near 1687831. Reading-view image clicks gather the rendered images in document order and open that lightbox at the clicked image near 2002621. An editor image-selection path near 1714940 also opens it. Consequently a simple standalone image tab and a modal gallery are distinct reference surfaces.

Observed lightbox handler candidates:

| Input/state | Static behavior |
| --- | --- |
| Initial state | Zoom 1; horizontal/vertical pan 0; selected gallery index; title prefers title, then alt, then a URL-derived fallback. |
| Escape / close button | Close. Space keydown marks a held-space state; corresponding keyup closes. |
| `=` | Multiply zoom by 1.2, round the product to two decimal places, then round upward to the next tenth; clamp to [1, 10]. |
| `-` | Divide zoom by 1.2, round to two decimal places, then round downward to a tenth; clamp to [1, 10]. |
| Left / Right | Move through gallery with wrapping; reset zoom and pan for the new image. |
| Ctrl/Meta + wheel | Add negative normalized vertical delta divided by 150 to zoom, clamped to [1, 10]. Line deltas multiply by 40 and page deltas by 800. A macOS fractional-delta branch doubles the adjustment. |
| Wheel zoom anchor | Keep the point beneath the pointer fixed using pointer position relative to the media-container center and the new/old zoom ratio. Returning to zoom 1 resets pan. |
| Unmodified wheel | When zoom exceeds 1, pan by negative 1.5 times each wheel delta. |
| Double-click / double-tap | If zoomed, reset to 1 with zero pan; otherwise zoom to 2.5 and center around the clicked image point. |
| Mouse drag | Left-button drag on the active image pans when zoom exceeds 1; momentum handling follows release. |
| Pan bounds | Each axis is clamped to half the positive overflow of scaled image size beyond media-container size. |
| Touch | Distinct pinch zoom/pinch-to-close, horizontal gallery swipe, downward dismissal, threshold detection, double-tap, and momentum paths exist. |

The keyboard handler is in the constructor; wheel logic begins near 1697426; zoom application, double-tap and bounds are near 1706714–1708284. Background clicks that do not target an image close the lightbox. Close paths cancel animation frames and momentum, remove the modal, and invoke a supplied focus-restoration callback. Initial-image animations and mobile viewport settling logic exist but were not visually measured.

These are implementation-reading candidates, not measured interaction parity. Touch thresholds, animation curves/timing, inertial movement, keyboard layout mapping, accessibility, failure handling, and exact image-fit CSS need runtime validation. Registering zoom icons elsewhere in the bundle is not evidence of standalone image-tab zoom controls.

## Paste, drag/drop, names and destination

The transfer reader near 1474400 handles file items and obtains native paths on desktop where possible. When an image file item has no native path, PNG and JPEG MIME cases use the generic basename `Pasted image`, with `png` or `jpg` extension. A desktop clipboard fallback can read a native clipboard image when the transfer has no files/plain text and Shift is not held. These conditions do not establish identical browser, Android and iOS clipboard results.

Saving that generic image name near 1745126 appends a Moment-formatted timestamp `YYYYMMDDHHmmss`. The editor save flow inserts an embed generated by the file manager's link-format policy. Existing vault file paths can be resolved and reused rather than imported again in the broader file-transfer path near 3927845. Directory drops, overwrite policy, concurrent imports, modifiers, and operating-system-specific formats require more evidence.

The default attachment-folder config literal near 1410297 is `/`. The allocator near 1427809 interprets `.` or `./` relative to the active/source note's parent, interprets `./subfolder` under that parent, and otherwise uses the configured vault folder. It normalizes the folder/name and attempts to create a missing destination folder. Its available-name helper checks case-insensitive collisions and appends increasing numeric suffixes separated by a space before the extension. The basename path is sanitized and bounded before allocation. These are static findings, not an assertion that Zorid already implements every edge case.

## PDF metadata

Both inspected desktop and APK `lib/pdfjs/version.json` declare **5.3.34**, build **34**, commit **cc1e2a3e0**. The APK member digest is `0a8ac68bb7f1845ad8eb795e7147abf66f75c79b5e585c5985dbad4d42ad1eec`. Matching metadata does not prove identical whole distributions or PDF viewer integrations. An iframe/object PDF fallback is not equivalent to the reference's PDF.js tools, links, search, selection, embeds and annotations.

## Verification still needed

Exercise a versioned fixture corpus on the actual desktop/mobile reference: supported and malformed image formats, internal versus external URLs, alt/dimension combinations, gallery order and focus, modifier-wheel anchoring, clipping/panning, unavailable files, changes during loading, and import collision/destination settings. No source was executed in this pass and no visual, timing or gesture parity is certified.
