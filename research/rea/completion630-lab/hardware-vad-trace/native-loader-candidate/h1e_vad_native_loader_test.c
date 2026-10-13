/*
 * Host test for the real h1e_vad_load_object and h1e_vad_snapshot_read bodies,
 * built from h1e_vad_native_loader.c with the typed slot and guard fakes from
 * h1e_vad_native_loader_host_config.h. It covers only the new glue and does not
 * repeat the core, frame or SDK checks.
 *
 * Rejected bases point at memory that would fault if touched. A misaligned base
 * sits inside a PROT_NONE page, and NULL and wrapping bases are unmapped, so a
 * stray state-byte or telemetry access kills the test instead of passing quietly.
 */
#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE 1
#endif
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#include "h1e_vad_native_loader.h"

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

static uintptr_t g_slot_value;
static int g_slot_reads;
static int g_slot_read_depth;
static int g_depth;
static int g_enter_calls;
static int g_exit_calls;
static uint32_t g_enter_key;
static uint32_t g_exit_key_seen;

uintptr_t h1e_test_slot_read(void)
{
    ++g_slot_reads;
    g_slot_read_depth = g_depth;
    return g_slot_value;
}

uint32_t h1e_test_guard_enter(void *ctx)
{
    (void)ctx;
    ++g_enter_calls;
    ++g_depth;
    return g_enter_key;
}

void h1e_test_guard_exit(void *ctx, uint32_t key)
{
    (void)ctx;
    ++g_exit_calls;
    --g_depth;
    g_exit_key_seen = key;
}

static void reset(uintptr_t slot)
{
    g_slot_value = slot;
    g_slot_reads = 0;
    g_slot_read_depth = -1;
    g_depth = 0;
    g_enter_calls = 0;
    g_exit_calls = 0;
    g_enter_key = 0x80000140u;
    g_exit_key_seen = 0xA5A5A5A5u;
}

static uint8_t *g_object;
static uint8_t *g_fault_page;

