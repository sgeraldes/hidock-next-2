/*
 * Host test for the real console630_parse / console630_response in
 * console630_f11a.c, built with -DH1E_DISPATCH_HOST_TEST. Everything below the
 * "test-only definitions" marker is test scaffolding and never ships.
 *
 * The shared f11a logic is the real vadt_frame.c. Only the thin target adapter
 * (vadt_frame_target.c, C-SKY only) is replaced here by recording wrappers that
 * call the same vadt_f11a_parse_frame / vadt_f11a_response_frame.
 */
#include <stdio.h>
#include <string.h>

#include "h1e_vad_snapshot.h"

int console630_parse(uint8_t *frame, const uint8_t *body, uint32_t length);
int console630_response(uint8_t *frame);

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

#define H_HEAD 0x1000u
#define H_CTX 0x2000u
#define H_OUT 0x3000u
#define GUARD 0xC3u

typedef union {
    uint32_t w[16];
    uint8_t b[64];
} buf64_t;

static buf64_t g_frame;
static buf64_t g_headbuf;
static buf64_t g_ctxbuf;
static buf64_t g_outbuf;

static struct {
    int pending_f117;
    int pending_f11a;
    int idle;
    int fb_parse;
    int fb_resp;
    int kernel;
    int fw;
    int uptime;
    int restore_parse;
    int restore_resp;
    int upload_parse;
    int upload_resp;
    int f11a_parse;
    int f11a_resp;
    int reader;
} c;

static uint32_t g_pending_value;
static uint32_t g_idle_value;
static uint32_t g_kernel_value;
static uint32_t g_fw_value;
static uint32_t g_uptime_value;

static uint8_t *a_fb_parse_frame;
static const uint8_t *a_fb_parse_body;
static uint32_t a_fb_parse_len;
static uint8_t *a_fb_resp_frame;
static uint8_t *a_restore_parse_frame;
static const uint8_t *a_restore_parse_body;
static uint32_t a_restore_parse_len;
static uint8_t *a_restore_resp_frame;
static uint8_t *a_upload_parse_frame;
static const uint8_t *a_upload_parse_body;
static uint32_t a_upload_parse_len;
static uint8_t *a_upload_resp_frame;
static uint8_t *a_f11a_parse_frame;
static const uint8_t *a_f11a_parse_body;
static uint32_t a_f11a_parse_len;
static vadt_f11a_read_fn a_f11a_resp_read;
static void *a_f11a_resp_ctx;
static void *a_reader_ctx;

/* ---- test-only definitions: seams, recorders, fake reader ------------------ */

uint8_t *h1e_test_resolve(uint32_t w)
{
    switch (w) {
    case H_HEAD:
        return g_headbuf.b;
    case H_CTX:
        return g_ctxbuf.b;
    case H_OUT:
        return g_outbuf.b;
    default:
        return NULL;
    }
}

uint32_t h1e_test_pending_cmd(void)
{
    c.pending_f117++;
    return g_pending_value;
}

uint32_t h1e_test_f117_idle(void)
{
    c.idle++;
    return g_idle_value;
}

int h1e_test_fallback_parse(uint8_t *frame, const uint8_t *body, uint32_t length)
{
    c.fb_parse++;
    a_fb_parse_frame = frame;
    a_fb_parse_body = body;
    a_fb_parse_len = length;
    return 7777;
}

int h1e_test_fallback_response(uint8_t *frame)
{
    c.fb_resp++;
    a_fb_resp_frame = frame;
    return 8888;
}

uint32_t h1e_test_kernel_version(void)
{
    c.kernel++;
    return g_kernel_value;
}

uint32_t h1e_test_fw_version(void)
{
    c.fw++;
    return g_fw_value;
}

uint32_t h1e_test_uptime_low(void)
{
    c.uptime++;
    return g_uptime_value;
}

int restore630_parse(uint8_t *frame, const uint8_t *body, uint32_t length)
{
    c.restore_parse++;
    a_restore_parse_frame = frame;
    a_restore_parse_body = body;
    a_restore_parse_len = length;
    return 1119;
}

