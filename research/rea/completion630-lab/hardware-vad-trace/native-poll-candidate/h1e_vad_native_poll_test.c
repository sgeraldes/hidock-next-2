/*
 * Host boundary test for the real h1e_vad_native_poll_bridge body, compiled from
 * h1e_vad_native_poll.c with the typed fakes from h1e_vad_host_test_config.h.
 * It does not repeat the core tests (wrap, age, BUSY).
 */
#include <stdio.h>
#include <string.h>

#include "h1e_vad_native_poll.h"

static int g_checks;
static int g_failures;

#define CHECK(cond, msg)                                                  \
    do {                                                                  \
        ++g_checks;                                                       \
        if (cond) {                                                       \
            printf("PASS %s\n", msg);                                     \
        } else {                                                          \
            ++g_failures;                                                 \
            printf("FAIL %s (line %d)\n", msg, __LINE__);                 \
        }                                                                 \
    } while (0)

enum { EV_GETTER = 1, EV_ENTER, EV_LOAD, EV_EXIT };

static int g_events[16];
static int g_event_count;
static int g_depth;

static int32_t g_getter_status;
static int g_getter_writes;
static uint32_t g_getter_value;
static int g_getter_calls;
static int g_getter_depth_at_call;
static uint32_t *g_getter_pointer_seen;
static uint32_t g_getter_word_before;

static uint32_t g_enter_key;
static int g_enter_calls;
static int g_exit_calls;
static uint32_t g_exit_key_seen;
static uint32_t g_tail_attempted_at_exit;

static vadt_telemetry_t g_tail;
static int g_load_result;
static int g_load_calls;
static int g_load_depth;
static void *g_load_ctx_seen;

static void log_event(int event)
{
    if (g_event_count < 16) {
        g_events[g_event_count++] = event;
    }
}

int32_t h1e_test_getter(uint32_t *out_word)
{
    log_event(EV_GETTER);
    ++g_getter_calls;
    g_getter_depth_at_call = g_depth;
    g_getter_pointer_seen = out_word;
    g_getter_word_before = *out_word;
    if (g_getter_writes) {
        *out_word = g_getter_value;
    }
    return g_getter_status;
}

uint32_t h1e_test_guard_enter(void *ctx)
{
    (void)ctx;
    log_event(EV_ENTER);
    ++g_enter_calls;
    ++g_depth;
    return g_enter_key;
}

void h1e_test_guard_exit(void *ctx, uint32_t key)
{
    (void)ctx;
    log_event(EV_EXIT);
    ++g_exit_calls;
    --g_depth;
    g_exit_key_seen = key;
    g_tail_attempted_at_exit = g_tail.attempted_reads;
}

int h1e_test_load_object(void *ctx, vadt_telemetry_t **tail, uint8_t *native_state)
{
    log_event(EV_LOAD);
    ++g_load_calls;
    g_load_depth = g_depth;
    g_load_ctx_seen = ctx;
    if (g_load_result == 0) {
        *tail = &g_tail;
        *native_state = 5u;
    }
    return g_load_result;
}

static void reset(void)
{
    memset(&g_tail, 0, sizeof g_tail);
    memset(g_events, 0, sizeof g_events);
    g_event_count = 0;
    g_depth = 0;
    g_getter_status = 0;
    g_getter_writes = 0;
    g_getter_value = 0u;
    g_getter_calls = 0;
    g_getter_depth_at_call = -1;
    g_getter_pointer_seen = NULL;
    g_getter_word_before = 0u;
    g_enter_key = 0u;
    g_enter_calls = 0;
    g_exit_calls = 0;
    g_exit_key_seen = 0xA5A5A5A5u;
    g_tail_attempted_at_exit = 0xFFFFFFFFu;
    g_load_result = 0;
    g_load_calls = 0;
    g_load_depth = -1;
    g_load_ctx_seen = (void *)&g_tail;
}

static int order_is(int a, int b, int c, int d)
{
    return g_event_count == 4 && g_events[0] == a && g_events[1] == b &&
           g_events[2] == c && g_events[3] == d;
}

static int tail_is_zero(void)
{
    static const vadt_telemetry_t zero;

    return memcmp((const void *)&g_tail, (const void *)&zero, sizeof zero) == 0;
}

