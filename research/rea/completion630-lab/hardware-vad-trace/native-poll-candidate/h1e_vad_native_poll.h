/*
 * One-argument replacement for the native getter call at 01020b62.
 * Source candidate only. Not linked into any image, not placed at any address.
 *
 * This header is the only owner of these prototypes.
 */
#ifndef H1E_VAD_NATIVE_POLL_H
#define H1E_VAD_NATIVE_POLL_H

#include <stdint.h>

#include "../fresh-sample-candidate/vadt_binding.h"

/*
 * Same ABI as the original getter at 0101fb68: one uint32_t * in r0, int32_t
 * status back in r0. The caller's pointer reaches the original getter unchanged.
 */
int32_t h1e_vad_native_poll_bridge(uint32_t *native_word);

/*
 * Object loader: NOT DEFINED in this folder, on purpose. Leaving it undefined
 * makes any link of the wrapper fail until a reviewed loader exists. The
 * requirements are in vadt_layout_check.h and vadt_binding.h.
 */
int h1e_vad_load_object(void *ctx, vadt_telemetry_t **tail, uint8_t *native_state);

/* Defined in ../fresh-sample-candidate/vadt_csky_guard.c, C-SKY only. */
uint32_t vadt_csky_guard_enter(void *ctx);
void vadt_csky_guard_exit(void *ctx, uint32_t key);

#endif
