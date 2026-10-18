# Clipboard and attachment import reference

Focused static reading of Obsidian 1.14.4. The requested target includes file/image paste, drops, attachment creation, link insertion and rendered embeds. This document describes observed implementation branches, not completed Zorid parity.

## Evidence and scope

This follows the `reverse-engineer-anything` workflow and reuses REA renderer E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`, exported outside the repository in `/private/tmp/zorid-reference-20261016/rea-renderer-bundle.json`. The inspected desktop `app.js` SHA-256 is `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`, source node `jag_node_621f724371e7aca9238d1f3a97fd54476f29e95749ed28f0e9b6a7f00f7078a2`. E3's expanded semantic graph is partial; its successful parsing does not establish runtime behavior.

The following facts are focused ordinary source readings tied to that identity, not new REA semantic relationships. Offsets are zero-based Unicode character positions in UTF-8-decoded source. No broad analysis was repeated, reference executed, native clipboard read, or proprietary implementation copied into the project. See [reference-evidence.md](../reference-evidence.md), [editor-reference.md](editor-reference.md), and [attachment-reference.md](attachment-reference.md) for the surrounding evidence and limitations.

## Paste entry and priority

The clipboard manager `OR` begins at 1740124. Its paste DOM handler emits the workspace `editor-paste` event with the event, editor and owner unless already prevented. A handler that prevents default can stop further handling. A properties-specific clipboard format has a separate owner route. This is an extension interception point, not an authorization to call plugins outside their declared lifecycle.

The CodeMirror paste hook at 2582911 follows this order:

1. Ask the clipboard manager for converted transfer text.
2. Consider that text, or ordinary plain text, for URL-over-selection conversion and list-marker merging.
3. Insert converted text with an `input.paste` transaction when present.
4. Otherwise read transferable files and start sequential attachment import when any are available.
5. Let CodeMirror's ordinary text-paste path run when the hook did not handle the transfer.

The baseline paste handler at 408363 checks read-only state, flushes the editor observer, invokes paste hooks, then falls back to plain text or URI-list text. Its text insertion path at 403123 supports multiple selections and linewise clipboard behavior and labels the transaction `input.paste`. This is different from asynchronously inserting an imported attachment after the hook has returned.

Copy adds `text/markdown` and, for selected text of at most one million characters, rendered HTML prefixed by an Obsidian marker. Existing plain text comes from CodeMirror's copy path. On paste, the presence of that marker plus plain text bypasses HTML conversion. This avoids reconverting the application's own rendered HTML when its Markdown text is available through the normal clipboard path.

### Text, HTML and URLs

`handleDataTransfer` at 1742655 recognizes nonempty `text/markdown` before ordinary HTML conversion, except for the own-copy marker bypass. HTML conversion depends on `autoConvertHtml`, whose shipped default literal is true. A transfer with files and a fragment consisting only of one image element is left for file handling. Local resource URLs in HTML media can be translated back to vault link text. Remaining HTML is passed to the shipped HTML-to-Markdown converter.

Large data URLs in image/audio/video elements have a separate removal/import branch with PNG/JPEG decoding and save calls. The inspected asynchronous loop has an apparent index-versus-value ambiguity; successful data-URL extraction is **not established**. Do not promise exact behavior or duplicate a suspected bug without a runtime fixture.

### Bounded HTML converter reconstruction

A focused follow-up rechecked the same `app.js` SHA-256 above and read converter configuration/custom rules at 1727719–1731200, the marker declaration before 1740124, and transfer priority at 1742655–1744501. These are ordinary static readings attached to the retained E3 identity, not additional runtime evidence or newly inferred graph edges. The converter selects ATX headings, dash bullets, fenced code, inline links and a three-dash rule. Custom rules cover strike/highlight, link/image titles, highlighted code language classes, four-space list continuation, ordered-list starts, direct-child checkbox tasks, table alignment/colspan placeholders, and synthetic empty headers for tables lacking a header. The exact own-copy marker is `<!-- obsidian -->`; marker plus nonempty plain text bypasses conversion **before** reading Markdown MIME. The inspected converter disables its ordinary text-escaping method.

Zorid's original [clipboard-html module](../../src/editor/clipboard-html.ts) exports `htmlToMarkdown(html, { document? })`, `isOwnClipboardHTML(html)`, and `isSingleImageHTML(html, { document? })`. It uses an injected document or the browser global document to parse into an inert template in a detached document. It never mounts parsed nodes or fetches their URLs. Conversion returns `null` when no text remains or no DOM is available. MIME priority, the HTML-conversion setting, own-copy bypass and image-file priority remain controller responsibilities. The image-only helper ignores comments/outer whitespace; it intentionally does not classify a paragraph wrapping an image as a lone image.

The bounded implementation preserves the structures listed above plus blockquotes, Unicode, hard breaks and ordinary inline emphasis. Unknown elements contribute their text; scripts/styles/titles, embedded active documents, SVG/MathML and hidden/template content are excluded. As deliberate original safeguards, literal Markdown punctuation is escaped (unlike the inspected override), code delimiters grow around embedded backticks, and unsupported or active URL schemes are omitted while link labels survive. Text URL attributes are used directly, without document-base resolution. Data-URL extraction, native resource-to-vault rewriting, computed CSS formatting, rowspan, and exact Turndown whitespace parity remain outside this module. Fixtures in [clipboard-html tests](../../tests/clipboard-html.test.ts) verify these original choices; they do not certify reference runtime behavior or actual OS clipboard formats.

For `text/uri-list`, absent plain text can yield the URI itself, with special `.webloc`/`.url` handling. Different URI/plain labels can become Markdown links, with an image prefix for a recognized image extension. URI decoding and malformed input behavior need tests.

Pasting a URL over a nonempty single-line selection creates a Markdown link using the selected text. Multiple selections are supported when one URL applies to all or a corresponding list of URLs matches the number of selections. Multiline selected spans bypass this shortcut. Smart-list paste can merge an incoming list marker with an existing marker at the insertion point rather than duplicate both. These are text-paste features, separate from file import.

## Transfer files and native fallback

The transfer reader `GL` at 1474501 enumerates file-kind DataTransfer items. It obtains a File and derives basename/extension. On desktop it uses the File native path or Electron `webUtils.getPathForFile` when available. Binary data is read from that path or from the File object as appropriate.

Without a native path, PNG MIME becomes basename `Pasted image`, extension `png`; JPEG becomes `Pasted image`, extension `jpg`, even if the browser File had a different name. Other MIME types do not receive this particular naming override. Arbitrary file items are not restricted to the registered image extension list in this reader.

If a desktop clipboard transfer contains no file items and no plain text, and Shift is not held, the fallback reads Electron's native clipboard image and converts it to PNG. If no image is available, it can read Windows `FileNameW` or macOS `public.file-url` and load that path. These are desktop-specific branches. Their presence does not establish browser, Android, iOS, Linux desktop, remote clipboard or OS permission parity.

Directory paths are recognized and marked by this reader. The generic application importer supports recursive directory import, but the editor's narrower `insertFiles` branch does not invoke that directory importer. Directory-drop behavior inside the editor therefore cannot be claimed from the generic importer alone.

## Destination, names and binary writes

`OR.insertFiles` at 1744501 processes entries sequentially. A native path already resolving to a vault file is reused. Otherwise it awaits bytes, calls the attachment saver and inserts a link after creation succeeds. The observed source does not compare byte hashes to deduplicate independently imported files.

`OR.saveAttachment` at 1745126 adds a local Moment timestamp with format `YYYYMMDDHHmmss` to the exact generic basename `Pasted image`. A resulting candidate is `Pasted image 20261016142305.png`. Original named files retain their basename before the allocator's normalization and collision handling.

The application saver near 3928200 gets `workspace.getActiveFile()`, passes it to the vault attachment allocator, then writes with `createBinary`. This is a meaningful distinction: attachment destination derives from the active file, while the clipboard manager generates link text relative to its receiving owner's file path. Focus changes or asynchronous imports can make those contexts differ; they need explicit tests.

The allocator at 1427819 interprets `attachmentFolderPath` as follows:

| Setting | Destination candidate |
| --- | --- |
| `/` | Vault root; shipped default literal. |
| `.` or `./` | Active/source file's parent, or root when absent. |
| `./subfolder` | Subfolder relative to that parent. |
| Other path | Named vault folder. |

It normalizes paths, applies the shared name sanitizer, limits the candidate basename to 250 string units, creates a missing destination folder, and requests an available path. The sanitizer replaces reserved link-related punctuation/sequences and collapses whitespace; this is not a full inventory of OS-specific filename restrictions. If an existing destination entry is not a folder, the inspected allocator falls back to a root-level available path.

The available-path helper near 1427600 checks case-insensitive collisions. It first tries the unsuffixed name, then appends ` 1`, ` 2`, and so on before the extension. The allocation and later binary write are separate calls: atomic reservation, concurrent imports, case-sensitive filesystem edge cases and write-failure recovery remain unverified. The observed operation creates a new available path; it does not intentionally overwrite a colliding attachment.

## Markdown inserted after import

The editor importer at 1745400 always prefixes the generated link with `!`, including Markdown and otherwise unsupported file extensions. This differs from internal drag/link routes, which use an embed prefix only for registered embeddable extensions. Do not unify those branches merely because both accept a file.

The file manager at 1800965 reads `useMarkdownLinks`. Its default literal is false:

- Wiki-style import typically inserts `![[photo.png]]`.
- Markdown-style import of a non-Markdown attachment typically inserts `![](../photo.png)` with encoded destination characters.
- Markdown-style import of a Markdown file uses its basename as link label and retains its extension in the target.

The metadata link policy at 1754100 reads `newLinkFormat`: `absolute` returns a vault-relative full path; `relative` computes a path from the receiving note's parent; the default `shortest` uses a basename only when metadata lookup uniquely resolves it to the target, otherwise the full vault path. “Absolute” here does not mean a system filesystem path. Wiki links normally omit a Markdown extension; Markdown links retain it. The inspected URI encoder escapes spaces, backslashes and selected control characters rather than applying blanket URI encoding to every character.

For a batch of editor-imported files, each item except the final item gets two newline characters after its embed. There is no additional guaranteed leading or trailing newline around the whole batch. Sequential insertions replace the editor's current selection. Internal drag links instead join with a single newline. The separate attachment-picker command has its own insertion loop and does not add the same batch blank-line separator.

## Drop behavior and modifier variants

`handleDrop` near 1741300 first distinguishes the application's internal drag payload from external DataTransfer content. Internal file, multi-file, link, heading and bookmark payloads are converted through `IR` at 1739410. Heading/subpath and bookmark labels are retained by their respective link-generation branches.

Registered internal-drag embeddables include the image/audio/video lists, PDF, Canvas and Bases, and exclude ordinary Markdown notes in this predicate. External normal drops can first consume rich transfer text unless Shift bypasses that conversion; otherwise files are imported. The editor moves selection to the drop coordinates before final insertion.

With macOS Alt or non-macOS Ctrl, external native paths are linked instead of imported. Existing vault files use vault links and the registered-embeddable predicate. Paths outside the vault become `file://` Markdown links; only recognized image extensions receive an image prefix in that branch. macOS Shift or non-macOS Alt on an internal drag delegates to the Markdown view's separate drop handling instead of this insertion route. Exact side effects of that alternate route were not traced here.