static void test_success_with_object(void)
{
    uint32_t word = 0u;
    int32_t status;

    reset();
    g_getter_writes = 1;
    g_getter_value = 0x01020304u;
    g_enter_key = 0x80000140u;
    status = h1e_vad_native_poll_bridge(&word);

    CHECK(status == 0, "success: status returned unchanged");
    CHECK(g_getter_calls == 1, "success: getter called exactly once");
    CHECK(g_getter_pointer_seen == &word, "success: getter received the caller's own pointer");
    CHECK(g_getter_word_before == 0u, "success: caller's zero-initialized word reached the getter untouched");
    CHECK(word == 0x01020304u, "success: word is what the getter wrote, not rewritten");
    CHECK(g_getter_depth_at_call == 0, "success: getter ran outside the guard");
    CHECK(order_is(EV_GETTER, EV_ENTER, EV_LOAD, EV_EXIT), "success: order getter, enter, load, exit");
    CHECK(g_load_calls == 1 && g_load_depth == 1, "success: loader called once, inside the guard");
    CHECK(g_load_ctx_seen == NULL, "success: loader ctx is the NULL ctx of the static ops");
    CHECK(g_tail.attempted_reads == 1u && g_tail.successful_reads == 1u, "success: metadata recorded once");
    CHECK(g_tail.last_good_raw_word == 0x01020304u && g_tail.last_attempt_status == 0, "success: recorded word and status");
    CHECK((g_tail.flags & VADT_FLAG_HAS_SAMPLE) != 0u && (g_tail.flags & VADT_FLAG_HAS_TIME) == 0u, "success: HAS_SAMPLE set, no time recorded");
    CHECK(g_tail_attempted_at_exit == 1u, "success: metadata was written before the guard was restored");
    CHECK(g_enter_calls == 1 && g_exit_calls == 1 && g_depth == 0, "success: guard balanced");
    CHECK(g_exit_key_seen == 0x80000140u, "success: guard restored the exact saved key");
}

static void test_key_restored_exactly(void)
{
    static const uint32_t keys[] = { 0x00000000u, 0xFFFFFFFFu, 0x80000000u, 0x00000140u };
    uint32_t word = 0u;
    unsigned i;

    for (i = 0u; i < sizeof keys / sizeof keys[0]; ++i) {
        reset();
        g_enter_key = keys[i];
        (void)h1e_vad_native_poll_bridge(&word);
        CHECK(g_exit_key_seen == keys[i], "key: restored exactly as saved, including an IE-clear value");
    }
}

static void test_getter_failure(void)
{
    uint32_t word = 0xDEADBEEFu;
    int32_t status;

    reset();
    g_getter_status = -5;
    status = h1e_vad_native_poll_bridge(&word);

    CHECK(status == -5, "getter failure: status returned unchanged");
    CHECK(word == 0xDEADBEEFu, "getter failure: caller's word left as it was");
    CHECK(g_getter_calls == 1, "getter failure: getter still called exactly once");
    CHECK(g_tail.attempted_reads == 1u && g_tail.successful_reads == 0u && g_tail.last_attempt_status == -5,
          "getter failure: attempt recorded, no success");
    CHECK((g_tail.flags & VADT_FLAG_HAS_SAMPLE) == 0u, "getter failure: no sample claimed");
}

static void test_failed_object_skips_metadata(void)
{
    static const int32_t statuses[] = { 0, -9, 1, INT32_MIN, INT32_MAX };
    uint32_t word = 0u;
    unsigned i;

    for (i = 0u; i < sizeof statuses / sizeof statuses[0]; ++i) {
        reset();
        g_load_result = 1;
        g_getter_status = statuses[i];
        g_getter_writes = 1;
        g_getter_value = 0x0000CAFEu;
        g_enter_key = 0x40u;
        word = 0u;

        CHECK(h1e_vad_native_poll_bridge(&word) == statuses[i], "failed object: getter status returned unchanged");
        CHECK(word == 0x0000CAFEu && g_getter_calls == 1, "failed object: getter output kept, getter called once");
        CHECK(g_load_calls == 1 && order_is(EV_GETTER, EV_ENTER, EV_LOAD, EV_EXIT), "failed object: loader consulted inside the guard");
        CHECK(tail_is_zero(), "failed object: no metadata written");
        CHECK(g_exit_key_seen == 0x40u && g_depth == 0, "failed object: guard still restored with the saved key");
    }
}

int main(void)
{
    test_success_with_object();
    test_key_restored_exactly();
    test_getter_failure();
    test_failed_object_skips_metadata();

    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
