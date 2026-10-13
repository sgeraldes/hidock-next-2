/*
 * Object loader and snapshot reader for the tentative f11a command.
 * Source candidate only. The build gate and its warning are in
 * h1e_vad_native_loader.h.
 *
 * The loader is called by vadt_binding_read and vadt_binding_poll inside the
 * caller's guard. It keeps no object pointer in any static or global, calls no
 * getter, no clock and no allocator, and never writes the object.
 */
#include "h1e_vad_native_loader.h"

#ifndef H1E_VAD_SLOT_READ
#define H1E_VAD_SLOT_READ() (*(volatile uintptr_t *)(uintptr_t)H1E_VAD_SLOT_ADDRESS)
#endif
#ifndef H1E_VAD_GUARD_ENTER
#define H1E_VAD_GUARD_ENTER vadt_csky_guard_enter
#endif
#ifndef H1E_VAD_GUARD_EXIT
#define H1E_VAD_GUARD_EXIT vadt_csky_guard_exit
#endif

/*
 * Returns 0 and fills *tail and *native_state only for a non-NULL, non-wrapping,
 * aligned base. Any other case returns 1 with *tail NULL and *native_state 0.
 *
 * The order is fixed: read the slot once, reject NULL, reject a base whose
 * 0x60-byte extent would wrap, reject a misaligned object+0x40, and only then
 * read the native state byte at object+0. The telemetry words are never touched
 * here. The state byte is returned as it is. Its value is not a readiness or
 * lifetime signal.
 */
int h1e_vad_load_object(void *ctx, vadt_telemetry_t **tail, uint8_t *native_state)
{
    uintptr_t base;

    (void)ctx;
    *tail = NULL;
    *native_state = 0u;

    base = (uintptr_t)H1E_VAD_SLOT_READ();
    if (base == 0u) {
        return 1;
    }
    if (base > H1E_VAD_BASE_MAX) {
        return 1;
    }
    if (((base + H1E_VAD_TAIL_OFFSET) % H1E_VAD_TAIL_ALIGN) != 0u) {
        return 1;
    }

    *native_state = *(const volatile uint8_t *)base;
    *tail = (vadt_telemetry_t *)(base + H1E_VAD_TAIL_OFFSET);
    return 0;
}

static const vadt_binding_ops_t h1e_vad_snapshot_ops = {
    NULL,
    H1E_VAD_GUARD_ENTER,
    H1E_VAD_GUARD_EXIT,
    h1e_vad_load_object
};

/*
 * Fills all VADT_REPLY_SIZE bytes of reply and returns reply[0]. ctx is ignored
 * (NULL from the native response route). One guarded snapshot, then the reply is
 * formatted after the guard is restored. No DSP getter, no clock.
 */
vadt_status_t h1e_vad_snapshot_read(void *ctx, uint8_t reply[VADT_REPLY_SIZE])
{
    (void)ctx;
    return vadt_binding_read(&h1e_vad_snapshot_ops, reply);
}
