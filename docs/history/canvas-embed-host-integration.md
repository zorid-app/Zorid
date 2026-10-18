# Static Canvas embed integration

Markdown embeds now route resolved `.canvas` files to the reviewed static SVG
preview in Reading and Live Edit. The embed manager uses its bounded shared text
reader, including unsaved-buffer reads supplied by the existing host. Preview
navigation uses the original note source, target and link syntax. Its interactive
root claims clicks so Live Edit does not interpret navigation as source editing.
No Canvas editor, card text rendering, attachment decoder or file mutation is
introduced in this route.

The embed owns the preview and retires its listeners and DOM before dependency
refresh, nested-note replacement, widget release or manager destruction. Shared
version guards discard obsolete reads and errors. Unrelated vault topology events
preserve a valid preview; changed parked dependencies refresh after reattachment.
A same-path content change remounts the static preview, consistent with existing
attachment owners. The helper's standalone last-valid-update retention is not
used across host refreshes. Invalid Canvas input displays the helper's error and
never rewrites source bytes.

Scoped tests cover actual Reading and Live editor rendering, navigation and source
selection arbitration, source-byte preservation, unrelated events, parked update
coalescing, deferred obsolete reads, nested release and invalid/deleted files.
These checks do not establish native size, pointer geometry, mobile behavior or
reference visual parity. The existing embed navigation callback does not carry
modifier/destination information; this integration does not introduce a new host
API or claim new-tab modifier parity. Canvas fragments and embed sizing aliases
retain their existing host limitations.
