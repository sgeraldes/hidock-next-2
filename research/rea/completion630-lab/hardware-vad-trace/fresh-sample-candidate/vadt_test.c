#include <stdio.h>
#include <string.h>

#include "vadt_binding.h"
#include "vadt_core.h"

#define POISON 0xDEADBEEFu

static int g_checks;
static int g_failures;

#define CHECK(cond, name)                                                        \
    do {                                                                         \
        ++g_checks;                                                              \
        if (cond) {                                                              \
            printf("PASS  %s\n", name);                                          \
        } else {                                                                 \
            ++g_failures;                                                        \
            printf("FAIL  %s  (%s:%d)\n", name, __FILE__, __LINE__);             \
        }                                                                        \
    } while (0)

typedef struct fake_reader {
    int32_t status;
    uint32_t value;
    int calls;
    uint32_t *last_ptr;
    uint32_t word_before_call;
} fake_reader_t;

typedef struct fake_clock {
    uint64_t now;
    int calls;
} fake_clock_t;

/* On success it writes the value; on failure it writes POISON, as a getter that leaves junk. */
static int32_t fake_read(void *ctx, uint32_t *out)
{
    fake_reader_t *r = (fake_reader_t *)ctx;
    r->calls++;
    r->last_ptr = out;
    r->word_before_call = *out;
    *out = (r->status == 0) ? r->value : POISON;
    return r->status;
}

static uint64_t fake_clock_fn(void *ctx)
{
    fake_clock_t *c = (fake_clock_t *)ctx;
    c->calls++;
    return c->now;
}

static int32_t do_poll(vadt_telemetry_t *t, fake_reader_t *r, fake_clock_t *c, uint32_t *word)
{
    return vadt_poll(t, fake_read, r, fake_clock_fn, c, word);
}

static int32_t do_poll_unclocked(vadt_telemetry_t *t, fake_reader_t *r, uint32_t *word)
{
    return vadt_poll(t, fake_read, r, NULL, NULL, word);
}

/* Hook used to simulate the writer racing the reader inside vadt_snapshot. */
static int g_hook_mode;
static int g_hook_calls;

void vadt_test_hook(const vadt_telemetry_t *t, uint32_t try_index)
{
    vadt_telemetry_t *w = (vadt_telemetry_t *)t;
    g_hook_calls++;
    if (g_hook_mode == 1) {
        w->sequence = w->sequence + 2u;
    } else if (g_hook_mode == 2 && try_index == 0u) {
        w->sequence = w->sequence + 2u;
    }
}

static void test_zero_init(void)
{
    vadt_telemetry_t t;
    vadt_telemetry_t z;
    vadt_snapshot_t s;
    uint64_t age = 77u;

    memset(&t, 0xA5, sizeof t);
    vadt_init(&t);
    memset(&z, 0, sizeof z);
    CHECK(memcmp((const void *)&t, (const void *)&z, sizeof t) == 0, "init equals all-zero bytes");
    CHECK(sizeof(vadt_telemetry_t) == 32u, "telemetry is exactly 32 bytes");
    CHECK(vadt_snapshot(&t, &s) == VADT_OK, "zero-init snapshot OK");
    CHECK((s.flags & VADT_FLAG_HAS_SAMPLE) == 0u, "zero-init has no sample");
    CHECK(s.attempted_reads == 0u && s.successful_reads == 0u, "zero-init counters are 0");
    CHECK(vadt_age(&s, 1000u, &age) == VADT_AGE_NO_SAMPLE, "zero-init age is NO_SAMPLE");
    CHECK(age == 77u, "zero-init age output untouched");
}

