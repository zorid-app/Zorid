# Versioned protobuf sync mapping — proposal only

Owner: `/root/protobuf_schema_sol`, isolated branch
`tingkai-c/protobuf-schema-foundation`. Source baseline: foundation `ef6e058` +
`272e6e1`, corrected lock `d67676f`; production source inspected at main
`67d70f1`. This document defines a reviewable next slice, not frozen IDL or
permission to alter runtime codecs. No `.proto`, generated file, crypto, client,
relay or transport implementation changes accompany it.
Independent read-only review passed for mapping accuracy and evidence scope; root
version, parser/resource policy and implementation approval are still pending.

## Recommended slice and version boundaries

First map authenticated plaintext for files and Text to typed protobuf, retaining
ZSE1 framing, its existing JSON header and exact-header AEAD AAD. Keep the relay
opaque to decrypted families. Header replacement is a separate cryptographic
framing change and should not be bundled merely because a protobuf schema exists.

The independent transport owner proposes Hello/Append/Pull RPC wrappers under a
new transport major 2 while preserving exact ZSE1 envelope bytes. That transport
proposal and this plaintext proposal fit together, but neither activates the
other. The actual gRPC-Web proof passed; production service ownership and protocol
review remain separate. No transport/service declarations are frozen here.

| Axis | Current value | Proposed next value / rule |
| --- | --- | --- |
| Relay carrier/control major | 1, HTTP/JSON | 2 if typed RPC control is adopted by root; coordinate with RPC owner |
| Envelope/frame/header | ZSE1, envelope 1, JSON header | Keep exactly as is for this slice |
| Authenticated document codec | Header document_format_version 1 | 2 explicitly means typed protobuf plaintext; reject unsupported before application/cursor advancement |
| Protobuf schema package | No sync package | `zorid.sync.payload.v1`; this names the IDL, not the old JSON document codec |
| Files semantic payload | JSON files format 2 | Explicit new files format 3; preserve domain event semantics |
| Text semantic payload | JSON text format 2 | Explicit new Text format 3; retain raw Yrs update format/validation |
| Local metadata/store schema | Independently versioned | Any affected persisted codec/descriptor schema change is independently reviewed; do not infer from wire format |

The proposed numbers require root approval before schema tags/constants are
committed. A fresh coordinated format on disposable fixtures is acceptable; no
migration or deletion of real vault data is authorized. Do not add production
compatibility layers serving obsolete development fixtures. Do not trial-decode
protobuf under document format 1, or JSON under document format 2.

## Typed plaintext messages

Use a single typed `SyncPayload` routing oneof: Files or Text. Include an explicit
schema version and repeated `required_features`. Each family has its explicit
new format version. Remove redundant string family discriminators once the
oneof is selected; do not store JSON objects or JSON byte strings inside protobuf.
Only the standard generator encodes/decodes these messages.

| Proposed type | Fields | Existing source / validation retained |
| --- | --- | --- |
| SyncPayload | schema_version, required_features, oneof files/text | Known schema, supported required features, understood nonempty decoded routing choice |
| FilePayload | format_version, Scope, update_id, oneof events/observed_delete/page/chunk | files-v2 Payload semantics; scope/update agree with independently expected authenticated header |
| EntryEvents / ObservedDelete | repeated EntryEvent | Nonempty bounded batches; observed-delete remains distinct and only contains unique-entry Delete events |
| EntryEvent | id, EntryIdentity, repeated parents, oneof effect | Identity/bootstrap linkage, distinct IDs, parent bounds/ancestry/antichain rules unchanged |
| Create | EntryKind, Location, optional ContentSeed | Folder has no content, File has exactly one valid immutable Binary/Text seed |
| SetContent | Manifest | Binary only; whole file manifest invariants remain |
| Move / Restore | Location | Parent identity and single validated vault name, not a physical path witness |
| Delete | empty marker | Explicit known oneof choice, never inferred from missing effect |
| Location | optional parent_entry_id, name | Absent parent denotes root; present empty ID is invalid |
| ContentSeed | oneof Binary manifest / Text binding | Immutable mode; Text binding carries text_bootstrap_id and text_format; no conversion between modes |
| ChunkPage | repeated ChunkRef | Existing common.v1 messages; bounded nonempty chunk refs and distinct dependency rules |
| Chunk bytes | raw bytes | 1..128 KiB; empty file is represented by an empty Manifest, not an empty chunk |
| TextPayload | format_version, TextIdentity, TextNamespaceContext, ActorRegistration, update bytes | Namespace-aware v2 semantics retained; no large Text framing or limit increase |
| TextIdentity | realm_id, vault_id, entry_id, bootstrap_id | Same immutable document identity; matching path/text never establishes ancestry |
| TextNamespaceContext | bootstrap_id, repeated parents | Namespace bootstrap distinct from Text bootstrap, sorted bounded canonical frontier and graph admissibility |
| ActorRegistration | actor uint32, ActorOwner | Existing collision/ownership checks, including legitimate zero actor value |
| ActorOwner | replica_id, incarnation_id | Declared replica identity, not a device signature or authentication capability |
| Yrs update | raw bytes | Preserve CRDT's own existing binary framing; no base64, JSON arrays, or new CRDT encoding |

