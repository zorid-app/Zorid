# Historical snapshot: root-next-assignments.md

Superseded on 2026-10-21. This preserves the committed source at
[`e7d655e1`](https://github.com/zorid-app/Zorid/blob/e7d655e1d807769840b9d87c9d63dc7a9b70c29d/docs/managed-data/root-next-assignments.md),
original path `docs/managed-data/root-next-assignments.md`. SHA-256 of the verbatim fenced source:
`3641eca4438f3fb61cbcb32416422f8591233e46e29dcaec7a672e550b48ce0e`.

For current Bases work use the [implementation goal](../plans/bases-implementation-goal.md).
For later Tasks, Calendar, providers and mobile use the [roadmap](../roadmap.md).
The following snapshot is evidence only; its assignments, named Types and delivery
order are superseded. Relative paths inside the fence belong to the original path.

``````markdown
# Root next source assignments — 2026-10-18 05:24 UTC

The accepted order remains Vite (delivered), Bases/Tasks/Calendar, then Stage5.
Main8e8732ea includes reviewed browser WorkBlocks and bounded recovery helpers;
neither proves the remaining UI/provider/mobile requirements. Root is sole main
integrator. All source changes stay isolated until scoped review/verification.

| Owner | Isolated worktree/branch | Scope | Dependencies and acceptance |
| --- | --- | --- | --- |
| Root internal browser_task_queries | browser-task-queries, being created from main8e8732ea | WASM document_index plus focused tests; browser-document-index and additive task dispatch hunks only | Freeze exact API/path inventory first. Reuse DocumentPin.tasks and native Rust query semantics, same pinned generation/Type witnesses, bounds/diagnostics/date-only/owner expiry. No WorkBlock/Calendar/Workspace changes. Source only until coordinated actual WASM/browser slot. |
| Root internal type_configuration | type-configuration, being created from main8e8732ea | New src/types controller/view/CSS; narrow lossless tasks/types-document methods if needed | Freeze API/hunks first; stable labels/defaults/IDs, invalid-source preservation, stale form retention. No destructive schema/remapping. Workspace launch remains separate named seam; no GUI claim from controller checks. |
| TS371 / term_c8bf385c | mobile-web-router | Final bridge ID fingerprint admission; new-capability Workspace/bootstrap/live editor window | Recovery helper now canonical8e8732ea; passive host212/router9e4. Changed in-flight payload gets no handler/result task; original sole receipt. Independent reviewers reused. |
| Native lead / term_d8fdd76f | native-web-routing, a0722ade checkpoint | Retained root/physical presentation, reviewed Pages plus service/PBX registration | Paired service wire and Workspace ready before activation; c6 source delta review. No iOS build before explicit shared slot. Dev19 remains actual phone version. |
| Managed lead / run_7a10da5526b5 | Existing isolated Calendar/UI/Store branches | Calendar GUI driver correction, source-frozen SQLite origin-intent validation, plan reconciliation | Current bounded cached Rust then reviewed Electron retry; root launches no overlapping compiler/app. UI failures retain raw evidence; no Calendar GUI pass inferred. |

Independent root inventory review identified browser task queries and Type
label/default authoring as useful unblocked source work. Recurrence identity,
timer allocation, checkbox replacement/undo, provider-mirror coordination and
browser secrets need their own settled semantics. Base creation/views/formulas,
generic calendar sources, time entries, Google two-way and native Tasks/Calendar
remain required; the first WorkBlock slice does not close them. Spaced repetition
was removed by user instruction and must not reappear as a deferred milestone.

For current integrated evidence use deferred-product-roadmap.md and per-feature
integration notes. Managed execution/duplicate plan reconciliation has its own
named docs-only owner; do not overwrite it with this assignment snapshot.
``````