static void test_success_raw0(void)
{
    vadt_telemetry_t t;
    vadt_snapshot_t s;
    fake_reader_t r = {0, 0u, 0, NULL, 0u};
    fake_clock_t c = {1000u, 0};
    uint32_t word = 0u;
    uint64_t age = 0u;
    int32_t st;

    vadt_init(&t);
    st = do_poll(&t, &r, &c, &word);
    CHECK(st == 0, "raw0: status returned unchanged (0)");
    CHECK(r.calls == 1, "raw0: getter called exactly once");
    CHECK(r.last_ptr == &word, "raw0: caller pointer passed through");
    CHECK(word == 0u, "raw0: native word untouched by core");
    CHECK(vadt_snapshot(&t, &s) == VADT_OK, "raw0: snapshot OK");
    CHECK((s.flags & VADT_FLAG_HAS_SAMPLE) != 0u, "raw0: hasSample set (raw 0 is a valid sample)");
    CHECK(s.last_good_raw_word == 0u, "raw0: raw is 0");
    CHECK(s.attempted_reads == 1u && s.successful_reads == 1u, "raw0: counters 1/1");
    CHECK(s.last_attempt_status == 0, "raw0: last status 0");
    CHECK(s.last_good_time == 1000u && (s.flags & VADT_FLAG_HAS_TIME) != 0u, "raw0: clocked sample time recorded");
    CHECK(vadt_age(&s, 1250u, &age) == VADT_AGE_OK && age == 250u, "raw0: age 250");
    CHECK(c.calls == 1, "raw0: clock read once");
}

static void test_success_max(void)
{
    vadt_telemetry_t t;
    vadt_snapshot_t s;
    fake_reader_t r = {0, 0xFFFFFFFFu, 0, NULL, 0u};
    fake_clock_t c = {5u, 0};
    uint32_t word = 0u;

    vadt_init(&t);
    do_poll(&t, &r, &c, &word);
    CHECK(vadt_snapshot(&t, &s) == VADT_OK, "max: snapshot OK");
    CHECK(s.last_good_raw_word == 0xFFFFFFFFu, "max: raw is UINT32_MAX");
    CHECK(word == 0xFFFFFFFFu, "max: native word holds what getter wrote");
}

static void test_failure_after_success(void)
{
    vadt_telemetry_t t;
    vadt_snapshot_t s;
    fake_reader_t r = {0, 0x1234u, 0, NULL, 0u};
    fake_clock_t c = {100u, 0};
    uint32_t word = 0u;
    int32_t st;
    int clock_calls_before;

    vadt_init(&t);
    do_poll(&t, &r, &c, &word);

    r.status = -5;
    c.now = 900u;
    word = 0u;
    clock_calls_before = c.calls;
    st = do_poll(&t, &r, &c, &word);
    CHECK(st == -5, "failure: status returned unchanged (-5)");
    CHECK(r.calls == 2, "failure: getter called once more (2 total)");
    CHECK(r.last_ptr == &word, "failure: caller pointer passed through");
    CHECK(word == POISON, "failure: output word left exactly as the getter left it");
    CHECK(c.calls == clock_calls_before, "failure: clock not read");
    CHECK(vadt_snapshot(&t, &s) == VADT_OK, "failure: snapshot OK");
    CHECK(s.last_good_raw_word == 0x1234u, "failure: last good raw preserved (poison not consumed)");
    CHECK(s.last_good_time == 100u, "failure: last good time preserved");
    CHECK((s.flags & VADT_FLAG_HAS_SAMPLE) != 0u, "failure: hasSample stays set");
    CHECK(s.last_attempt_status == -5, "failure: last attempt status reported separately");
    CHECK(s.attempted_reads == 2u && s.successful_reads == 1u, "failure: counters 2 attempted / 1 successful");

    r.status = 0;
    r.value = 0x77u;
    c.now = 1200u;
    do_poll(&t, &r, &c, &word);
    CHECK(vadt_snapshot(&t, &s) == VADT_OK && s.last_attempt_status == 0, "recovery: status returns to 0");
    CHECK(s.last_good_raw_word == 0x77u && s.last_good_time == 1200u, "recovery: new good sample replaces old");
}

