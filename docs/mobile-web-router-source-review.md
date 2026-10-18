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

## Verdict: source approval withheld

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
