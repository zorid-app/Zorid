# Canvas document reference and original model

This is a bounded static investigation of Canvas document loading and data serialization in the supplied Obsidian 1.14.4 desktop artifact. It does not establish rendered Canvas, interaction, history, persistence scheduling, clipboard, file resolution, embedding, export or plugin parity. The reference application was not executed. No recovered code or assets are included in the project.

## Evidence identity and scope

- Artifact: `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js`.
- SHA-256: `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
- Existing REA renderer Evidence E3: `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`; source node `jag_node_621f724371e7aca9238d1f3a97fd54476f29e95749ed28f0e9b6a7f00f7078a2`.
- E3 was reused through `/private/tmp/zorid-reference-20261016/rea-renderer-bundle.json`. Its graph is partial because of the parent result budget. No producer rerun was performed. See [reference-evidence.md](reference-evidence.md) for original coverage and retention limits.
- The findings below are ordinary focused static reading of that digest-bound source, not additional REA semantic or runtime evidence. Ranges are zero-based Unicode character offsets in Python-decoded UTF-8, with an exclusive end. They are not byte offsets or recovered source mappings.

## Observed static paths

| Path / source range | Observation | Boundary |
| --- | --- | --- |
| Canvas view load/save, 3426080–3426510 | Nonempty view text is passed through `JSON.parse` to the Canvas data setter. Empty text takes a placeholder path. View serialization uses a shared JSON formatting helper. | Does not prove how outer view code displays parse failures, recovers files or commits writes. |
| Shared serialization helper, 816070–816900 | The formatter recursively emits JSON with compact primitive objects/arrays and indented nested values. | The original model does not reproduce that formatting algorithm. |
| Canvas get/set/import, 3314200–3316500 | Root fields are retained when constructing the returned object; current nodes and edges replace those arrays. Nodes are emitted in sorted rendering order. Import recognizes text, file, link and group nodes. | Model preserves source array order; rendering order is outside scope. |
| Same import path, 3315200–3316500 | Existing node/edge IDs are looked up in separate maps. Repeated IDs reuse an existing object. New unknown node types are skipped. An edge is imported only when both endpoint nodes exist; a previously existing dangling edge is removed. Missing sides are calculated from geometry. | This is permissive, potentially lossy import behavior, not schema validation. It does not justify claiming malformed files are rejected by the reference. |
| Common node data, 3364300–3365205 | Node output includes ID, x/y, width/height and a truthy color, plus retained unknown data. Loading rounds the four geometry values and ignores resulting NaN values. Color is processed by a helper. | The original document model retains finite fractional coordinates and literal color strings; it does not emulate rendering normalization. |
| Color helper, 3282899–3283065 | A matched RGB form is converted through a color formatter; unmatched strings are returned unchanged. | Exact color normalization is not implemented or claimed. |
| File node, 3379560–3379920 | File data includes type, file path and optional subpath; file setter uses the supplied path/subpath. | No filesystem access or link resolution in the original model. |
| Text node, 3387700–3388040 | Text data includes type and text; setter updates text when its value is a string. | No Markdown rendering in this scope. |
| Link node, 3390680–3391060 | Link data includes type and URL; loading a truthy URL calls the node URL setter. | The document model stores strings without opening or fetching them. |
| Group node, 3395550–3396520 | Group output has type and optional label/background path; non-default background style is included when applicable. Setter also retains data through the common node path. | Original model preserves explicit empty/default values instead of normalizing them away. |
| Edge defaults and data, 3400841–3403350 | Default start/end markers are none/arrow. Output contains ID, endpoint node IDs and sides; non-default ends, truthy color/label, and unknown data are retained. Endpoint changes resolve against the node map. | Original model retains absent sides/ends and explicit values, without computing geometry. |

## Original implementation contract

[`src/canvas/document.ts`](../src/canvas/document.ts) is a standalone JSON data model. It is not wired to a rendered Canvas UI. `CanvasDocument.parse` exposes immutable `nodes`/`edges`, ID lookup, root-field lookup and `toString`. Node/edge add, patch and remove operations, root edits and endpoint-aware node renaming are available to a future integration.

The following are deliberate original choices, not claims of observed reference behavior:

- Unmodified input is returned exactly, including whitespace, line endings and empty input. `{}` and missing arrays remain unchanged while getters expose empty lists. JSON whitespace alone and BOM-prefixed input are rejected by standard JSON parsing. On semantic no-op edits both source and snapshot identities remain unchanged.
- A successful edit serializes the complete JSON object using the detected indent and line-ending convention, preserving whether it ended in a newline. Field values and unknown root/node/edge data remain; original numeric spelling, escape spelling and spacing are not preserved after edits. Standard JavaScript JSON number and duplicate-object-key semantics apply: numbers use binary64, and the last repeated object key wins in the parsed model. Unedited source still remains exact. This is a string model, not a byte decoder for malformed UTF-8 files.
- Root must be an object. Present nodes/edges must be arrays. Node IDs/types must be nonempty strings; geometry must consist of finite numbers. Recognized text/file/link types require string text/file/url respectively; optional known fields must be strings. Color, side, marker and background-style strings are retained verbatim, including future values. Unknown node types remain accessible and serializable.
- Duplicate IDs within nodes or within edges and dangling endpoints reject with `CanvasDocumentError`. A node and an edge may share an ID, and self-loops are accepted. These checks prevent the silent merging or removal suggested by the reference import path.
- Coordinates are not rounded; no positive-size restriction, color conversion, missing side inference, marker default insertion or file/URL validation is invented at the document layer.
- Shallow patches preserve unspecified fields; `undefined` deletes a field if the resulting document is valid. Changing a node ID uses `renameNode`, which rewrites all endpoint references atomically. Removing a connected node requires explicit `{ removeEdges: true }`; otherwise it fails without changing data.
- Edits are staged, validated and serialized before publishing. Failures leave both source and immutable snapshots unchanged. Snapshots and caller inputs never share mutable objects. Plain JSON data is accepted; cyclic values, sparse/named arrays, nonfinite numbers, accessors, conversion hooks, symbols and non-plain objects are rejected. Prototype-like own keys remain ordinary data.

[`tests/canvas-document.test.ts`](../tests/canvas-document.test.ts) verifies unchanged-source roundtrip, all four built-in types plus an unknown type, retained fields after real edits, CRLF formatting, node rename/self-loop behavior, explicit cascading deletion, edge reconnection, empty input, input/snapshot isolation, unsafe values, duplicate IDs, dangling edges and failure atomicity. Validation: `node --test tests/canvas-document.test.ts` (10 passed); `npm run check` passed.

Still unresolved: reference runtime error presentation and recovery, malformed field coercion beyond the inspected setters, node/edge lifecycle interactions, UI ordering, save/history/undo behavior, all rendering, export, embedded files/web content and Canvas plugin integration. This document closes only the original document-model work described above.