static void test_failure_first(void)
{
    vadt_telemetry_t t;
    vadt_snapshot_t s;
    fake_reader_t r = {7, 0x55u, 0, NULL, 0u};
    fake_clock_t c = {1u, 0};
    uint32_t word = 0u;

    vadt_init(&t);
    do_poll(&t, &r, &c, &word);
    CHECK(vadt_snapshot(&t, &s) == VADT_OK, "fail-first: snapshot OK");
    CHECK((s.flags & VADT_FLAG_HAS_SAMPLE) == 0u, "fail-first: still no sample");
    CHECK(s.attempted_reads == 1u && s.successful_reads == 0u, "fail-first: counters 1/0");
    CHECK(s.last_attempt_status == 7, "fail-first: status 7 recorded");
    CHECK(s.last_good_raw_word == 0u, "fail-first: raw stays 0 (not POISON)");
}

static void test_record_completed_pure(void)
{
    vadt_telemetry_t t;
    vadt_snapshot_t s;

    vadt_init(&t);
    vadt_record_completed(&t, 0, 0u, 0u, 0);
    CHECK(vadt_snapshot(&t, &s) == VADT_OK && (s.flags & VADT_FLAG_HAS_SAMPLE) != 0u,
          "helper: success with raw 0 is a sample");
    CHECK(s.last_good_raw_word == 0u && (s.flags & VADT_FLAG_HAS_TIME) == 0u && s.last_good_time == 0u,
          "helper: no time given records no time");

    vadt_record_completed(&t, 0, 0xAAu, 0x100000005ull, 1);
    CHECK(vadt_snapshot(&t, &s) == VADT_OK && s.last_good_raw_word == 0xAAu && s.last_good_time == 0x100000005ull &&
              (s.flags & VADT_FLAG_HAS_TIME) != 0u,
          "helper: success with time records raw and 64-bit time");

    vadt_record_completed(&t, 3, 0xBBBBu, 0x999ull, 1);
    CHECK(vadt_snapshot(&t, &s) == VADT_OK, "helper: failure snapshot OK");
    CHECK(s.last_good_raw_word == 0xAAu && s.last_good_time == 0x100000005ull,
          "helper: failure ignores raw and time arguments, last good preserved");
    CHECK((s.flags & (VADT_FLAG_HAS_SAMPLE | VADT_FLAG_HAS_TIME)) == (VADT_FLAG_HAS_SAMPLE | VADT_FLAG_HAS_TIME),
          "helper: failure keeps both flags");
    CHECK(s.last_attempt_status == 3 && s.attempted_reads == 3u && s.successful_reads == 2u,
          "helper: failure moves only attempts and status");

    vadt_record_completed(&t, 0, 0xCCu, 0u, 0);
    CHECK(vadt_snapshot(&t, &s) == VADT_OK && s.last_good_raw_word == 0xCCu && s.last_good_time == 0u &&
              (s.flags & VADT_FLAG_HAS_TIME) == 0u,
          "helper: unclocked success clears old time, no stale time pairs with a new word");
    CHECK((t.sequence & 1u) == 0u && t.sequence == 8u, "helper: sequence even after each of 4 records");
}