static void map_memory(void)
{
    long page = sysconf(_SC_PAGESIZE);
    uint8_t *base = mmap(NULL, (size_t)page * 2u, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

    if (base == MAP_FAILED || mprotect(base + page, (size_t)page, PROT_NONE) != 0) {
        printf("FAIL cannot map test memory\n");
        _exit(2);
    }
    /* The object ends exactly at the end of the readable page: a read past object+0x5f would fault. */
    g_object = base + page - H1E_VAD_OBJECT_BYTES;
    g_fault_page = base + page;
}

static vadt_telemetry_t *tail_of(uint8_t *object)
{
    return (vadt_telemetry_t *)(object + H1E_VAD_TAIL_OFFSET);
}

static void clear_object(uint8_t state)
{
    memset(g_object, 0, H1E_VAD_OBJECT_BYTES);
    g_object[0] = state;
}

static void test_constants(void)
{
    CHECK(H1E_VAD_BASE_MAX == (uintptr_t)(UINTPTR_MAX - 0x5fu), "constants: base limit leaves room for the 0x60-byte extent");
    CHECK((uintptr_t)(H1E_VAD_BASE_MAX + (H1E_VAD_OBJECT_BYTES - 1u)) == UINTPTR_MAX, "constants: the last object byte lands exactly on the top address, no wrap");
    CHECK(H1E_VAD_TAIL_OFFSET + sizeof(vadt_telemetry_t) == H1E_VAD_OBJECT_BYTES, "constants: tail ends at the object end");
    CHECK(H1E_VAD_SLOT_ADDRESS == 0x000852c0u, "constants: slot address");
}

static void expect_load_rejected(uintptr_t slot, const char *what)
{
    vadt_telemetry_t *tail = (vadt_telemetry_t *)(uintptr_t)0x1234u;
    uint8_t state = 0xAAu;
    int rc;

    reset(slot);
    rc = h1e_vad_load_object(NULL, &tail, &state);
    printf("%s: ", what);
    CHECK(rc != 0 && tail == NULL && state == 0u && g_slot_reads == 1, "rejected with tail NULL, state 0, one slot read, no access");
}

static void test_loader_rejects(void)
{
    uintptr_t aligned_wrap = H1E_VAD_BASE_MAX + 4u;

    expect_load_rejected(0u, "NULL slot");
    expect_load_rejected((uintptr_t)g_fault_page + 1u, "misaligned base +1 in a PROT_NONE page");
    expect_load_rejected((uintptr_t)g_fault_page + 2u, "misaligned base +2 in a PROT_NONE page");
    expect_load_rejected((uintptr_t)g_fault_page + 3u, "misaligned base +3 in a PROT_NONE page");
    expect_load_rejected(aligned_wrap, "aligned base just past the wrap limit");
    expect_load_rejected((uintptr_t)(UINTPTR_MAX - 3u), "aligned base at the top of the address space");
    expect_load_rejected(UINTPTR_MAX, "all-ones base");
    expect_load_rejected(H1E_VAD_BASE_MAX + 1u, "base one past the wrap limit");
}

static void test_loader_accepts(void)
{
    static const uint8_t states[] = { 0x00u, 0x03u, 0x05u, 0xFFu };
    unsigned i;

    for (i = 0u; i < sizeof states; ++i) {
        vadt_telemetry_t *tail = NULL;
        uint8_t state = 0xAAu;
        uint8_t before[sizeof(vadt_telemetry_t)];
        int rc;

        clear_object(states[i]);
        memset(tail_of(g_object), 0x5A, sizeof(vadt_telemetry_t));
        memcpy(before, tail_of(g_object), sizeof before);
        reset((uintptr_t)g_object);
        rc = h1e_vad_load_object(NULL, &tail, &state);

        CHECK(rc == 0, "valid: aligned extended object accepted");
        CHECK(tail == tail_of(g_object), "valid: tail is exactly object+0x40");
        CHECK(state == states[i], "valid: native state byte exposed as it is (no state 5 requirement)");
        CHECK(memcmp(before, tail_of(g_object), sizeof before) == 0, "valid: loader left the telemetry words untouched");
        CHECK(g_slot_reads == 1, "valid: slot read exactly once");
    }
}

static void expect_reply(const uint8_t *expect, vadt_status_t status, const uint8_t *reply, vadt_status_t returned, const char *what)
{
    printf("%s: ", what);
    CHECK(memcmp(expect, reply, VADT_REPLY_SIZE) == 0, "all 32 reply bytes match");
    CHECK((uint8_t)returned == reply[0] && returned == status, "return value equals reply[0] and the expected status");
}

static void check_guard_balanced(void)
{
    CHECK(g_enter_calls == 1 && g_exit_calls == 1 && g_depth == 0, "guard entered once and restored once");
    CHECK(g_exit_key_seen == 0x80000140u, "guard restored the exact saved key");
    CHECK(g_slot_reads == 1 && g_slot_read_depth == 1, "slot read exactly once, inside the guard");
}

static void test_reader_populated(void)
{
    static const uint8_t expect_template[VADT_REPLY_SIZE] = {
        0x00, 0x01, 0x01, 0x00,
        0x00, 0x00, 0x00, 0x02,
        0x00, 0x00, 0x00, 0x01,
        0xFF, 0xFF, 0xFF, 0xFB,
        0x01, 0x02, 0x03, 0x04,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x04};
    static const uint8_t states[] = { 0x07u, 0x00u };
    unsigned i;

    for (i = 0u; i < sizeof states; ++i) {
        uint8_t expect[VADT_REPLY_SIZE];
        uint8_t reply[VADT_REPLY_SIZE];
        vadt_status_t st;

        memcpy(expect, expect_template, sizeof expect);
        expect[3] = states[i];
        clear_object(states[i]);
        vadt_record_completed(tail_of(g_object), 0, 0x01020304u, 0u, 0);
        vadt_record_completed(tail_of(g_object), -5, 0u, 0u, 0);
        memset(reply, 0xA5, sizeof reply);
        reset((uintptr_t)g_object);
        st = h1e_vad_snapshot_read(NULL, reply);

        expect_reply(expect, VADT_OK, reply, st, "populated: OK, sample kept after a later failure, actual state byte");
        check_guard_balanced();
    }
}

static void test_reader_other_states(void)
{
    uint8_t reply[VADT_REPLY_SIZE];
    uint8_t expect[VADT_REPLY_SIZE];
    vadt_status_t st;
    int junk;

    memset(expect, 0, sizeof expect);
    expect[1] = 1u;
    expect[3] = 0xFFu;
    clear_object(0xFFu);
    memset(reply, 0xA5, sizeof reply);
    reset((uintptr_t)g_object);
    st = h1e_vad_snapshot_read(&junk, reply);
    expect_reply(expect, VADT_OK, reply, st, "fresh zero tail with a non-NULL ctx: OK, no sample, counters 0, ctx ignored");
    check_guard_balanced();

    memset(expect, 0, sizeof expect);
    expect[0] = 2u;
    expect[1] = 1u;
    memset(reply, 0xA5, sizeof reply);
    reset(0u);
    st = h1e_vad_snapshot_read(NULL, reply);
    expect_reply(expect, VADT_UNAVAILABLE, reply, st, "NULL slot: UNAVAILABLE, header only, native state 0");
    check_guard_balanced();

    memset(reply, 0xA5, sizeof reply);
    reset((uintptr_t)g_fault_page + 1u);
    st = h1e_vad_snapshot_read(NULL, reply);
    expect_reply(expect, VADT_UNAVAILABLE, reply, st, "misaligned base: UNAVAILABLE with no access to the PROT_NONE page");
    check_guard_balanced();

    memset(reply, 0xA5, sizeof reply);
    reset(H1E_VAD_BASE_MAX + 4u);
    st = h1e_vad_snapshot_read(NULL, reply);
    expect_reply(expect, VADT_UNAVAILABLE, reply, st, "wrapping base: UNAVAILABLE with no access");
    check_guard_balanced();
}

int main(void)
{
    map_memory();
    test_constants();
    test_loader_rejects();
    test_loader_accepts();
    test_reader_populated();
    test_reader_other_states();

    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
