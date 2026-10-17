#ifndef H1E_VOICE_ENERGY_F11A_READER_H
#define H1E_VOICE_ENERGY_F11A_READER_H

#include <stdint.h>

#include "h1e_voice_energy_reply_v2.h"

#ifndef H1E_VOICE_ENERGY_TARGET_BINDING
#define H1E_VOICE_ENERGY_TARGET_BINDING 0
#endif

#if !H1E_VOICE_ENERGY_TARGET_BINDING
#error "The cache reader is emitted only for an explicitly admitted 128-byte target binding"
#endif
#if !defined(H1E_VOICE_ENERGY_PROVIDER_ABI_REVIEWED) || \
    ((H1E_VOICE_ENERGY_PROVIDER_ABI_REVIEWED + 0) != 1)
#error "The cache reader requires the provider ABI/context assertion"
#endif
#if !defined(H1E_VOICE_ENERGY_ASSERT_CONSTRUCTOR128) || \
    ((H1E_VOICE_ENERGY_ASSERT_CONSTRUCTOR128 + 0) != 1)
#error "The cache reader requires the 128-byte constructor assertion"
#endif
#if !defined(H1E_VOICE_ENERGY_ASSERT_DETACH_BEFORE_FREE) || \
    ((H1E_VOICE_ENERGY_ASSERT_DETACH_BEFORE_FREE + 0) != 1)
#error "The cache reader requires the detach-before-free assertion"
#endif
#if !defined(H1E_VOICE_ENERGY_BUILD_ADMITTED) || \
    ((H1E_VOICE_ENERGY_BUILD_ADMITTED + 0) != 1)
#error "The cache reader requires explicit build admission"
#endif

typedef int (*h1e_voice_energy_v1_reply_fn)(void *ctx, uint8_t reply[32]);

/*
 * Take one bounded cache snapshot under the existing guard and encode its
 * 32-byte v2 payload. This function never invokes the provider. It returns the
 * reply status byte (OK/BUSY/UNAVAILABLE), or -1 for a bad output pointer.
 */
int h1e_voice_energy_f11a_reply_v2_read(
    uint8_t reply[H1E_VOICE_ENERGY_REPLY_V2_BYTES]);

/*
 * Dispatch the already-validated saved F11A parse state: 1 delegates directly
 * to the existing v1 response callback; 2 reads/encodes the cache as v2. Other
 * states preserve the existing caller's error path and do not touch reply.
 */
int h1e_voice_energy_f11a_reply_select(
    uint8_t saved_parse_state,
    h1e_voice_energy_v1_reply_fn existing_v1,
    void *v1_ctx,
    uint8_t reply[H1E_VOICE_ENERGY_REPLY_V2_BYTES]);

#endif