static void test_unclocked_path(void)
{
    vadt_telemetry_t t;
    vadt_snapshot_t s;
    fake_reader_t r = {0, 0u, 0, NULL, 0u};
    fake_clock_t c = {123456u, 0};
    uint32_t word = 0u;
    uint8_t reply[VADT_REPLY_SIZE];
    int32_t st;

    vadt_init(&t);
    st = do_poll_unclocked(&t, &r, &word);
    CHECK(st == 0 && r.calls == 1 && r.last_ptr == &word, "unclocked: one getter call, same pointer, status unchanged");
    CHECK(c.calls == 0, "unclocked: clock never called");
    CHECK(vadt_snapshot(&t, &s) == VADT_OK, "unclocked: snapshot OK");
    CHECK((s.flags & VADT_FLAG_HAS_SAMPLE) != 0u && s.last_good_raw_word == 0u,
          "unclocked: valid zero is a sample");
    CHECK((s.flags & VADT_FLAG_HAS_TIME) == 0u && s.last_good_time == 0u, "unclocked: no time recorded");

    vadt_encode_reply(reply, VADT_OK, &s, 4u);
    CHECK(reply[2] == VADT_REPLY_FLAG_HAS_SAMPLE, "unclocked reply: only HAS_SAMPLE set");
    CHECK((reply[2] & (VADT_REPLY_FLAG_AGE_VALID | VADT_REPLY_FLAG_CLOCK_REGRESSED)) == 0u,
          "unclocked reply: AGE_VALID and CLOCK_REGRESSED clear");
    {
        size_t i;
        int age_zero = 1;
        for (i = 20u; i < 28u; ++i) {
            if (reply[i] != 0u) {
                age_zero = 0;
            }
        }
        CHECK(age_zero, "unclocked reply: both age words zero");
    }
    CHECK(reply[7] == 1u && reply[11] == 1u && reply[19] == 0u, "unclocked reply: counters 1/1 and raw 0 retained");

    r.status = -9;
    do_poll_unclocked(&t, &r, &word);
    CHECK(vadt_snapshot(&t, &s) == VADT_OK, "unclocked failure: snapshot OK");
    vadt_encode_reply(reply, VADT_OK, &s, 4u);
    CHECK(reply[2] == VADT_REPLY_FLAG_HAS_SAMPLE, "unclocked failure reply: sample retained, still no age flags");
    CHECK(reply[12] == 0xFF && reply[13] == 0xFF && reply[14] == 0xFF && reply[15] == 0xF7,
          "unclocked failure reply: status -9 reported");
    CHECK(reply[7] == 2u && reply[11] == 1u && reply[16] == 0u && reply[19] == 0u,
          "unclocked failure reply: attempts 2, successes 1, raw still valid 0");

    /* Even a snapshot that holds a time must not produce age flags in the unclocked encoder. */
    s.flags |= VADT_FLAG_HAS_TIME;
    s.last_good_time = 50u;
    vadt_encode_reply(reply, VADT_OK, &s, 4u);
    CHECK(reply[2] == VADT_REPLY_FLAG_HAS_SAMPLE && reply[23] == 0u && reply[27] == 0u,
          "unclocked encoder never reports age even when a time is present");

    /* A clock pointer given and a clock call made only on success, still unchanged behaviour. */
    r.status = 0;
    r.value = 3u;
    vadt_init(&t);
    vadt_poll(&t, fake_read, &r, fake_clock_fn, &c, &word);
    CHECK(c.calls == 1, "clocked (optional) path still calls the clock once on success");
}

static void test_busy(void)
{
    vadt_telemetry_t t;
    vadt_snapshot_t s;

    vadt_init(&t);
    memset(&s, 0x5A, sizeof s);
    t.sequence = 1u;
    g_hook_mode = 0;
    g_hook_calls = 0;
    CHECK(vadt_snapshot(&t, &s) == VADT_BUSY, "odd sequence returns BUSY");
    CHECK(g_hook_calls == 0, "odd sequence never reads payload");
    {
        vadt_snapshot_t ref;
        memset(&ref, 0x5A, sizeof ref);
        CHECK(memcmp(&s, &ref, sizeof s) == 0, "BUSY leaves output untouched");
    }

    vadt_init(&t);
    g_hook_mode = 1;
    g_hook_calls = 0;
    CHECK(vadt_snapshot(&t, &s) == VADT_BUSY, "sequence changing on every try returns BUSY");
    CHECK(g_hook_calls == (int)VADT_SNAPSHOT_TRIES, "exactly 3 tries, no spinning");

    vadt_init(&t);
    g_hook_mode = 2;
    g_hook_calls = 0;
    CHECK(vadt_snapshot(&t, &s) == VADT_OK, "one change then stable returns OK");
    CHECK(g_hook_calls == 2 && s.sequence == 2u, "retry used the second try and the new sequence");
    g_hook_mode = 0;
}

