#include <stdio.h>
#include <string.h>

#include "vadt_binding.h"
#include "vadt_frame.h"

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

/* Frame address words are small handles; the test resolver maps them to host buffers. */
#define H_HEAD 0x1000u
#define H_CTX 0x2000u
#define H_OUT 0x3000u

#define OUT_SIZE 64u
#define GUARD 0xC3u

static uint8_t g_head[16];
static uint8_t g_ctx[0x20];
static uint8_t g_out[OUT_SIZE];
static int g_head_null;
static int g_out_null;
static int g_ctx_null;

static int g_pending_calls;
static uint32_t g_pending_value;

static uint8_t *test_resolve(void *ctx, uint32_t addr)
{
    (void)ctx;
    if (addr == H_HEAD) {
        return g_head_null ? NULL : g_head;
    }
    if (addr == H_CTX) {
        return g_ctx_null ? NULL : g_ctx;
    }
    if (addr == H_OUT) {
        return g_out_null ? NULL : g_out;
    }
    return NULL;
}

static uint32_t test_pending(void *ctx)
{
    (void)ctx;
    g_pending_calls++;
    return g_pending_value;
}

static vadt_frame_env_t g_env = {test_resolve, NULL, test_pending, NULL};

static void put_le32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

static void put_be32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v >> 24);
    p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);
    p[3] = (uint8_t)v;
}

/* Reset the world: head with cmd and declared length, empty fragment state, guarded output. */
static void world(uint32_t cmd, uint32_t declared)
{
    memset(g_head, 0x5A, sizeof g_head);
    g_head[2] = (uint8_t)(cmd >> 8);
    g_head[3] = (uint8_t)cmd;
    put_be32(g_head + 8, declared);
    memset(g_ctx, 0, sizeof g_ctx);
    memset(g_out, GUARD, sizeof g_out);
    g_head_null = 0;
    g_out_null = 0;
    g_ctx_null = 0;
    g_pending_calls = 0;
    g_pending_value = cmd;
}

static void parse_frame_init(uint8_t frame[0x30])
{
    memset(frame, 0xEE, 0x30);
    put_le32(frame + VADT_PARSE_OFF_HEAD, H_HEAD);
    put_le32(frame + VADT_PARSE_OFF_CTX, H_CTX);
}

static void resp_frame_init(uint8_t frame[0x30], uint32_t cmd, uint32_t capacity)
{
    memset(frame, 0xEE, 0x30);
    put_le32(frame + VADT_RESP_OFF_CMD, cmd);
    put_le32(frame + VADT_RESP_OFF_OUT, H_OUT);
    put_le32(frame + VADT_RESP_OFF_CAP, capacity);
    put_le32(frame + VADT_RESP_OFF_HEAD, H_HEAD);
}

static int out_untouched(void)
{
    size_t i;
    for (i = 0u; i < OUT_SIZE; ++i) {
        if (g_out[i] != GUARD) {
            return 0;
        }
    }
    return 1;
}

/* Injected reader fake. */
typedef struct fake_reader {
    int calls;
    vadt_status_t status;
    uint8_t reply[VADT_REPLY_SIZE];
} fake_reader_t;

static vadt_status_t fake_reader_fn(void *ctx, uint8_t reply[VADT_REPLY_SIZE])
{
    fake_reader_t *r = (fake_reader_t *)ctx;
    r->calls++;
    memcpy(reply, r->reply, VADT_REPLY_SIZE);
    return r->status;
}

static void fake_reader_ok(fake_reader_t *r)
{
    size_t i;
    memset(r, 0, sizeof *r);
    r->status = VADT_OK;
    for (i = 0u; i < VADT_REPLY_SIZE; ++i) {
        r->reply[i] = 0u;
    }
    r->reply[0] = 0u;
    r->reply[1] = 1u;
    r->reply[2] = VADT_REPLY_FLAG_HAS_SAMPLE;
    r->reply[3] = 5u;
    for (i = 4u; i < 20u; ++i) {
        r->reply[i] = (uint8_t)(0x40u + i);
    }
    r->reply[31] = 0x77u;
}

