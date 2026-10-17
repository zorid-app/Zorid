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
void zorid_mobile_buffer_free(ZoridBuffer);
void zorid_mobile_close(MobileSession *);
#endif