static void test_counter_wrap(void)
{
    vadt_telemetry_t t;
    vadt_snapshot_t s;
    fake_reader_t r = {0, 9u, 0, NULL, 0u};
    fake_clock_t c = {10u, 0};
    uint32_t word = 0u;

    vadt_init(&t);
    t.attempted_reads = 0xFFFFFFFFu;
    t.successful_reads = 0xFFFFFFFFu;
    t.sequence = 0xFFFFFFFEu;
    do_poll(&t, &r, &c, &word);
    CHECK(vadt_snapshot(&t, &s) == VADT_OK, "wrap: snapshot OK");
    CHECK(s.attempted_reads == 0u && s.successful_reads == 0u, "wrap: counters wrap to 0 (unsigned)");
    CHECK((s.flags & VADT_FLAG_HAS_SAMPLE) != 0u, "wrap: hasSample independent of wrapped success count");
    CHECK(s.sequence == 0u, "wrap: sequence wraps back to even 0");
    CHECK(s.last_good_raw_word == 9u, "wrap: sample recorded");
}

static void test_age(void)
{
    vadt_snapshot_t s;
    uint64_t age = 0u;

    memset(&s, 0, sizeof s);
    s.flags = VADT_FLAG_HAS_SAMPLE | VADT_FLAG_HAS_TIME;

    s.last_good_time = 0x00000000FFFFFFF0ull;
    CHECK(vadt_age(&s, 0x0000000100000010ull, &age) == VADT_AGE_OK && age == 0x20u, "age across low32 wrap = 0x20");

    s.last_good_time = 0x10ull;
    CHECK(vadt_age(&s, 0x0000000100000020ull, &age) == VADT_AGE_OK && age == 0x100000010ull,
          "stale age does not alias after 32-bit wrap (0x1_00000010, not 0x10)");

    s.last_good_time = 500u;
    CHECK(vadt_age(&s, 500u, &age) == VADT_AGE_OK && age == 0u, "age 0 when now equals sample time");

    age = 4242u;
    CHECK(vadt_age(&s, 499u, &age) == VADT_AGE_CLOCK_REGRESSED, "clock regression by 1 is invalid");
    CHECK(age == 4242u, "regression leaves age output untouched");

    s.last_good_time = 0x0000000100000000ull;
    CHECK(vadt_age(&s, 0x00000000FFFFFFFFull, &age) == VADT_AGE_CLOCK_REGRESSED,
          "regression visible only in high word is still invalid");

    s.flags = VADT_FLAG_HAS_SAMPLE;
    s.last_good_time = 0u;
    age = 4242u;
    CHECK(vadt_age(&s, 100u, &age) == VADT_AGE_NO_TIME && age == 4242u,
          "sample without time is NO_TIME, never aged against a dummy zero clock");
}

static void test_time_split(void)
{
    vadt_telemetry_t t;
    vadt_snapshot_t s;
    fake_reader_t r = {0, 1u, 0, NULL, 0u};
    fake_clock_t c = {0x0000000A12345678ull, 0};
    uint32_t word = 0u;

    vadt_init(&t);
    do_poll(&t, &r, &c, &word);
    CHECK(t.last_good_time_low == 0x12345678u && t.last_good_time_high == 0xAu, "time split into low/high words");
    CHECK(vadt_snapshot(&t, &s) == VADT_OK && s.last_good_time == c.now, "snapshot recombines 64-bit time");
}