/* ---- parser ---------------------------------------------------------------- */

static void test_parse_fallback(void)
{
    uint8_t frame[0x30];
    uint8_t head_before[sizeof g_head];
    uint8_t ctx_before[sizeof g_ctx];
    static const uint8_t body[1] = {1u};
    uint32_t cmds[3] = {0xf117u, 0xf119u, 0x1234u};
    size_t i;

    for (i = 0u; i < 3u; ++i) {
        world(cmds[i], 1u);
        parse_frame_init(frame);
        memcpy(head_before, g_head, sizeof g_head);
        memcpy(ctx_before, g_ctx, sizeof g_ctx);
        CHECK(vadt_f11a_parse_frame(frame, body, 1u, &g_env) == -1, "parse: other command returns -1");
        CHECK(memcmp(head_before, g_head, sizeof g_head) == 0 && memcmp(ctx_before, g_ctx, sizeof g_ctx) == 0,
              "parse: other command leaves head and ctx untouched");
        CHECK(g_pending_calls == 0, "parse: other command never reads the pending command");
    }

    world(0xf11au, 1u);
    parse_frame_init(frame);
    g_head_null = 1;
    CHECK(vadt_f11a_parse_frame(frame, body, 1u, &g_env) == -1, "parse: unresolved head returns -1");
    CHECK(vadt_f11a_parse_frame(NULL, body, 1u, &g_env) == -1, "parse: NULL frame returns -1");
    CHECK(vadt_f11a_parse_frame(frame, body, 1u, NULL) == -1, "parse: NULL env returns -1");
}

static void test_parse_valid(void)
{
    uint8_t frame[0x30];
    static const uint8_t body[1] = {1u};

    world(0xf11au, 1u);
    parse_frame_init(frame);
    CHECK(vadt_f11a_parse_frame(frame, body, 1u, &g_env) == 0, "parse: exact request returns 0");
    CHECK(g_head[8] == 0u && g_head[9] == 1u, "parse: exact request records head[8]=0 head[9]=1");
    CHECK(g_pending_calls == 1, "parse: pending command read exactly once");
    {
        /* world() set bytes 8..11 to the BE32 declared length 1; only bytes 8 and 9 may change. */
        size_t k;
        int rest_same = 1;
        for (k = 0u; k < sizeof g_head; ++k) {
            uint8_t want;
            if (k == 8u || k == 9u) {
                continue;
            }
            if (k == 2u) {
                want = 0xf1u;
            } else if (k == 3u) {
                want = 0x1au;
            } else if (k == 10u) {
                want = 0x00u;
            } else if (k == 11u) {
                want = 0x01u;
            } else {
                want = 0x5Au;
            }
            if (g_head[k] != want) {
                rest_same = 0;
            }
        }
        CHECK(rest_same, "parse: only head bytes 8 and 9 change");
    }
}

static void expect_bad_request(const char *name, const uint8_t *body, uint32_t length)
{
    uint8_t frame[0x30];
    char label[96];

    parse_frame_init(frame);
    snprintf(label, sizeof label, "parse: %s returns 1", name);
    CHECK(vadt_f11a_parse_frame(frame, body, length, &g_env) == 1, label);
    snprintf(label, sizeof label, "parse: %s records head[8]=1 head[9]=0", name);
    CHECK(g_head[8] == 1u && g_head[9] == 0u, label);
}

