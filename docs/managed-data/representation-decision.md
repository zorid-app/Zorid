# Record representation decision for the portable source slice

Status: provisional implementation choice under independent review. No production
storage or encrypted family integration approved by this document.

The user requested one shared Rust core and encrypted infrastructure, with reuse
of suitable established implementations. The existing Yrs text engine remains
authoritative for note bodies; this work does not replace or relax it. The
structured feasibility probe evaluated Yrs first. It demonstrated independent
field merge, but also whole-object and parent-map collision losses. Scalar Y.Map
arbitration supplies a winner, not an application-visible recoverable conflict
history or schema/namespace policy.

Two feasible record representations were compared:

| Choice | Reuse | Additional required behavior |
| --- | --- | --- |
| Per-generation Yrs maps plus retained authored history | Existing Yrs update format, dependency/duplicate handling | Typed operation admission, stable operation identity, observed-tag authorization, explicit delete/restore policy, history preservation, conflict candidate extraction, and consistency between map winners and authored history |
| Retained typed immutable operations with causal projection | Existing core's authored-intent/receipt patterns; standard set union and deterministic causal projection in Rust | Explicit graph/pending validation, capacity/backpressure, replay/codec admission, causal candidate and set/delete semantics, independent convergence/counterexample tests |

The source slice implements the second as its single internal authority. It
avoids storing a winner-only Yrs field map alongside a second authoritative
history graph whose current candidate policy can differ. It does not assume that
an immutable operation log makes all application invariants converge: duplicate
ID equivocation, invalid causal/tag references and over-capacity unions fail
explicitly without dropping authored data. Fields expose concurrent candidates;
operation-ID ordering is only a deterministic display winner.

This is new domain merge code and must be reviewed as such. It is not justified
solely by the fact that the plan does not mandate Yrs. The exact source and its
independent adversarial tests must demonstrate causal correctness and bounded
resources before acceptance. If Yrs plus history proves simpler or safer under
that review, retain the accepted operation/domain contract and change the
encoding/implementation rather than ship redundant authorities.

There is no independent feature sync engine here: no network, polling, encryption,
server route, outbox, cursor, durable storage, secret handling or scheduling. The
later native/browser adapters must use the existing shared ledger and relay with
a separately reviewed records payload family. Their acceptance still requires
crash-safe authored-state/outbox and incoming-state/shared-cursor commits, local
and cache exclusion, subscriptions, actual cross-client encrypted delivery and
restart. Passing portable tests cannot establish those properties.

Pending dependency activation failure needs an explicit dispatcher quarantine or
recovery policy before wire integration. Rejecting a newly arriving parent while
retaining an earlier invalid pending descendant is an in-memory safety outcome,
not a complete live-sync liveness policy. It must not silently advance a cursor,
discard the descendant, or leave an unobservable permanent head-of-line block.
Retained-history capacity similarly requires observable backpressure now and
safe history externalization/compaction before representative long-lived data.