static void test_reply_with_age(void)
{
    uint8_t out[VADT_REPLY_SIZE];
    vadt_snapshot_t s;
    static const uint8_t expect[VADT_REPLY_SIZE] = {
        0x00, 0x01, 0x03, 0x05,
        0x00, 0x00, 0x00, 0x09,
        0x00, 0x00, 0x00, 0x04,
        0xFF, 0xFF, 0xFF, 0xFB,
        0xFF, 0xFF, 0xFF, 0xFF,
        0x00, 0x00, 0x00, 0x20,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x0A};

    memset(&s, 0, sizeof s);
    s.sequence = 10u;
    s.attempted_reads = 9u;
    s.successful_reads = 4u;
    s.last_attempt_status = -5;
    s.last_good_raw_word = 0xFFFFFFFFu;
    s.last_good_time = 0x00000000FFFFFFF0ull;
    s.flags = VADT_FLAG_HAS_SAMPLE | VADT_FLAG_HAS_TIME;

    vadt_encode_reply_with_age(out, VADT_OK, &s, 0x0000000100000010ull, 5u);
    CHECK(memcmp(out, expect, sizeof out) == 0, "optional age reply bytes match layout (flags 0x03)");

    s.last_good_time = 0x0000000100000000ull;
    vadt_encode_reply_with_age(out, VADT_OK, &s, 5u, 5u);
    CHECK(out[2] == (VADT_REPLY_FLAG_HAS_SAMPLE | VADT_REPLY_FLAG_CLOCK_REGRESSED), "age reply flags: regressed, no ageValid");
    CHECK(out[20] == 0 && out[21] == 0 && out[22] == 0 && out[23] == 0 && out[24] == 0, "age reply age is 0 on regression");

    s.flags = VADT_FLAG_HAS_SAMPLE;
    vadt_encode_reply_with_age(out, VADT_OK, &s, 5u, 5u);
    CHECK(out[2] == VADT_REPLY_FLAG_HAS_SAMPLE && out[23] == 0u, "age reply: sample without time gets no age flag and age 0");

    s.flags = 0u;
    vadt_encode_reply_with_age(out, VADT_OK, &s, 5u, 1u);
    CHECK(out[2] == 0u && out[3] == 1u, "age reply flags: no sample");
}

static void test_reply_status(void)
{
    uint8_t out[VADT_REPLY_SIZE];
    size_t i;
    int zero_tail = 1;

    vadt_encode_reply(out, VADT_BUSY, NULL, 2u);
    for (i = 4u; i < VADT_REPLY_SIZE; ++i) {
        if (out[i] != 0u) {
            zero_tail = 0;
        }
    }
    CHECK(out[0] == VADT_BUSY && out[1] == VADT_REPLY_VERSION && out[3] == 2u && zero_tail, "BUSY reply: header only, zero tail");
    vadt_encode_reply(out, VADT_OK, NULL, 0u);
    CHECK(out[0] == VADT_UNAVAILABLE, "OK without snapshot downgrades to UNAVAILABLE");

    /* nativeState byte 3: zero for effective UNAVAILABLE, preserved for BUSY. */
    memset(out, 0xA5, sizeof out);
    vadt_encode_reply(out, VADT_UNAVAILABLE, NULL, 7u);
    CHECK(out[0] == VADT_UNAVAILABLE && out[3] == 0u, "explicit UNAVAILABLE with nonzero native_state writes byte3 = 0");
    zero_tail = 1;
    for (i = 4u; i < VADT_REPLY_SIZE; ++i) {
        if (out[i] != 0u) {
            zero_tail = 0;
        }
    }
    CHECK(out[1] == VADT_REPLY_VERSION && out[2] == 0u && zero_tail, "explicit UNAVAILABLE: version set, flags and tail zero");

    memset(out, 0xA5, sizeof out);
    vadt_encode_reply(out, VADT_OK, NULL, 7u);
    CHECK(out[0] == VADT_UNAVAILABLE && out[3] == 0u, "OK+NULL fallback with nonzero native_state writes byte3 = 0");

    memset(out, 0xA5, sizeof out);
    vadt_encode_reply_with_age(out, VADT_UNAVAILABLE, NULL, 100u, 7u);
    CHECK(out[0] == VADT_UNAVAILABLE && out[3] == 0u, "age encoder: explicit UNAVAILABLE byte3 = 0");
    memset(out, 0xA5, sizeof out);
    vadt_encode_reply_with_age(out, VADT_OK, NULL, 100u, 7u);
    CHECK(out[0] == VADT_UNAVAILABLE && out[3] == 0u, "age encoder: OK+NULL fallback byte3 = 0");

    vadt_encode_reply(out, VADT_BUSY, NULL, 7u);
    CHECK(out[0] == VADT_BUSY && out[3] == 7u, "BUSY preserves nonzero native_state");
    vadt_encode_reply_with_age(out, VADT_BUSY, NULL, 100u, 7u);
    CHECK(out[0] == VADT_BUSY && out[3] == 7u, "age encoder: BUSY preserves nonzero native_state");
}

