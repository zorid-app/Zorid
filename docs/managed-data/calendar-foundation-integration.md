# Calendar backend foundation integration

Root isolated `calendar-foundation-integration`, base canonical `0ccab450`,
2026-10-18. Scope is the Store evidence API and portable Rust task/Base selection.
No native join, binding, Calendar UI, browser/mobile or sync activation follows.

Ordered original commits: `3882acec`, `cfcdf84d`, `9cdd273e`, `e60718df`.
The last commit corrects only a large fixture to use incremental generation pumps;
it preserves the regression selecting a Base match beyond1,000 unrelated tasks.
Root compared the composed Store files to exact3882 and Bases files to exacte607:
byte-identical. Scoped whitespace check passes. No manifest/dependency/schema/
index/wire change; no root compiler or duplicate test campaign.

Independent reviewer accepts these exact two source scopes and actual results in
`calendar-join-implementation-review.md`. That report remains in progress for
other owners; it does not approve the complete Calendar composition.

Observed logs, read and hashed independently by root:

| Scope | Result | Log SHA256 |
| --- | --- | --- |
| Store actual SQLite `calendar_evidence` | 5/5 pass | `da520036576e624d309603f0905bc4989d0fb965bd0c3e8338c6c24f61f61dfc` |
| Bases Calendar + existing Tasks | 6+11 pass | `dc750c68ee7c10e190ab5c0db8c780b64c05a887ccc7691c292062ecb9dd22ef` |

Logs are `/Users/ctk/orca/workspaces/Zorid/managed-data-foundation/tmp/calendar-store-3882acec.log`
and `/Users/ctk/.local/state/zorid-calendar-task-projection-validation-rerun.log`.
Commands used the existing cached target, jobs1, offline/locked and test-threads1;
details and retained initial fixture failure are in the source-owner reports.

Receipt-only unresolved records now prevent a false global absence claim through
a bounded authorized summary; callers must charge its scan and fence final delivery.
Saved Base selection precedes the task cap, preserving saved filters/order/limit,
clock/zone, immutable links and diagnostics. Existing Task query behavior remains
covered by11 focused cases. This is local observation, not remote completeness.

Next work is the same-lease native join, strict desktop binding, shared Calendar/
Base UI and durable create/link continuation, including authenticated original-
window recovery. They require their own review and one composed actual desktop
pass. Current tests do not establish those behaviors or generic file-date calendars.
