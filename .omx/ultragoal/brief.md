Implement Live Preview Pass 5.

Goal 1: Add Phase 5A failing tests for bounded widget decoration collection and bounded scanner work/input windows. Cover visible/near-visible windows, semantic-container fixtures, distant-region non-consumption, and existing fenced-code widget regressions.

Goal 2: Implement Phase 5A minimally in packages/editor/src/live-preview so widget decorations are built from visible/near-visible ranges instead of unconditional full-document context. Preserve private APIs and existing fenced-code behavior.

Goal 3: Add tests for a private widget suppression/ordering seam and conservative callout matching. Cover simple/titled callouts, quoted blank lines, interruption by unquoted content, lazy continuation raw, nested blockquote raw, code suppression, and outside inline/task/link/tag behavior.

Goal 4: Implement one private callout widget shell with safe DOM, source reveal, pointer activation, renderer suppression, and scoped desktop styles. Keep APIs private and do not add rich callout UI or dependencies.

Goal 5: Run targeted and full verification, run final cleanup/review gate, resolve blockers, checkpoint completion, and commit changed files.

Stop condition: if Goal 2 requires broad parser or extension architecture work, stop after Goal 2 and defer Goals 3-4. Constraints: canonical Markdown source only, private packages/editor/src/live-preview APIs only, no platform API changes, no tables/properties/embeds/math/syntax highlighting/Reading parity/public widget APIs/new dependencies.