int restore630_response(uint8_t *frame)
{
    c.restore_resp++;
    a_restore_resp_frame = frame;
    return 2119;
}

int upload630_parse(uint8_t *frame, const uint8_t *body, uint32_t length)
{
    c.upload_parse++;
    a_upload_parse_frame = frame;
    a_upload_parse_body = body;
    a_upload_parse_len = length;
    return 1118;
}

int upload630_response(uint8_t *frame)
{
    c.upload_resp++;
    a_upload_resp_frame = frame;
    return 2118;
}

static uint8_t *env_resolve(void *ctx, uint32_t addr)
{
    (void)ctx;
    return h1e_test_resolve(addr);
}

static uint32_t env_pending(void *ctx)
{
    (void)ctx;
    c.pending_f11a++;
    return g_pending_value;
}

static const vadt_frame_env_t g_vadt_env = {env_resolve, NULL, env_pending, NULL};

/* Stand-ins for the C-SKY adapter in vadt_frame_target.c: same shared logic, recorded arguments. */
int vadt_f11a_parse(uint8_t *frame, const uint8_t *body, uint32_t length)
{
    c.f11a_parse++;
    a_f11a_parse_frame = frame;
    a_f11a_parse_body = body;
    a_f11a_parse_len = length;
    return vadt_f11a_parse_frame(frame, body, length, &g_vadt_env);
}

int vadt_f11a_response(uint8_t *frame, vadt_f11a_read_fn read, void *read_ctx)
{
    c.f11a_resp++;
    a_f11a_resp_read = read;
    a_f11a_resp_ctx = read_ctx;
    return vadt_f11a_response_frame(frame, &g_vadt_env, read, read_ctx);
}

/* TEST-ONLY fake reader. The production symbol is deliberately not defined in the shipped sources. */
vadt_status_t h1e_vad_snapshot_read(void *ctx, uint8_t reply[VADT_REPLY_SIZE])
{
    size_t i;

    c.reader++;
    a_reader_ctx = ctx;
    for (i = 0u; i < VADT_REPLY_SIZE; ++i) {
        reply[i] = 0u;
    }
    reply[1] = 1u;
    reply[2] = VADT_REPLY_FLAG_HAS_SAMPLE;
    reply[3] = 5u;
    for (i = 4u; i < 20u; ++i) {
        reply[i] = (uint8_t)(0x40u + i);
    }
    reply[31] = 0x77u;
    return VADT_OK;
}

/* ---- scaffolding ----------------------------------------------------------- */

static void reset(uint32_t cmd, uint32_t declared)
{
    memset(&c, 0, sizeof c);
    memset(g_frame.b, 0xEE, sizeof g_frame.b);
    memset(g_headbuf.b, 0x5A, sizeof g_headbuf.b);
    g_headbuf.b[2] = (uint8_t)(cmd >> 8);
    g_headbuf.b[3] = (uint8_t)cmd;
    g_headbuf.b[8] = (uint8_t)(declared >> 24);
    g_headbuf.b[9] = (uint8_t)(declared >> 16);
    g_headbuf.b[10] = (uint8_t)(declared >> 8);
    g_headbuf.b[11] = (uint8_t)declared;
    memset(g_ctxbuf.b, 0, sizeof g_ctxbuf.b);
    memset(g_outbuf.b, GUARD, sizeof g_outbuf.b);
    g_pending_value = cmd;
    g_idle_value = 0u;
    g_kernel_value = 0u;
    g_fw_value = 0u;
    g_uptime_value = 0u;
    a_reader_ctx = (void *)&c;
}

static uint8_t *parse_frame(void)
{
    memset(g_frame.b, 0xEE, sizeof g_frame.b);
    g_frame.w[0x14u / 4u] = H_HEAD;
    g_frame.w[0x1cu / 4u] = H_CTX;
    return g_frame.b;
}

static uint8_t *resp_frame(uint32_t cmd, uint32_t capacity)
{
    memset(g_frame.b, 0xEE, sizeof g_frame.b);
    g_frame.w[0x18u / 4u] = cmd;
    g_frame.w[0x1cu / 4u] = H_OUT;
    g_frame.w[0x20u / 4u] = capacity;
    g_frame.w[0x28u / 4u] = H_HEAD;
    return g_frame.b;
}