IDs/revisions remain case-sensitive validated strings. Sizes and sequence/cursor
values use uint64 (`u64`/`bigint`), not JS number. Use optional scalar presence where
absence has meaning and oneofs where variants are exclusive. All unspecified or
unknown semantic enums, missing routing/effect choices, missing mandatory message
values, invalid digests, unsupported family formats and unknown required features
fail before graph planning, visibility, outbox eligibility or cursor advancement.

Do not route generated structs through a public constructor for AuthenticatedText,
AuthenticatedPayload, TextActivity, VerifiedManifest, MetadataCandidate, a sealed
stage or any filesystem proof. Domain codec modules must bind validated semantic
messages to the original authenticated bytes internally. In particular, converting
protobuf to JSON and feeding a JSON decoder must not manufacture authentication or
substitute bytes for an exact-payload commitment.

## Distinct commitments and byte ownership

Preserve these four meanings instead of hashing whichever message is convenient:

- ChunkRef.digest hashes raw chunk bytes. Manifest.digest hashes concatenated raw
  file bytes. File size remains the existing initial 64 MiB format cap.
- PageRef.digest is the existing domain ChunkPage commitment, currently produced
  by `ChunkPage::reference` over its bounded JSON domain representation. Preserve
  that value verbatim in the initial codec slice. Do not silently redefine it as
  a protobuf page hash. Changing this domain commitment needs its own format/test
  decision; it is not required to eliminate large JSON byte arrays.
- Exact payload length/hash bind the original accepted encoded plaintext,
  including its encoding/version and otherwise ignored fields. Metadata summaries
  derive during authenticated bounded decoding and bind to the immutable ledger
  in the same transaction. A digest alone does not prove a checked summary.
- The exact original header bytes remain AEAD AAD, and exact envelope/ciphertext
  bytes remain the persisted replay/dedupe value. Retain them; never rebuild them
  by semantic re-encoding. Outbox retries reuse the original sealed bytes and
  update ID after an uncertain acknowledgement rather than encrypting again.

Protobuf deterministic serialization is not canonical. Rust and TS may retain or
discard unknown fields differently; neither behavior permits reconstruction of
accepted authenticated bytes. If a future envelope-2 replaces JSON headers, either
retain its exact encoded header bytes as AAD or separately specify/review an AAD
format independent of protobuf encoders. An outer message may carry `header_bytes`
as raw bytes for that purpose; an embedded parsed Header must not be re-encoded
to recover AAD. No new crypto suite/primitives are proposed.

## Explicit capability and ingress gates

Coordinate exact discovery fields with the RPC owner before IDL implementation:

1. Clients select authorized server/realm/vault/epoch independently of input.
   Discovery must explicitly advertise the selected transport major, envelope
   versions, accepted document codecs and exact bounded policies. A missing or
   incompatible capability blocks upload/receive. Do not infer protobuf support
   from successful gRPC, a content type, or an unknown optional extension.
2. Document format 2 selects only the new plaintext decoder. Unsupported format,
   envelope, required feature, server epoch or scope fails before ingestion and
   cursor advancement. Required feature lists accumulate required semantics; an
   unknown feature is not ignored simply because the message otherwise parses.
3. Bound the framed body before allocation/decode. Keep MAX_HEADER_BYTES 4096 and
   MAX_PLAINTEXT_BYTES 1 MiB unless separately reviewed. Count events/parents/page
   refs/chunks after bounded decode and before graph validation. This post-decode
   check does not bound allocations made by the decoder itself; see the resource
   policy gate below.
   The plaintext wrapper's overhead counts against its cap. Preserve transport
   total-page byte/item caps independently of individual envelope limits.
4. Decrypt/authenticate exact header and ciphertext; validate scope/update/epoch
   against the independently selected expected context; decode and validate the
   known family; validate the entire graph/CRDT plan and every retained complete
   binary manifest required by the accepted streaming contract before committing.
5. Store exact incoming bytes plus checked metadata/provenance atomically with
   receive accounting. Duplicate identity with different exact bytes still fails.
   Pending dependencies and corrupt/missing backing chunks remain distinct states.
   A parsed receipt is not proof of durable remote acceptance; bind it to the
   authenticated server/channel and exact vault/update/epoch target.