/* ---- binding (source-only design) ------------------------------------------- */

typedef struct bind_env {
    int guard_depth;
    int enter_calls;
    int exit_calls;
    uint32_t key_to_return;
    uint32_t key_seen_at_exit;
    int load_calls;
    int load_depth;
    int load_fail;
    vadt_telemetry_t *tail;
    uint8_t native_state;
    const uint8_t *reply_watch;
    int reply_written_before_exit;
} bind_env_t;

static bind_env_t g_env;

static int g_getter_calls;
static int g_getter_depth;
static int32_t g_getter_status;
static uint32_t g_getter_value;
static uint32_t *g_getter_ptr;

static int32_t fake_getter(uint32_t *out)
{
    g_getter_calls++;
    g_getter_depth = g_env.guard_depth;
    g_getter_ptr = out;
    *out = (g_getter_status == 0) ? g_getter_value : POISON;
    return g_getter_status;
}

static uint32_t env_enter(void *ctx)
{
    bind_env_t *e = (bind_env_t *)ctx;
    e->guard_depth++;
    e->enter_calls++;
    return e->key_to_return;
}

static void env_exit(void *ctx, uint32_t key)
{
    bind_env_t *e = (bind_env_t *)ctx;
    e->guard_depth--;
    e->exit_calls++;
    e->key_seen_at_exit = key;
    if (e->reply_watch != NULL && e->reply_watch[0] != 0xA5u) {
        e->reply_written_before_exit = 1;
    }
}

static int env_load(void *ctx, vadt_telemetry_t **tail, uint8_t *native_state)
{
    bind_env_t *e = (bind_env_t *)ctx;
    e->load_calls++;
    e->load_depth = e->guard_depth;
    if (e->load_fail) {
        return 1;
    }
    *tail = e->tail;
    *native_state = e->native_state;
    return 0;
}

static void env_reset(vadt_telemetry_t *t, uint32_t key)
{
    memset(&g_env, 0, sizeof g_env);
    g_env.tail = t;
    g_env.key_to_return = key;
    g_env.native_state = 5u;
    g_getter_calls = 0;
    g_getter_depth = -1;
    g_getter_ptr = NULL;
}