static int out_untouched(void)
{
    size_t i;
    for (i = 0u; i < sizeof g_outbuf.b; ++i) {
        if (g_outbuf.b[i] != GUARD) {
            return 0;
        }
    }
    return 1;
}

static int no_getters(void)
{
    return c.kernel == 0 && c.fw == 0 && c.uptime == 0;
}

/* ---- tests ----------------------------------------------------------------- */

static void test_abi_shape(void)
{
    int (*resp)(uint8_t *) = console630_response;
    int (*parse)(uint8_t *, const uint8_t *, uint32_t) = console630_parse;

    CHECK(resp != NULL && parse != NULL, "ABI: console630_response is one-argument, console630_parse is three-argument");
}

static void test_f11a_route(void)
{
    static const uint8_t body[1] = {1u};
    uint8_t *pf;
    uint8_t *rf;
    int r;
    size_t i;
    int body_ok = 1;
    int guard_ok = 1;
    vadt_f11a_read_fn expected_reader = h1e_vad_snapshot_read;

    reset(0xf11au, 1u);
    pf = parse_frame();
    r = console630_parse(pf, body, 1u);
    CHECK(r == 0, "f11a parse: valid request returns 0 through console630_parse");
    CHECK(c.f11a_parse == 1 && a_f11a_parse_frame == pf && a_f11a_parse_body == body && a_f11a_parse_len == 1u,
          "f11a parse: routed once to vadt_f11a_parse with the same frame, body and length");
    CHECK(c.pending_f11a == 1 && c.pending_f117 == 0 && c.idle == 0,
          "f11a parse: pending command read by the f11a path, not by the f117 path");
    CHECK(g_headbuf.b[8] == 0u && g_headbuf.b[9] == 1u, "f11a parse: head[8]=0 head[9]=1 recorded");
    CHECK(c.fb_parse == 0 && c.restore_parse == 0 && c.upload_parse == 0, "f11a parse: no fallback, restore or upload call");

    rf = resp_frame(0xf11au, 64u);
    r = console630_response(rf);
    CHECK(r == 32, "f11a response: one-argument call returns 32");
    CHECK(c.f11a_resp == 1 && a_f11a_resp_read == expected_reader && a_f11a_resp_ctx == NULL,
          "f11a response: vadt_f11a_response(frame, h1e_vad_snapshot_read, NULL)");
    CHECK(c.reader == 1 && a_reader_ctx == NULL, "f11a response: injected reader called once with a NULL ctx");
    for (i = 0u; i < 32u; ++i) {
        uint8_t want = 0u;
        if (i == 1u) {
            want = 1u;
        } else if (i == 2u) {
            want = VADT_REPLY_FLAG_HAS_SAMPLE;
        } else if (i == 3u) {
            want = 5u;
        } else if (i >= 4u && i < 20u) {
            want = (uint8_t)(0x40u + i);
        } else if (i == 31u) {
            want = 0x77u;
        }
        if (g_outbuf.b[12u + i] != want) {
            body_ok = 0;
        }
    }
    for (i = 0u; i < sizeof g_outbuf.b; ++i) {
        if ((i < 12u || i >= 44u) && g_outbuf.b[i] != GUARD) {
            guard_ok = 0;
        }
    }
    CHECK(body_ok && guard_ok, "f11a response: out[12..43] is the 32-byte reply, header and tail untouched");
    CHECK(c.fb_resp == 0 && c.restore_resp == 0 && c.upload_resp == 0, "f11a response: no fallback, restore or upload call");
    CHECK(no_getters(), "f11a route: no kernel, firmware or uptime getter called");

    /* A rejected parse: bad version is recorded, response writes only the error byte, reader untouched. */
    {
        static const uint8_t bad[1] = {2u};
        reset(0xf11au, 1u);
        pf = parse_frame();
        r = console630_parse(pf, bad, 1u);
        CHECK(r == 1 && g_headbuf.b[8] == 1u, "f11a parse: bad version returns 1 and records the error");
        rf = resp_frame(0xf11au, 64u);
        r = console630_response(rf);
        CHECK(r == 1 && g_outbuf.b[12] == 1u && g_outbuf.b[13] == GUARD && c.reader == 0,
              "f11a response: recorded error writes only out[12]=1, reader not called");
    }
}