static void test_parse_rejects(void)
{
    static const uint8_t one[1] = {1u};
    static const uint8_t bad_version[1] = {2u};
    static const uint8_t two[2] = {1u, 1u};
    static const uint8_t zero_byte[1] = {0u};
    uint8_t frame[0x30];

    world(0xf11au, 0u);
    expect_bad_request("zero-length body", one, 0u);

    world(0xf11au, 2u);
    expect_bad_request("two-byte body", two, 2u);

    world(0xf11au, 1u);
    expect_bad_request("wrong version 2", bad_version, 1u);
    world(0xf11au, 1u);
    expect_bad_request("version 0", zero_byte, 1u);

    world(0xf11au, 1u);
    expect_bad_request("NULL body", NULL, 1u);

    world(0xf11au, 2u);
    expect_bad_request("declared length mismatch", one, 1u);

    world(0xf11au, 1u);
    put_le32(g_ctx + VADT_CTX_OFF_FRAGMENT, 5u);
    expect_bad_request("outstanding fragment", one, 1u);

    world(0xf11au, 1u);
    g_ctx_null = 1;
    expect_bad_request("unresolved ctx", one, 1u);

    /* Declared length is read before the head[8] write destroys it. */
    world(0xf11au, 1u);
    parse_frame_init(frame);
    CHECK(vadt_f11a_parse_frame(frame, one, 1u, &g_env) == 0, "parse: valid request still passes after rejects");

    /* Pending command mismatch is not recognized: -1, nothing written. */
    world(0xf11au, 1u);
    g_pending_value = 0xf117u;
    parse_frame_init(frame);
    {
        uint8_t head_before[sizeof g_head];
        memcpy(head_before, g_head, sizeof g_head);
        CHECK(vadt_f11a_parse_frame(frame, one, 1u, &g_env) == -1, "parse: pending mismatch returns -1");
        CHECK(memcmp(head_before, g_head, sizeof g_head) == 0, "parse: pending mismatch writes nothing");
    }
}

static void test_parse_body_not_read_before_length(void)
{
    uint8_t frame[0x30];
    uint8_t one_byte[1] = {1u};

    /* A two-byte request must be rejected on length alone, before body[0] is trusted. */
    world(0xf11au, 2u);
    parse_frame_init(frame);
    CHECK(vadt_f11a_parse_frame(frame, one_byte, 2u, &g_env) == 1 && g_head[8] == 1u,
          "parse: length 2 is rejected without needing a version byte");
}

/* ---- response -------------------------------------------------------------- */

static void test_resp_fallback(void)
{
    uint8_t frame[0x30];
    fake_reader_t r;

    fake_reader_ok(&r);
    world(0xf117u, 1u);
    resp_frame_init(frame, 0xf117u, 64u);
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == -1, "resp: other command returns -1");
    CHECK(out_untouched() && r.calls == 0 && g_pending_calls == 0, "resp: other command no write, no reader, no pending");
    CHECK(vadt_f11a_response_frame(NULL, &g_env, fake_reader_fn, &r) == -1, "resp: NULL frame returns -1");
}

static void test_resp_success(void)
{
    uint8_t frame[0x30];
    fake_reader_t r;
    size_t i;
    int body_ok = 1;
    int tail_ok = 1;
    int hdr_ok = 1;

    fake_reader_ok(&r);
    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    resp_frame_init(frame, 0xf11au, 64u);
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == 32, "resp: success returns 32");
    CHECK(r.calls == 1, "resp: reader called exactly once");
    for (i = 0u; i < 32u; ++i) {
        if (g_out[12u + i] != r.reply[i]) {
            body_ok = 0;
        }
    }
    CHECK(body_ok, "resp: out[12..43] equals the reader reply, status byte at out[12], no extra prefix");
    for (i = 0u; i < 12u; ++i) {
        if (g_out[i] != GUARD) {
            hdr_ok = 0;
        }
    }
    for (i = 44u; i < OUT_SIZE; ++i) {
        if (g_out[i] != GUARD) {
            tail_ok = 0;
        }
    }
    CHECK(hdr_ok && tail_ok, "resp: 12 byte header and bytes past 44 untouched");

    /* Exactly 32 capacity is enough. */
    fake_reader_ok(&r);
    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    resp_frame_init(frame, 0xf11au, 32u);
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == 32 && r.calls == 1, "resp: capacity exactly 32 succeeds");
}

