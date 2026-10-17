#ifndef ZORID_MOBILE_H
#define ZORID_MOBILE_H
#include <stddef.h>
#include <stdint.h>
typedef struct MobileSession MobileSession;
typedef struct { uint8_t *data; size_t len; } ZoridBuffer;
MobileSession *zorid_mobile_open(const char *root, ZoridBuffer *error_out);
ZoridBuffer zorid_mobile_request(MobileSession *, const uint8_t *, size_t);
ZoridBuffer zorid_mobile_startup(MobileSession *);
ZoridBuffer zorid_mobile_refresh(MobileSession *);
void zorid_mobile_buffer_free(ZoridBuffer);
void zorid_mobile_close(MobileSession *);
#endif
