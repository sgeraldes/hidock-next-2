#include "h1e_voice_energy_poll_adapter.h"

#if H1E_VOICE_ENERGY_TARGET_BINDING
#include "h1e_voice_energy_loader128.h"
#include "../vad-provider-fixed-snapshot-20261017/src/vad_provider_raw_get.h"

static int load_current_object_128(void *ctx, vadt_telemetry_t **tail)
{
    uint8_t native_state;

    return h1e_voice_energy_load_object_128(ctx, tail, &native_state);
}

static int32_t read_provider_raw_word(void *ctx, uint32_t *raw_word)
{
    (void)ctx;
    return vad_provider_raw_get(raw_word);
}

/* Real native dependencies; no test-only loader or undefined ops table. */
static const h1e_voice_energy_poll_ops_t target_poll_ops = {
    NULL,
    vadt_csky_guard_enter,
    vadt_csky_guard_exit,
    load_current_object_128,
    read_provider_raw_word
};
#endif

#if H1E_VOICE_ENERGY_POLL_ENABLED
static uintptr_t load_live_tail_identity(const h1e_voice_energy_poll_ops_t *ops)
{
    vadt_telemetry_t *tail = NULL;
    uint32_t key = ops->guard_enter(ops->ctx);
    int live = ops->load_live_object_128(ops->ctx, &tail) == 0 && tail != NULL &&
               (((uintptr_t)tail & (uintptr_t)3u) == 0u);
    uintptr_t identity = live ? (uintptr_t)tail : (uintptr_t)0u;

    ops->guard_exit(ops->ctx, key);
    /* Keep only the integer identity; never dereference the saved pointer. */
    tail = NULL;
    (void)tail;
    return identity;
}
#endif

int32_t h1e_voice_energy_poll_bridge_with_ops(
    uint32_t *native_word, const h1e_voice_energy_poll_ops_t *ops)
{
    int32_t native_status = h1e_vad_native_poll_bridge(native_word);

#if H1E_VOICE_ENERGY_POLL_ENABLED
    if (ops != NULL && ops->guard_enter != NULL && ops->guard_exit != NULL &&
        ops->load_live_object_128 != NULL && ops->read_reviewed_source_word != NULL) {
        uintptr_t initial_identity = load_live_tail_identity(ops);
        uint32_t raw_word = 0u;
        if (initial_identity != (uintptr_t)0u) {
            int32_t source_status = ops->read_reviewed_source_word(ops->ctx, &raw_word);
            vadt_telemetry_t *tail = NULL;
            uint32_t key = ops->guard_enter(ops->ctx);

            if (ops->load_live_object_128(ops->ctx, &tail) == 0 && tail != NULL &&
                (((uintptr_t)tail & (uintptr_t)3u) == 0u) &&
                /* Publish only if the live object is still the preflight object. */
                (uintptr_t)tail == initial_identity) {
                h1e_voice_energy_cache_t *cache = (h1e_voice_energy_cache_t *)
                    ((uint8_t *)tail + sizeof(vadt_telemetry_t));

                h1e_voice_energy_cache_record_completed(cache, source_status, raw_word);
            }
            ops->guard_exit(ops->ctx, key);
        }
    }
#else
    (void)ops;
#endif

    /* No optional provider result changes the native RefChannelVAD result. */
    return native_status;
}

int32_t h1e_voice_energy_poll_bridge(uint32_t *native_word)
{
#if H1E_VOICE_ENERGY_TARGET_BINDING
    return h1e_voice_energy_poll_bridge_with_ops(native_word, &target_poll_ops);
#else
    return h1e_voice_energy_poll_bridge_with_ops(native_word, NULL);
#endif
}
