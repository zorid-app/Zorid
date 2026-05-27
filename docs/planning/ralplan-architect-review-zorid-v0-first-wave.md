# RALPLAN Architect Review: Zorid v0 First Implementation Wave

Verdict: APPROVE

The iteration-1 architectural blockers are materially resolved. The revised plan now has explicit package/type ownership, removes the public service escape hatch, normalizes plugin capabilities, covers the omitted core Platform APIs, defines core-plugin exported APIs, clarifies the data/index boundary, and narrows first-wave mobile scope to skeleton/compatibility only.

## Steelman Antithesis

The strongest argument against the favored API-gated vertical architecture is that it may still over-design the system before implementation pressure reveals the right seams. A faster UI/editor-first slice could validate Electron, Vue, CodeMirror, vault I/O, and user workflow sooner, reducing the chance that approved APIs become ceremony that must be revised immediately.

## Tradeoff Tension

Architecture discipline prevents private cross-imports and plugin-host erosion, but too much contract work before a running app delays learning from actual editor/vault/index flow. The revised plan handles this acceptably by choosing API-gated vertical slices rather than pure scaffolding.

## Synthesis Path

Proceed with revised Option A, treat v0 APIs as versioned/experimental where stated, validate them through early vertical slices, and use ADR-backed refinements when implementation pressure reveals better seams.

## Improvement Suggestions

1. Clarify one-way dependency: `data-views` consumes `FieldsAPI`; `fields` should not depend on `data-views`.
2. Consider namespacing/constraining public `EventBusAPI.emit()` before community plugins are enabled.
3. Enforce import boundaries early, not just by review.

Final architectural status: CLEAR.