The drag-over cursor chooses copy/link feedback with separate platform/modifier logic. Its displayed cursor alone must not be treated as proof of the final drop operation.

## Transactions, asynchronous behavior and undo

Converted text and URL/list paste paths explicitly mark `input.paste`. Imported attachment insertion calls the editor's `replaceSelection` without an explicit user-event label in the inspected clipboard manager. Binary file creation is outside CodeMirror text history. No disk-delete rollback is connected to undo in this branch, and no guarantee that an entire multi-file import is one undo unit was observed.

The importer does not capture a durable selection bookmark before awaiting file reads/writes in this scope. It inserts into the current editor selection after each await. Editing, tab changes, multiple cursors, table-cell focus, cancellation, or owner destruction during import are therefore important test cases. A clone should define safe behavior for these cases and label deviations honestly rather than claim unseen reference guarantees.

The `editor:attach-file` command near 1963450 uses a hidden file input, reads selected files as array buffers, saves attachments, and inserts generated embeds. Android has a camera/file chooser branch; the camera input sets image accept/capture hints. This is a static shared-bundle branch, not a tested native mobile clipboard integration.

## Reconstruction contract and remaining checks

An original implementation needs distinct adapters for transfer decoding, native path lookup, binary storage, attachment allocation, link formatting and editor transactions. Preserve bytes outside Markdown; resolve/render the resulting vault embed through the normal attachment lifecycle. Implement the explicit branch priorities and settings above, then test their interactions rather than merely showing a pasted image in temporary DOM.

The highest-value fixtures are: PNG/JPEG without native paths; named files with native paths; existing vault reuse; same-second pasted-image collisions; every attachment-folder mode; shortest/relative/full-path links; Markdown/wiki syntax; multi-file separators; URL-over-selection; plugin prevention; internal/external modifier drops; failed writes; selection changes during import; undo; repeated embed refresh; and mobile clipboard/file-picker behavior. OS clipboard formats, exact asynchronous insertion timing, native permission handling and visual/UX parity remain unverified. No passing Zorid-only test can certify those reference behaviors.