static void test_resp_capacity(void)
{
    uint8_t frame[0x30];
    fake_reader_t r;
    uint32_t caps[2] = {0u, 31u};
    size_t i;

    for (i = 0u; i < 2u; ++i) {
        fake_reader_ok(&r);
        world(0xf11au, 1u);
        g_head[8] = 0u;
        g_head[9] = 1u;
        resp_frame_init(frame, 0xf11au, caps[i]);
        CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == -2,
              i == 0u ? "resp: capacity 0 returns -2" : "resp: capacity 31 returns -2");
        CHECK(r.calls == 0 && out_untouched(), i == 0u ? "resp: capacity 0 no reader call, no out write"
                                                       : "resp: capacity 31 no reader call, no out write");
    }

    /* Error record needs only capacity >= 1. */
    fake_reader_ok(&r);
    world(0xf11au, 1u);
    g_head[8] = 1u;
    g_head[9] = 0u;
    resp_frame_init(frame, 0xf11au, 1u);
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == 1, "resp: error record with capacity 1 returns 1");
    CHECK(g_out[12] == 1u && g_out[13] == GUARD && g_out[11] == GUARD && r.calls == 0,
          "resp: error writes only out[12]=1, reader never called");

    world(0xf11au, 1u);
    g_head[8] = 1u;
    g_head[9] = 0u;
    resp_frame_init(frame, 0xf11au, 0u);
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == -2 && out_untouched(),
          "resp: error record with capacity 0 returns -2, no write");
}

static void test_resp_null_and_unrecorded(void)
{
    uint8_t frame[0x30];
    fake_reader_t r;

    fake_reader_ok(&r);
    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    resp_frame_init(frame, 0xf11au, 64u);
    g_head_null = 1;
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == -2 && out_untouched() && r.calls == 0,
          "resp: NULL head returns -2, no write, no reader");

    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    g_out_null = 1;
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == -2 && r.calls == 0,
          "resp: NULL output returns -2, no reader");

    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 0u;
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == -2 && out_untouched() && r.calls == 0,
          "resp: no recorded valid request returns -2, no write, no reader");

    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    CHECK(vadt_f11a_response_frame(frame, &g_env, NULL, NULL) == -2 && out_untouched(),
          "resp: no reader injected returns -2, no write");
}

static void test_resp_bad_reader_result(void)
{
    uint8_t frame[0x30];
    fake_reader_t r;

    /* Each of these must leave the output untouched. */
    fake_reader_ok(&r);
    r.status = (vadt_status_t)3;
    r.reply[0] = 3u;
    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    resp_frame_init(frame, 0xf11au, 64u);
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == -2 && out_untouched() && r.calls == 1,
          "resp: reader status 3 (not a defined status) rejected, no partial out");

    fake_reader_ok(&r);
    r.reply[0] = 1u;
    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == -2 && out_untouched(),
          "resp: reply[0] differing from the returned status rejected");

    fake_reader_ok(&r);
    r.reply[1] = 2u;
    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == -2 && out_untouched(),
          "resp: reply version other than 1 rejected");

    fake_reader_ok(&r);
    r.reply[2] = (uint8_t)(VADT_REPLY_FLAG_HAS_SAMPLE | VADT_REPLY_FLAG_AGE_VALID);
    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == -2 && out_untouched(),
          "resp: OK reply with AGE_VALID rejected (first binding is unclocked)");

    fake_reader_ok(&r);
    r.reply[22] = 1u;
    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == -2 && out_untouched(),
          "resp: OK reply with nonzero age word rejected");

    fake_reader_ok(&r);
    r.status = VADT_BUSY;
    r.reply[0] = 1u;
    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == -2 && out_untouched(),
          "resp: BUSY reply with nonzero tail or flags rejected");

    fake_reader_ok(&r);
    r.status = VADT_UNAVAILABLE;
    memset(r.reply, 0, sizeof r.reply);
    r.reply[0] = 2u;
    r.reply[1] = 1u;
    r.reply[3] = 4u;
    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    CHECK(vadt_f11a_response_frame(frame, &g_env, fake_reader_fn, &r) == -2 && out_untouched(),
          "resp: UNAVAILABLE with nonzero nativeState rejected");
}

/* ---- real vadt_binding_read as the reader, no DSP call -------------------- */

