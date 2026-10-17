#include "h1e_voice_energy_cache.h"

#ifndef H1E_VE_CACHE_BARRIER
#if defined(__GNUC__) || defined(__clang__)
#define H1E_VE_CACHE_BARRIER() __asm__ __volatile__("" : : : "memory")
#else
#error "Define H1E_VE_CACHE_BARRIER for this compiler"
#endif
#endif

/* Compiler ordering only, matching the current VADT core's default. */
#ifndef H1E_VE_CACHE_CPU_BARRIER
#define H1E_VE_CACHE_CPU_BARRIER() H1E_VE_CACHE_BARRIER()
#endif

void h1e_voice_energy_cache_init(h1e_voice_energy_cache_t *cache)
{
    cache->sequence = 0u;
    cache->attempted_reads = 0u;
    cache->successful_reads = 0u;
    cache->last_attempt_status = 0;
    cache->last_good_raw_word = 0u;
    cache->flags = 0u;
    cache->reserved[0] = 0u;
    cache->reserved[1] = 0u;
}

void h1e_voice_energy_cache_record_completed(h1e_voice_energy_cache_t *cache,
                                             int32_t status, uint32_t raw)
{
    cache->sequence = cache->sequence + 1u;
    H1E_VE_CACHE_CPU_BARRIER();

    cache->attempted_reads = cache->attempted_reads + 1u;
    cache->last_attempt_status = status;
    if (status == 0) {
        cache->successful_reads = cache->successful_reads + 1u;
        cache->last_good_raw_word = raw;
        cache->flags = cache->flags | H1E_VOICE_ENERGY_HAS_SAMPLE;
    }

    H1E_VE_CACHE_CPU_BARRIER();
    cache->sequence = cache->sequence + 1u;
}

h1e_voice_energy_snapshot_status_t
h1e_voice_energy_cache_snapshot(const h1e_voice_energy_cache_t *cache,
                                h1e_voice_energy_snapshot_t *out)
{
    uint32_t i;

    for (i = 0u; i < H1E_VOICE_ENERGY_SNAPSHOT_TRIES; ++i) {
        uint32_t sequence_before = cache->sequence;
        uint32_t attempted, successful, raw, flags;
        int32_t status;
        uint32_t sequence_after;

        if ((sequence_before & 1u) != 0u) {
            continue;
        }
        H1E_VE_CACHE_CPU_BARRIER();

        attempted = cache->attempted_reads;
        successful = cache->successful_reads;
        status = cache->last_attempt_status;
        raw = cache->last_good_raw_word;
        flags = cache->flags;

        H1E_VE_CACHE_CPU_BARRIER();
        sequence_after = cache->sequence;
        if (sequence_before == sequence_after) {
            out->sequence = sequence_before;
            out->attempted_reads = attempted;
            out->successful_reads = successful;
            out->last_attempt_status = status;
            out->last_good_raw_word = raw;
            out->flags = flags;
            return H1E_VOICE_ENERGY_SNAPSHOT_OK;
        }
    }

    return H1E_VOICE_ENERGY_SNAPSHOT_BUSY;
}
