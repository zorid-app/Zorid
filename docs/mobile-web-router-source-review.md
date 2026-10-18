# Portable web-owned mobile router source review

2026-10-18 04:57 UTC. Root delegated exact four-file review to existing reviewer
stage5_enrollment_inventory, after its initial bounded feedback. No edits,
tests, compiler, app or native actions were performed by that reviewer.
Implementation owner TS371, mobile-web-router; root remains sole integrator.

Freeze af3b6538b6cfeeb621f27d7102a9794dc27a8ae9, base a4ee37ea. Reviewer
captured each file once and verified its Git blob hash before review (initially
hash-object IDs had not been stored as objects). Owner later committed identical
files and merged canonical editor guards without changing the component.

| Path | Exact Git blob |
| --- | --- |
| src/platform/mobile-web-routing.ts | c9f6df0c71e5b64ab276e819a7ae9721dd2c692b |
| src/ui/mobile-document-view-window.ts | e84927d5d30f5e9f86cf54bf2b8ec2c2925c7814 |
| src/ui/mobile-web-router.ts | 89263aa9b0b40876914cc4431242dd6936e68ce1 |
| tests/mobile-web-router.test.ts | 465533f61c6317a00e42eee5b7f542b169541b63 |

## Current successor: portable source approved

Exact14e8e250ea8405e320f1f4e2b670576949c58870 closes the remaining reverse
lifecycle overlap. Entire drain flush/publication occupies the common queue;
resume cannot overtake it. Immediate generation/input revocation and source
identity checks remain; closing prevents reactivation during destroy. The same
independent reviewer approves this scoped correction after reading20 passing
cases, without rerunning tests or inspecting unrelated bridge/Workspace changes.
Root also read the actual20/20 log, zero failures/skips.

Root isolated mobile-web-router-2 at6b9aa4d4 composes originalsaf3b6538,
4e7a06cf,14e8e250 onto canonical21cdb4bf. All four source/test files exactly match
approved14e8; no existing platform/Workspace caller is activated. Hash of raw
web-router-portable-drain.log: 18e4b61596034a3fc20819ff3089280b4e5c5e1c460b94f1f382148668cde3e4.
Owner reports fullTS0 including the separate bridge WIP, which is excluded here.
Component tests use controlled host handles, not actual CodeMirror/WebKit views.
The new renderer module/Workspace adapter and actual native lifecycle/gesture
proof remain required; this approval must not be promoted to feature acceptance.

## Previous successor: approval withheld at4e7a06cf

Exact successor4e7a06cfbff42b50162c93a4b2ac7cae22c1d64e fixes the original
held-resume/open/link/new-drain cases. Reviewer read19 passing cases without
rerunning them. Reverse ordering remains: drain waits the old queue but does not
register its own full flush/publication operation in that queue. Hold drain's
host.flush after revocation, then resume; resume can grant A a writer before the
held drain completes, leaving a successful drain acknowledgment with a writer.
Keep resume behind the entire active drain (or reject it), with the reverse-order
regression. Owner notified msg_3d5800bbca89. Same lifecycle finding, no broader audit.

Owner overwrote web-router-portable.log with the19-case successor run. The16-case
hash below records root's earlier observation, not a current immutable raw file.
The successor uses web-router-portable-resume.log; do not claim the overwritten
path still matches the historical hash.

## Original freeze verdict: source approval withheld

P1: router.resume() clears paused and awaits window.resume() outside the route
queue. Window resume captures A and its epoch. Hold A admission, then open B:
B can commit without changing that epoch. When A resumes, its callback updates
the selected B route with A, and restores A writer while currentVisitId remains B.
Serialize resume with navigation and fence overlapping lifecycle/drain. Required
focused regression: held resume A, open B, complete admission; route/runtime/writer
must remain consistent. Sent to owner in Orca msg_26da4aae144d and msg_3179b0f09ce5.

Original strict literal-decoder, fresh-resume-admission and retryable cleanup
findings are corrected in this freeze. Successful document open atomically enters
editor presentation; failed open preserves native presentation. This fixes the
previous undocumented extra presentation command requirement.

The APIs allow correct delivery ordering: dispatch reports the actual committed
fact even if publication fails, and awaited republish retries/rejects until state
is delivered. The native adapter MUST withhold applied result until that delivery
succeeds, retain pending result and never roll back a committed web route. These
are consuming obligations, not proof an adapter already implements them.

Root and reviewer read the actual16/16 pass log at
`/Users/ctk/orca/artifacts/zorid-native-20261018/web-router-portable.log`, SHA256
e0ba33d2790905f2f37ae239aa766e2a187089104b458a4e0c6a5c453d7ec7fa. Owner reports full TypeScript exit0. Those tests did not cover the
new concurrent-resume sequence and do not establish source approval or actual
Workspace, WebKit, keyboard/IME, phone, persistence or live-swipe acceptance.

Next: exact corrected successor plus narrow regression/result, same reviewer;
then root source integration and separately composed adapter/runtime validation.