typedef struct bind_env {
    int load_fail;
    vadt_telemetry_t *tail;
    uint8_t native_state;
    int enter_calls;
    int exit_calls;
} bind_env_t;

static int g_getter_calls;

static int32_t never_called_getter(uint32_t *out)
{
    (void)out;
    g_getter_calls++;
    return 0;
}

static uint32_t b_enter(void *ctx)
{
    ((bind_env_t *)ctx)->enter_calls++;
    return 0x40u;
}

static void b_exit(void *ctx, uint32_t key)
{
    (void)key;
    ((bind_env_t *)ctx)->exit_calls++;
}

static int b_load(void *ctx, vadt_telemetry_t **tail, uint8_t *native_state)
{
    bind_env_t *e = (bind_env_t *)ctx;
    if (e->load_fail) {
        return 1;
    }
    *tail = e->tail;
    *native_state = e->native_state;
    return 0;
}

static void test_resp_with_binding_reader(void)
{
    uint8_t frame[0x30];
    vadt_telemetry_t t;
    bind_env_t be;
    vadt_binding_ops_t ops;
    static const uint8_t ok_expect[32] = {
        0x00, 0x01, 0x01, 0x05,
        0x00, 0x00, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x02};

    g_getter_calls = 0;
    (void)never_called_getter;
    memset(&be, 0, sizeof be);
    vadt_init(&t);
    be.tail = &t;
    be.native_state = 5u;
    ops.ctx = &be;
    ops.guard_enter = b_enter;
    ops.guard_exit = b_exit;
    ops.load_object = b_load;

    /* A fresh object has no sample: OK with no flags. Then one valid-zero success. */
    vadt_record_completed(&t, 0, 0u, 0u, 0);

    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    resp_frame_init(frame, 0xf11au, 32u);
    CHECK(vadt_f11a_response_frame(frame, &g_env, vadt_f11a_binding_reader, &ops) == 32, "binding reader: OK path returns 32");
    CHECK(memcmp(g_out + 12, ok_expect, 32u) == 0, "binding reader: valid-zero sample bytes, HAS_SAMPLE only, age words zero");
    CHECK(be.enter_calls == 1 && be.exit_calls == 1, "binding reader: guard entered and left once");

    be.load_fail = 1;
    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    CHECK(vadt_f11a_response_frame(frame, &g_env, vadt_f11a_binding_reader, &ops) == 32, "binding reader: UNAVAILABLE passed as 32 bytes");
    {
        size_t i;
        int zero_rest = 1;
        for (i = 13u; i < 44u; ++i) {
            if (i == 13u) {
                continue;
            }
            if (g_out[i] != 0u) {
                zero_rest = 0;
            }
        }
        CHECK(g_out[12] == 2u && g_out[13] == 1u && g_out[14] == 0u && g_out[15] == 0u && zero_rest,
              "binding reader: UNAVAILABLE body is status 2, version 1, nativeState 0, rest zero");
    }

    be.load_fail = 0;
    be.native_state = 9u;
    t.sequence = 1u;
    world(0xf11au, 1u);
    g_head[8] = 0u;
    g_head[9] = 1u;
    CHECK(vadt_f11a_response_frame(frame, &g_env, vadt_f11a_binding_reader, &ops) == 32, "binding reader: BUSY passed as 32 bytes");
    CHECK(g_out[12] == 1u && g_out[13] == 1u && g_out[14] == 0u && g_out[15] == 9u && g_out[16] == 0u && g_out[43] == 0u,
          "binding reader: BUSY keeps raw nativeState 9, zero tail");
    CHECK(g_getter_calls == 0, "binding reader: no DSP getter exists on this path");
}

int main(void)
{
    test_parse_fallback();
    test_parse_valid();
    test_parse_rejects();
    test_parse_body_not_read_before_length();
    test_resp_fallback();
    test_resp_success();
    test_resp_capacity();
    test_resp_null_and_unrecorded();
    test_resp_bad_reader_result();
    test_resp_with_binding_reader();

    printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
