#ifndef ZORID_MOBILE_H
#define ZORID_MOBILE_H
#include <stddef.h>
#include <stdint.h>
typedef struct MobileSession MobileSession;
typedef struct { uint8_t *data; size_t len; } ZoridBuffer;
/* All calls on a session (including buffer frees) are serialized by the native
 * shell. Drain accepted work before close; never drop a session concurrently.
 * Returned buffers are Rust-owned exact slices, freed exactly once below. */
MobileSession *zorid_mobile_open(const char *root, ZoridBuffer *error_out);
ZoridBuffer zorid_mobile_request(MobileSession *, const uint8_t *, size_t);
/* Raw startup JSON: reconciliation plus optional documentSemantics:true for the
 * new compiled host. Absence in older binaries keeps native Documents disabled.
 * Generic admitted request frames carry Documents; there is no Documents ABI. */
ZoridBuffer zorid_mobile_startup(MobileSession *);
ZoridBuffer zorid_mobile_refresh(MobileSession *);
/* Trusted native-only fixture authority; NEVER register these as JS methods.
 * Byte pointers must remain readable for their stated lengths through the call.
 * Nonempty UTF-8, no embedded NUL: root/config <=4096 bytes; canonical UUID client.
 * root/config must be absolute. error_out must be writable and non-aliasing.
 * Success: session, empty error_out. Failure: NULL, owned version-1 JSON error.
 * Existing prepared scope only: no enroll/rebind or local fallback. */
MobileSession *zorid_mobile_open_fixture(
    const uint8_t *root, size_t root_len,
    const uint8_t *persisted_client_id, size_t client_id_len,
    const uint8_t *credentials_path, size_t credentials_path_len,
    ZoridBuffer *error_out);
/* Fixture result/error envelope is owned UTF-8 JSON <=64KiB:
 * {"version":1,"ok":true,"result":...} or {"version":1,"ok":false,"error":...}.
 * A known host error retains the session; panic/terminal transport failure fences
 * it and returns empty. Empty output requires reopening with retained identities.
 * No hard cancellation: drain an active call before free/close. */
ZoridBuffer zorid_mobile_fixture_status(MobileSession *);
ZoridBuffer zorid_mobile_fixture_once(MobileSession *, uint32_t max_push, uint32_t max_pages);
/* Native-only staged import: NEVER register as JS/plugin commands. No physical
 * source path is accepted. Shell copies provider data to immutable app staging,
 * persists selection before begin, and keeps it on uncertain/empty responses.
 * Borrowed fd remains open through begin; Rust atomically duplicates CLOEXEC and
 * owns ONLY that duplicate. Positional reads do not change caller file offset.
 * -1 can recover an EXISTING sealed/terminal binary stage or retained text intent
 * without its source copy. New/receiving imports require a regular-file fd.
 *
 * selection: <=8192 readable UTF-8 JSON bytes, deny unknown fields:
 * {"version":1,"clientId":"canonical UUID","localStoreId":"canonical UUID",
 *  "leaseToken":"current exact native admission token UUID",
 *  "operationId":"canonical UUID","entryId":"canonical UUID",
 *  "destinationFolder":"","fileName":"photo.heic","kind":"auto",
 *  "expectedLength":"123","sha256":"64 lowercase hexadecimal characters"}
 * Folder/path is LOGICAL vault-relative only; empty folder selects vault root.
 * kind auto|text|binary: auto uses existing Rust UTF8/NUL/extension policy. Native
 * UI must use auto by default; explicit binary is a deliberate native choice.
 * Editable text <=262144 bytes; binary <=67108864; no silent text downgrade.
 * Same host must ALREADY have exactly one matching admitted consumer. Each job
 * binds its exact token/generation and every operation rechecks that admission.
 * On restart reacquire SAME store/client and replace only ephemeral leaseToken;
 * it is not part of the persisted import identity. Preserve all other fields.
 *
 * Every result/error is owned UTF-8 JSON <=64KiB, free exactly once:
 * {"version":1,"ok":true,"result":{"operationId":"...","state":"hashing",
 * "processedBytes":"0","totalBytes":"123","selectedPath":"photo.heic",
 * "commitState":"not_requested","projectionState":"not_started",
 * "canRetryCollision":false}}
 * or {"version":1,"ok":false,"error":{"code":"...","commit_uncertain":true}}.
 * state: hashing|receiving|sealed|commit_requested|committed|collision|aborted.
 * commitState: not_requested|requested|committed|rejected|aborted.
 * projectionState: not_started|pending|projected. Pending projection is COMMITTED.
 * selectedPath is native-only logical display/recovery data, not a physical URL.
 * Hash/append steps read <=128KiB; text may retain its bounded 256KiB body.
 * Only definitive collision+canRetryCollision permits fresh persisted op/entry
 * UUIDs. Unknown/IO/empty/commit_uncertain keeps original IDs; begin resumes them.
 * Cancel after commit intent reports requested/finishing, never rollback.
 * Malformed pointers are caller UB; null/length/schema/invalid fd errors are
 * bounded and nonterminal. Empty response is terminal and fences/drops leases.
 * Serialize all calls/free/close on the same queue; drain before close. */
ZoridBuffer zorid_mobile_import_begin(MobileSession *, int32_t borrowed_fd,
    const uint8_t *selection, size_t selection_len);
ZoridBuffer zorid_mobile_import_step(MobileSession *, const uint8_t *operation_id, size_t operation_len);
ZoridBuffer zorid_mobile_import_status(MobileSession *, const uint8_t *operation_id, size_t operation_len);
ZoridBuffer zorid_mobile_import_cancel(MobileSession *, const uint8_t *operation_id, size_t operation_len);
void zorid_mobile_buffer_free(ZoridBuffer);
void zorid_mobile_close(MobileSession *);
#endif