static void test_f117_unchanged(void)
{
    static const uint8_t help[4] = {'h', 'e', 'l', 'p'};
    static const uint8_t ver[7] = {'v', 'e', 'r', 's', 'i', 'o', 'n'};
    static const uint8_t upt[6] = {'u', 'p', 't', 'i', 'm', 'e'};
    static const uint8_t junk[4] = {'n', 'o', 'p', 'e'};
    uint8_t *pf;
    uint8_t *rf;
    int r;
    const char *text;
    size_t n;

    reset(0xf117u, 4u);
    pf = parse_frame();
    r = console630_parse(pf, help, 4u);
    CHECK(r == 0 && g_headbuf.b[8] == 0u && g_headbuf.b[9] == 1u && c.pending_f117 == 1 && c.idle == 1,
          "f117 parse: help selects 1, reads pending and idle cells");
    CHECK(c.f11a_parse == 0 && c.fb_parse == 0, "f117 parse: f11a and fallback not entered");

    reset(0xf117u, 7u);
    pf = parse_frame();
    CHECK(console630_parse(pf, ver, 7u) == 0 && g_headbuf.b[9] == 2u, "f117 parse: version selects 2");
    reset(0xf117u, 6u);
    pf = parse_frame();
    CHECK(console630_parse(pf, upt, 6u) == 0 && g_headbuf.b[9] == 3u, "f117 parse: uptime selects 3");
    reset(0xf117u, 4u);
    pf = parse_frame();
    CHECK(console630_parse(pf, junk, 4u) == 1 && g_headbuf.b[8] == 1u && g_headbuf.b[9] == 0u, "f117 parse: unknown text is rejected");

    reset(0xf117u, 4u);
    g_pending_value = 0xf118u;
    pf = parse_frame();
    {
        uint8_t head_before[sizeof g_headbuf.b];
        memcpy(head_before, g_headbuf.b, sizeof head_before);
        CHECK(console630_parse(pf, help, 4u) == -1 && memcmp(head_before, g_headbuf.b, sizeof head_before) == 0,
              "f117 parse: pending mismatch returns -1, head untouched");
    }
    reset(0xf117u, 4u);
    g_idle_value = 1u;
    pf = parse_frame();
    CHECK(console630_parse(pf, help, 4u) == 1, "f117 parse: nonzero idle cell is rejected");

    reset(0xf117u, 4u);
    g_headbuf.b[8] = 0u;
    g_headbuf.b[9] = 1u;
    rf = resp_frame(0xf117u, 64u);
    r = console630_response(rf);
    text = "help\nversion\nuptime\n";
    n = strlen(text);
    CHECK(r == (int)n + 1 && g_outbuf.b[12] == 0u && memcmp(g_outbuf.b + 13, text, n) == 0, "f117 response: help text");

    reset(0xf117u, 7u);
    g_headbuf.b[8] = 0u;
    g_headbuf.b[9] = 2u;
    g_kernel_value = 0x01020300u;
    g_fw_value = 0x00060300u;
    rf = resp_frame(0xf117u, 64u);
    r = console630_response(rf);
    text = "kernel=1.2.3 firmware=6.3.0\n";
    n = strlen(text);
    CHECK(r == (int)n + 1 && memcmp(g_outbuf.b + 13, text, n) == 0 && c.kernel == 1 && c.fw == 1 && c.uptime == 0,
          "f117 response: version text and its two getters");

    reset(0xf117u, 6u);
    g_headbuf.b[8] = 0u;
    g_headbuf.b[9] = 3u;
    g_uptime_value = 1234u;
    rf = resp_frame(0xf117u, 64u);
    r = console630_response(rf);
    text = "uptime_ms32=1234\n";
    n = strlen(text);
    CHECK(r == (int)n + 1 && memcmp(g_outbuf.b + 13, text, n) == 0 && c.uptime == 1 && c.kernel == 0,
          "f117 response: uptime text and its getter");

    reset(0xf117u, 4u);
    g_headbuf.b[8] = 1u;
    rf = resp_frame(0xf117u, 64u);
    CHECK(console630_response(rf) == 1 && g_outbuf.b[12] == 1u, "f117 response: recorded error writes out[12]=1");
    reset(0xf117u, 4u);
    g_headbuf.b[8] = 0u;
    g_headbuf.b[9] = 1u;
    rf = resp_frame(0xf117u, 0u);
    CHECK(console630_response(rf) == -2 && out_untouched(), "f117 response: capacity 0 returns -2, no write");
    CHECK(c.f11a_resp == 0 && c.fb_resp == 0, "f117 response: f11a and fallback not entered");
}

