#include "h1e_voice_energy_cache.h"

#include <stdio.h>

static int check(int condition, const char *message)
{
    if (!condition) {
        (void)fprintf(stderr, "FAIL: %s\n", message);
        return 0;
    }
    return 1;
}

int main(void)
{
    h1e_voice_energy_cache_t cache;
    h1e_voice_energy_snapshot_t snapshot;
    int passed = 1;

    h1e_voice_energy_cache_init(&cache);
    passed &= check(h1e_voice_energy_cache_snapshot(&cache, &snapshot) == H1E_VOICE_ENERGY_SNAPSHOT_OK,
                    "snapshot after init");
    passed &= check(snapshot.sequence == 0u && snapshot.attempted_reads == 0u &&
                    snapshot.successful_reads == 0u && snapshot.last_attempt_status == 0 &&
                    snapshot.last_good_raw_word == 0u && snapshot.flags == 0u,
                    "init is empty and has no presence semantic");

    h1e_voice_energy_cache_record_completed(&cache, 0, 0x12345678u);
    passed &= check(h1e_voice_energy_cache_snapshot(&cache, &snapshot) == H1E_VOICE_ENERGY_SNAPSHOT_OK,
                    "snapshot after successful publish");
    passed &= check(snapshot.sequence == 2u && snapshot.attempted_reads == 1u &&
                    snapshot.successful_reads == 1u && snapshot.last_attempt_status == 0 &&
                    snapshot.last_good_raw_word == 0x12345678u &&
                    snapshot.flags == H1E_VOICE_ENERGY_HAS_SAMPLE,
                    "successful publish caches raw/status/count only");

    h1e_voice_energy_cache_record_completed(&cache, -7, 0xDEADBEEFu);
    passed &= check(h1e_voice_energy_cache_snapshot(&cache, &snapshot) == H1E_VOICE_ENERGY_SNAPSHOT_OK,
                    "snapshot after failed publish");
    passed &= check(snapshot.sequence == 4u && snapshot.attempted_reads == 2u &&
                    snapshot.successful_reads == 1u && snapshot.last_attempt_status == -7 &&
                    snapshot.last_good_raw_word == 0x12345678u &&
                    snapshot.flags == H1E_VOICE_ENERGY_HAS_SAMPLE,
                    "failure updates status/count and preserves last good raw");

    if (!passed) {
        return 1;
    }
    (void)puts("3 focused cache states passed");
    return 0;
}