Do not substitute a metadata-only graph, an empty body, per-chunk hashes alone,
a caller manifest or a stored boolean for the private verification capabilities.
Worker transfers can carry existing Uint8Arrays without another JS-to-JS codec
pass. Local command receipts and remote relay acknowledgements remain different
models even if both are protobuf messages.

## Parser-policy decision required before implementation

Current JSON decoders reject unknown and duplicate fields. Standard protobuf
parsers support unknown fields and have defined merge/last-value behavior for
repeated occurrences of singular fields and oneofs. Prost does not preserve
arbitrary unknown fields like protobuf-es does. This is a material protocol choice,
not an implementation detail silently covered by the current DTO tests.

Recommendation for root review: use the standard protobuf wire semantics in an
explicit new format, enforce known version/required-feature gates and all domain
invariants on the decoded result, retain original authenticated bytes, and add
cross-runtime adversarial fixtures before activation. New meaning that older
clients must understand always requires a recognized feature or format bump;
unknown fields are informational only. Repeated required_features must accumulate
rather than let a later empty field erase an unsupported feature. If strict
rejection of all unknown tags/duplicate singular fields remains required, evaluate
a standard schema-aware decoder/validation option explicitly before implementation;
do not invent a parallel handwritten protobuf codec or claim Prost alone supplies
that guarantee.

For the recommended standard-parser policy, fail-closed means an absent known
route/effect or unsupported required feature/version is rejected. It does NOT
mean an old decoder can identify every unknown oneof tag: a mixed known+unknown
variant may leave the known case selected after the unknown tag is skipped, in
either tag order. Every newly introduced route/effect with required semantics
must therefore mandate a recognized feature or new format before execution.
If root instead requires rejection of every unknown variant tag even when a
known variant coexists, that stronger policy needs an explicitly selected standard
schema-aware validator; Prost-generated messages alone cannot enforce it.

Decoder resource policy is also unresolved: a 1 MiB wire cap permits many tiny
or empty repeated messages, and generated decoders can allocate their collections
before domain count checks run. Before activation, root must freeze bounded
in-flight decoding plus allocation/collection/depth budgets and select a standard
decoder or schema-aware validation mechanism that enforces the required limits.
Do not claim post-decode checks prevent decoder allocations. Adversarial fixtures
must measure memory/time for maximal empty-message repetition, packed scalars,
nested messages and large unknown fields in both pinned runtimes. Successful
small fixtures are insufficient; a wire cap alone is not an allocation budget.
No custom scanner or new validation dependency is authorized by this proposal.

Root must explicitly choose this parser/resource policy and confirm the capability/version
assignment. Until then, the schema remains a mapping proposal. No dependency for
reflection or a custom binary scanner is approved by this document.

## Proposed ownership and acceptance gate

After root approval, assign separate named ownership for generated IDL/common
semantic converters; file/Text codecs and crypto routing; immutable Store ledger
admission; native/browser/CLI adapters; and the selected remote carrier. Coordinate
codec-independent streaming/Store commits first and serialize integration/checks.
No worker changes another owner's domain/private-proof types to fit a wire DTO.

Minimum coherent checks for the codec slice:

- Rust/TS byte fixtures for each body/effect/content variant, absent versus zero
  values, uint64 edges, bytes and required features; assert semantic conversion and
  exact-byte ledger commitments independently. Verify the selected decoder's
  allocation/count/depth limits and bounded concurrent decode behavior under the
  adversarial amplification cases above. Test unknown/duplicate tags under
  the selected policy, including mixed known/unknown route and effect tags in
  both tag orders, and malformed/truncated/oversized messages before activation.
- Authentication/context/format rejection, no cross-family trial decoding, exact
  byte dedupe mismatch, same update ID changed bytes, unknown required feature
  followed by an empty list, and retained original AAD despite alternate valid
  field ordering/unknown optional fields. A decode/re-encode must never be needed
  for hash/AAD verification.
- Existing missing-dependency, hidden/history manifest whole-hash, actor/namespace,
  convergence, uncertain receipt/outbox retry and crash tests using fresh explicit
  protobuf fixtures, not just the generated codec's encode/decode unit tests.
- Actual browser, Electron and independent CLI send/receive after the same
  reviewed codec+carrier batch; receipt/cursor atomicity and failure preservation.
  Source tests do not establish native/mobile/runtime parity.

This proposal does not add P2P, recovery/admin APIs, plugin frameworks, calendar
features, large Text framing, migration machinery or a mandatory local daemon.

Primary sources checked 2026-10-17:
[Protobuf encoding/merge semantics](https://protobuf.dev/programming-guides/encoding/),
[proto3 presence and oneofs](https://protobuf.dev/programming-guides/proto3/),
[serialization is not canonical](https://protobuf.dev/programming-guides/serialization-not-canonical/),
[Prost representation](https://github.com/tokio-rs/prost).