static void test_binding(void)
{
    vadt_telemetry_t t;
    vadt_snapshot_t s;
    vadt_binding_ops_t ops;
    uint32_t word = 0u;
    int32_t st;
    uint8_t reply[VADT_REPLY_SIZE];
    vadt_getter_adapter_ctx_t actx;
    uint32_t aw = 0u;

    ops.ctx = &g_env;
    ops.guard_enter = env_enter;
    ops.guard_exit = env_exit;
    ops.load_object = env_load;

    vadt_init(&t);
    env_reset(&t, 0xC0u);
    g_getter_status = 0;
    g_getter_value = 0u;
    st = vadt_binding_poll(&ops, fake_getter, &word);
    CHECK(st == 0 && g_getter_calls == 1 && g_getter_ptr == &word, "binding: one original getter call, same pointer, status unchanged");
    CHECK(g_getter_depth == 0, "binding: original getter runs outside the guard");
    CHECK(g_env.load_calls == 1 && g_env.load_depth == 1, "binding: object loaded inside the guard, after the getter");
    CHECK(g_env.enter_calls == 1 && g_env.exit_calls == 1 && g_env.guard_depth == 0, "binding: guard balanced");
    CHECK(g_env.key_seen_at_exit == 0xC0u, "binding: exact saved key restored (IE already clear case)");
    CHECK(vadt_snapshot(&t, &s) == VADT_OK && (s.flags & VADT_FLAG_HAS_SAMPLE) != 0u && s.last_good_raw_word == 0u &&
              (s.flags & VADT_FLAG_HAS_TIME) == 0u,
          "binding: raw 0 recorded as sample, no time, no clock call");

    env_reset(&t, 0x40u);
    g_getter_status = -4;
    word = 0u;
    st = vadt_binding_poll(&ops, fake_getter, &word);
    CHECK(st == -4 && word == POISON && g_getter_calls == 1, "binding: failure returns status and leaves the output word as the getter left it");
    CHECK(g_env.key_seen_at_exit == 0x40u, "binding: exact saved key restored (IE set case)");
    CHECK(vadt_snapshot(&t, &s) == VADT_OK && s.last_good_raw_word == 0u && s.last_attempt_status == -4 &&
              s.attempted_reads == 2u && s.successful_reads == 1u,
          "binding: failure keeps last good, reports status and counters");

    env_reset(&t, 0x40u);
    g_env.load_fail = 1;
    g_getter_status = 0;
    g_getter_value = 0x1111u;
    st = vadt_binding_poll(&ops, fake_getter, &word);
    CHECK(st == 0 && g_getter_calls == 1, "binding: failed object check still performs the getter once and returns its status");
    CHECK(g_env.exit_calls == 1 && g_env.guard_depth == 0, "binding: guard released when object check fails");
    CHECK(vadt_snapshot(&t, &s) == VADT_OK && s.attempted_reads == 2u && s.last_good_raw_word == 0u,
          "binding: failed object check publishes nothing");

    env_reset(&t, 0x40u);
    memset(reply, 0xA5, sizeof reply);
    g_env.reply_watch = reply;
    st = vadt_binding_read(&ops, reply);
    CHECK(st == VADT_OK && reply[0] == VADT_OK && reply[3] == 5u, "binding read: OK reply with native state");
    CHECK(g_env.load_depth == 1 && g_env.guard_depth == 0, "binding read: object loaded inside the guard, guard released");
    CHECK(g_env.reply_written_before_exit == 0, "binding read: reply formatted only after the guard is restored");
    CHECK(reply[2] == VADT_REPLY_FLAG_HAS_SAMPLE, "binding read: unclocked flags only");

    env_reset(&t, 0x40u);
    g_env.load_fail = 1;
    memset(reply, 0xA5, sizeof reply);
    st = vadt_binding_read(&ops, reply);
    CHECK(st == VADT_UNAVAILABLE && reply[0] == VADT_UNAVAILABLE && reply[3] == 0u, "binding read: failed object check gives UNAVAILABLE");

    env_reset(&t, 0x40u);
    t.sequence = 1u;
    st = vadt_binding_read(&ops, reply);
    CHECK(st == VADT_BUSY && reply[0] == VADT_BUSY && g_env.exit_calls == 1, "binding read: odd sequence gives BUSY and releases the guard");
    t.sequence = 0u;

    env_reset(&t, 0x40u);
    g_getter_status = 0;
    g_getter_value = 0x42u;
    actx.getter = fake_getter;
    st = vadt_getter_adapter(&actx, &aw);
    CHECK(st == 0 && aw == 0x42u && g_getter_calls == 1 && g_getter_ptr == &aw,
          "adapter: ctx-first shape calls the one-argument getter through its real type, once");
}

int main(void)
{
    test_zero_init();
    test_success_raw0();
    test_success_max();
    test_failure_after_success();
    test_failure_first();
    test_record_completed_pure();
    test_unclocked_path();
    test_busy();
    test_counter_wrap();
    test_age();
    test_time_split();
    test_reply_with_age();
    test_reply_status();
    test_binding();

    printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
