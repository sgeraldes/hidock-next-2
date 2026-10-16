/*
 * F11A-only bridge for the 393990 console.
 *
 * The pinned console-hooks.S calls console630_parse/response. F11A is handled
 * by the existing VAD frame adapter; every other valid frame is delegated to
 * the exact current 393990 parser/response entry point. No console behavior is
 * copied into this module.
 */
#include <stdint.h>

#include "h1e_vad_snapshot.h"

#if defined(H1E_F11A_DISPATCH_HOST_TEST)
#if defined(__csky__)
#error "host seams replace target addresses and must never be selected for C-SKY"
#endif
#include "f11a_dispatch_host_seams_testonly.h"
#define H1E_F11A_RESOLVE(word) f11a_test_resolve(word)
#define H1E_CURRENT_PARSE(frame, body, length) \
    f11a_test_current_parse((frame), (body), (length))
#define H1E_CURRENT_RESPONSE(frame) f11a_test_current_response((frame))
#else
#if !defined(__csky__)
#error "the production dispatcher uses C-SKY addresses; host tests require H1E_F11A_DISPATCH_HOST_TEST"
#endif
extern int console630_parse_current(uint8_t *frame, const uint8_t *body, uint32_t length);
extern int console630_response_current(uint8_t *frame);
extern int vadt_f11a_parse(uint8_t *frame, const uint8_t *body, uint32_t length);
extern int vadt_f11a_response(uint8_t *frame, vadt_f11a_read_fn read, void *read_ctx);
#define H1E_F11A_RESOLVE(word) ((uint8_t *)(uintptr_t)(word))
#define H1E_CURRENT_PARSE(frame, body, length) \
    console630_parse_current((frame), (body), (length))
#define H1E_CURRENT_RESPONSE(frame) console630_response_current((frame))
#endif

static uint32_t load_le32(const uint8_t *bytes)
{
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) |
           ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

int console630_parse(uint8_t *frame, const uint8_t *body, uint32_t length)
{
    uint8_t *head;
    uint32_t command;

    if (frame == NULL) {
        return -1;
    }

    head = H1E_F11A_RESOLVE(load_le32(frame + 0x14u));
    if (head == NULL) {
        return -1;
    }
    command = ((uint32_t)head[2] << 8) | (uint32_t)head[3];
    if (command == 0xf11au) {
        return vadt_f11a_parse(frame, body, length);
    }

    return H1E_CURRENT_PARSE(frame, body, length);
}

int console630_response(uint8_t *frame)
{
    if (frame == NULL) {
        return -1;
    }
    if (load_le32(frame + 0x18u) == 0xf11au) {
        return vadt_f11a_response(frame, h1e_vad_snapshot_read, NULL);
    }
    return H1E_CURRENT_RESPONSE(frame);
}