static void test_f118_f119(void)
{
    static const uint8_t body[1] = {1u};
    uint8_t *pf;
    uint8_t *rf;

    reset(0xf119u, 1u);
    pf = parse_frame();
    CHECK(console630_parse(pf, body, 1u) == 1119 && c.restore_parse == 1 && a_restore_parse_frame == pf &&
              a_restore_parse_body == body && a_restore_parse_len == 1u,
          "f119 parse: routed to restore630_parse with the same arguments");
    CHECK(c.upload_parse == 0 && c.f11a_parse == 0 && c.fb_parse == 0 && c.pending_f117 == 0, "f119 parse: nothing else entered");
    rf = resp_frame(0xf119u, 64u);
    CHECK(console630_response(rf) == 2119 && c.restore_resp == 1 && a_restore_resp_frame == rf, "f119 response: routed to restore630_response");

    reset(0xf118u, 1u);
    pf = parse_frame();
    CHECK(console630_parse(pf, body, 1u) == 1118 && c.upload_parse == 1 && a_upload_parse_frame == pf &&
              a_upload_parse_body == body && a_upload_parse_len == 1u,
          "f118 parse: routed to upload630_parse with the same arguments");
    CHECK(c.restore_parse == 0 && c.f11a_parse == 0 && c.fb_parse == 0 && c.pending_f117 == 0, "f118 parse: nothing else entered");
    rf = resp_frame(0xf118u, 64u);
    CHECK(console630_response(rf) == 2118 && c.upload_resp == 1 && a_upload_resp_frame == rf, "f118 response: routed to upload630_response");
    CHECK(c.f11a_resp == 0 && c.fb_resp == 0 && c.restore_resp == 0 && no_getters(), "f118 response: nothing else entered");
}

static void test_fallback(void)
{
    static const uint8_t body[2] = {1u, 2u};
    uint32_t cmds[2] = {0x1234u, 0xf11bu};
    size_t i;
    uint8_t *pf;
    uint8_t *rf;

    for (i = 0u; i < 2u; ++i) {
        reset(cmds[i], 2u);
        pf = parse_frame();
        CHECK(console630_parse(pf, body, 2u) == 7777 && c.fb_parse == 1 && a_fb_parse_frame == pf && a_fb_parse_body == body &&
                  a_fb_parse_len == 2u,
              i == 0u ? "fallback parse: unknown 0x1234 forwarded unchanged" : "fallback parse: neighbour 0xf11b forwarded unchanged");
        CHECK(c.f11a_parse == 0 && c.pending_f117 == 0 && c.restore_parse == 0 && c.upload_parse == 0,
              i == 0u ? "fallback parse: 0x1234 enters no handler" : "fallback parse: 0xf11b enters no handler");
        rf = resp_frame(cmds[i], 64u);
        CHECK(console630_response(rf) == 8888 && c.fb_resp == 1 && a_fb_resp_frame == rf,
              i == 0u ? "fallback response: unknown 0x1234 forwarded unchanged" : "fallback response: neighbour 0xf11b forwarded unchanged");
        CHECK(c.f11a_resp == 0 && out_untouched(), i == 0u ? "fallback response: 0x1234 no f11a, no write" : "fallback response: 0xf11b no f11a, no write");
    }
}

int main(void)
{
    test_abi_shape();
    test_f11a_route();
    test_f117_unchanged();
    test_f118_f119();
    test_fallback();

    printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
