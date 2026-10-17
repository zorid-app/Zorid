# Portable derived index: initial slice

Local source/index identities, namespace witnesses, publication-CAS preconditions
and deterministic link resolution. No storage, clock, network, body-loading query
API or host dependency. Pure fence success is not durable publication: hosts
must atomically compare source/index heads and write generation rows/head.

See docs/stage4-index-contract.md for the frozen contract. The crate depends on the root-frozen zorid-document projection type; root must
compose that metadata crate before compilation. Metadata-dependent generation
plans/literal queries follow when its concrete source-witness fields are ready. This slice supplies no substitute parser, persistence adapter
or completed full index. Namespace witnesses are not content-byte proofs.

Fixtures are executable source, not yet run: mobile owns the heavy build slot.
Root owns Cargo.lock resolution and combined native/WASM validation.

Resolver accepts the currently frozen percent-only destination input. CommonMark
entity/escape handling versus literal wiki targets is pending the root-owned
metadata decoded-target seam decision; no replacement Markdown URL parser exists.
