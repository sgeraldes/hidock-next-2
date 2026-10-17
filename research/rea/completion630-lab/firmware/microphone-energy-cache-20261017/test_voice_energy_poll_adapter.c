#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "h1e_voice_energy_poll_adapter.h"

typedef union test_object {
    uint32_t words[H1E_VOICE_ENERGY_OBJECT_BYTES / sizeof(uint32_t)];
    uint8_t bytes[H1E_VOICE_ENERGY_OBJECT_BYTES];
} test_object_t;

typedef struct test_context {
    test_object_t object;
    test_object_t replacement;
    int live;
    int switch_after_source;
    int replacement_active;
    int in_guard;
    int native_calls;
    int load_calls;
    int source_calls;
    int32_t native_status;
    int32_t source_status;
    uint32_t source_word;
} test_context_t;

int32_t h1e_vad_native_poll_bridge(uint32_t *native_word)
{
    extern test_context_t *g_test;

    ++g_test->native_calls;
    *native_word = 0x55aa33ccu;
    return g_test->native_status;
}

test_context_t *g_test;

static uint32_t guard_enter(void *ctx)
{
    test_context_t *test = (test_context_t *)ctx;

    if (test->in_guard != 0) {
        return 0u;
    }
    test->in_guard = 1;
    return 0x1234u;
}

static void guard_exit(void *ctx, uint32_t key)
{
    test_context_t *test = (test_context_t *)ctx;

    if (test->in_guard == 0 || key != 0x1234u) {
        test->in_guard = -1;
        return;
    }
    test->in_guard = 0;
}

static int load_live_object_128(void *ctx, vadt_telemetry_t **tail)
{
    test_context_t *test = (test_context_t *)ctx;

    ++test->load_calls;
    if (test->in_guard != 1 || test->live == 0) {
        *tail = NULL;
        return -1;
    }
    *tail = (vadt_telemetry_t *)(void *)
        ((test->replacement_active ? test->replacement.bytes : test->object.bytes) + 0x40u);
    return 0;
}

static int32_t read_reviewed_source_word(void *ctx, uint32_t *raw_word)
{
    test_context_t *test = (test_context_t *)ctx;

    if (test->in_guard != 0) {
        return -99;
    }
    ++test->source_calls;
    *raw_word = test->source_word;
    if (test->switch_after_source != 0) {
        test->switch_after_source = 0;
        test->replacement_active = 1;
    }
    return test->source_status;
}

static int require(int condition, const char *message)
{
    if (!condition) {
        fprintf(stderr, "failed: %s\n", message);
        return 0;
    }
    return 1;
}

int main(void)
{
    test_context_t test;
    h1e_voice_energy_poll_ops_t ops;
    h1e_voice_energy_cache_t *cache;
    h1e_voice_energy_snapshot_t snapshot;
    uint32_t native_word = 0u;
    int ok = 1;

    memset(&test, 0, sizeof(test));
    g_test = &test;
    test.live = 1;
    test.native_status = -11;
    test.source_status = 0;
    test.source_word = 0u;
    cache = (h1e_voice_energy_cache_t *)(void *)(test.object.bytes + 0x60u);
    h1e_voice_energy_cache_init(cache);

    ops.ctx = &test;
    ops.guard_enter = guard_enter;
    ops.guard_exit = guard_exit;
    ops.load_live_object_128 = load_live_object_128;
    ops.read_reviewed_source_word = read_reviewed_source_word;

    ok &= require(h1e_voice_energy_poll_bridge_with_ops(&native_word, &ops) == -11,
                  "native status passes through unchanged");
    ok &= require(native_word == 0x55aa33ccu && test.native_calls == 1,
                  "native bridge called once and caller word preserved");
    ok &= require(test.load_calls == 2 && test.source_calls == 1 && test.in_guard == 0,
                  "preflight and publish reload bracket one unguarded source read");
    ok &= require(h1e_voice_energy_cache_snapshot(cache, &snapshot) ==
                      H1E_VOICE_ENERGY_SNAPSHOT_OK &&
                      snapshot.attempted_reads == 1u && snapshot.successful_reads == 1u &&
                      snapshot.last_good_raw_word == 0u &&
                      (snapshot.flags & H1E_VOICE_ENERGY_HAS_SAMPLE) != 0u,
                  "raw zero is published as a successful sample");

    test.native_status = 0;
    test.source_status = -7;
    test.source_word = 0xdeadbeefu;
    ok &= require(h1e_voice_energy_poll_bridge_with_ops(&native_word, &ops) == 0,
                  "second native status remains unchanged");
    ok &= require(h1e_voice_energy_cache_snapshot(cache, &snapshot) ==
                      H1E_VOICE_ENERGY_SNAPSHOT_OK &&
                      snapshot.attempted_reads == 2u && snapshot.successful_reads == 1u &&
                      snapshot.last_attempt_status == -7 && snapshot.last_good_raw_word == 0u &&
                      (snapshot.flags & H1E_VOICE_ENERGY_HAS_SAMPLE) != 0u,
                  "failed source read updates status and preserves last good raw word");

    test.live = 1;
    test.switch_after_source = 1;
    test.source_status = 0;
    test.source_word = 0xabcdef01u;
    {
        h1e_voice_energy_cache_t *replacement_cache =
            (h1e_voice_energy_cache_t *)(void *)(test.replacement.bytes + 0x60u);

        h1e_voice_energy_cache_init(replacement_cache);
        ok &= require(h1e_voice_energy_poll_bridge_with_ops(&native_word, &ops) == 0,
                      "native status remains unchanged if object changes during source read");
        ok &= require(h1e_voice_energy_cache_snapshot(cache, &snapshot) ==
                          H1E_VOICE_ENERGY_SNAPSHOT_OK && snapshot.attempted_reads == 2u &&
                          h1e_voice_energy_cache_snapshot(replacement_cache, &snapshot) ==
                              H1E_VOICE_ENERGY_SNAPSHOT_OK && snapshot.attempted_reads == 0u,
                      "reloaded object identity mismatch suppresses sidecar publication");
    }

    test.live = 0;
    test.native_status = 5;
    {
        int sources_before = test.source_calls;
        ok &= require(h1e_voice_energy_poll_bridge_with_ops(&native_word, &ops) == 5,
                      "unavailable sidecar cannot alter native status");
        ok &= require(test.source_calls == sources_before,
                      "source callback skipped without a live preflight object");
    }

    if (!ok) {
        return 1;
    }
    puts("focused poll-adapter cases passed (fake callback only)");
    return 0;
}
