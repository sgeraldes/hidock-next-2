#ifndef H1E_VOICE_ENERGY_POLL_ADAPTER_H
#define H1E_VOICE_ENERGY_POLL_ADAPTER_H

#include <stdint.h>

#include "../../hardware-vad-trace/native-poll-candidate/h1e_vad_native_poll.h"
#include "h1e_voice_energy_cache.h"

/*
 * The sampled path and target binding remain disabled by default. Enabling the
 * target binding requires explicit provider ABI/context, 128-byte constructor,
 * detach-before-free, and build-admission assertions. These macros are build
 * assertions only; they do not establish those facts. Source routing,
 * microphone response, freshness and voice semantics remain unknown.
 */
#ifndef H1E_VOICE_ENERGY_POLL_ENABLED
#define H1E_VOICE_ENERGY_POLL_ENABLED 0
#endif

#ifndef H1E_VOICE_ENERGY_TARGET_BINDING
#define H1E_VOICE_ENERGY_TARGET_BINDING 0
#endif

#if H1E_VOICE_ENERGY_TARGET_BINDING && !H1E_VOICE_ENERGY_POLL_ENABLED
#error "The target binding requires H1E_VOICE_ENERGY_POLL_ENABLED=1"
#endif
#if H1E_VOICE_ENERGY_TARGET_BINDING && \
    (!defined(H1E_VOICE_ENERGY_PROVIDER_ABI_REVIEWED) || \
     (H1E_VOICE_ENERGY_PROVIDER_ABI_REVIEWED + 0) != 1)
#error "The target binding requires the provider ABI/context assertion"
#endif
#if H1E_VOICE_ENERGY_TARGET_BINDING && \
    (!defined(H1E_VOICE_ENERGY_ASSERT_CONSTRUCTOR128) || \
     (H1E_VOICE_ENERGY_ASSERT_CONSTRUCTOR128 + 0) != 1)
#error "The target binding requires the 128-byte constructor assertion"
#endif
#if H1E_VOICE_ENERGY_TARGET_BINDING && \
    (!defined(H1E_VOICE_ENERGY_ASSERT_DETACH_BEFORE_FREE) || \
     (H1E_VOICE_ENERGY_ASSERT_DETACH_BEFORE_FREE + 0) != 1)
#error "The target binding requires the detach-before-free assertion"
#endif
#if H1E_VOICE_ENERGY_TARGET_BINDING && \
    (!defined(H1E_VOICE_ENERGY_BUILD_ADMITTED) || \
     (H1E_VOICE_ENERGY_BUILD_ADMITTED + 0) != 1)
#error "The target binding requires explicit build admission"
#endif

typedef struct h1e_voice_energy_poll_ops {
    void *ctx;
    uint32_t (*guard_enter)(void *ctx);
    void (*guard_exit)(void *ctx, uint32_t key);
    /*
     * Called only inside the guard. On success, returns the existing VADT tail
     * pointer for a live 0x80-byte object. The implementation must validate the
     * full object extent and preserve detach-before-free lifetime ordering.
     */
    int (*load_live_object_128)(void *ctx, vadt_telemetry_t **tail);
    /*
     * Injection seam. Never bind a target address here until its ABI and call
     * contract have been reviewed. It may retry or wait/yield: call only outside
     * the object/IRQ guard and only in the existing native poll context.
     * Source routing and microphone response remain unqualified.
     * The ops/context storage must remain valid independently of the VAD object
     * throughout the call.
     */
    int32_t (*read_reviewed_source_word)(void *ctx, uint32_t *raw_word);
} h1e_voice_energy_poll_ops_t;

/* Exact one-argument ABI for the current scheduled poll hook. */
int32_t h1e_voice_energy_poll_bridge(uint32_t *native_word);

/* Injection seam used by focused tests and a future reviewed target binding. */
int32_t h1e_voice_energy_poll_bridge_with_ops(
    uint32_t *native_word, const h1e_voice_energy_poll_ops_t *ops);

#if H1E_VOICE_ENERGY_TARGET_BINDING
/* Static in the implementation: no externally supplied ops table is needed. */
#define H1E_VOICE_ENERGY_HAS_TARGET_BINDING 1
#else
#define H1E_VOICE_ENERGY_HAS_TARGET_BINDING 0
#endif

#endif
