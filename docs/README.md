# Zorid documentation

Start with the [architecture overview](architecture/README.md): platforms and
rendering first, then the shared Rust systems and their storage boundaries.

| Documentation | Purpose |
| --- | --- |
| [Roadmap](roadmap.md) | Maintained milestone order, scope and exit gates; storage first |
| [Architecture](architecture/README.md) | Maintained explanation of how the application fits together |
| [Platform setup](platforms.md) | Development entry points and build boundaries |
| [Current decisions](architecture/decisions.md) | Accepted direction, implementation gaps and delivery sequence |
| [User findings](user-findings.md) | Requests and bugs, with implementation and verification tracked separately |
| [Execution checkpoint](deferred-product-roadmap.md) | Cross-session ownership and integration record; not the architecture manual |
| [Reference evidence](reference/README.md) | Historical behavior audits and comparisons |
| [Implementation history](history/README.md) | Dated implementation, integration and validation reports |
| [Managed-data work](managed-data/) | Detailed contracts, implementation records and acceptance evidence |
| [Mobile work](mobile/) | Detailed native-platform records |
| [Verification artifacts](verification/) | Retained evidence for specific source/runtime checks |

## Keeping the documentation clean

Architecture pages describe responsibilities, boundaries, data flow and important
tradeoffs. Each platform/system has its own file. They distinguish **Current**
source behavior from **Accepted direction** that is not yet implemented.

Keep transient worker IDs, build logs, commit-by-commit updates and test counts in
execution/history records. Architecture pages link to evidence instead of becoming
execution diaries. Update the relevant architecture module when changing a boundary;
update decisions when the direction changes. Do not copy a whole overview into
feature documents.

New reference audits belong in `reference/`; checkpoint and acceptance reports
belong in the feature's existing folder or `history/`. Some older files remain at
the documentation root because live contracts, source comments and coordination
records address those paths. Their presence does not make them current architecture.
[The relocation map](history/relocations.json) resolves the moved historical paths;
external session messages may still mention an old path.
