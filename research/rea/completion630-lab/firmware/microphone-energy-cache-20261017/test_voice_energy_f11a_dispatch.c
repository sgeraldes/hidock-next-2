#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define H1E_VOICE_ENERGY_F11A_DISPATCH_ADMITTED 1
#define H1E_VOICE_ENERGY_DISPATCH_HOST_TEST 1
#include "h1e_voice_energy_f11a_dispatch.h"

static uint8_t frame[0x40];
static uint8_t head[16];
static uint8_t context[0x14];
static uint8_t output[12u + 32u];
static uint8_t last_parse_body[2];
static uint32_t last_parse_length;
static unsigned parse_calls;
static unsigned response_calls;
static unsigned read_calls;

static void put_le32(uint8_t *p, uint32_t value)
{
    p[0] = (uint8_t)value;
    p[1] = (uint8_t)(value >> 8);
    p[2] = (uint8_t)(value >> 16);
    p[3] = (uint8_t)(value >> 24);
}

static void put_be32(uint8_t *p, uint32_t value)
{
    p[0] = (uint8_t)(value >> 24);
    p[1] = (uint8_t)(value >> 16);
    p[2] = (uint8_t)(value >> 8);
    p[3] = (uint8_t)value;
}

uint8_t *h1e_voice_energy_test_resolve(uint32_t address)
{
    if (address == 0x1000u) return head;
    if (address == 0x2000u) return output;
    if (address == 0x3000u) return context;
    return NULL;
}

int h1e_voice_energy_test_vad_parse(
    uint8_t *p_frame, const uint8_t *body, uint32_t length)
{
    uint32_t command;
    uint32_t declared;
    uint32_t ctx_address;
    uint8_t *ctx;
    parse_calls++;
    last_parse_length = length;
    last_parse_body[0] = body != NULL && length != 0u ? body[0] : 0xffu;
    last_parse_body[1] = body != NULL && length > 1u ? body[1] : 0xffu;
    if (p_frame == NULL) return -1;
    command = ((uint32_t)head[2] << 8) | head[3];
    if (command != 0xf11au) return -1;
    declared = ((uint32_t)head[8] << 24) | ((uint32_t)head[9] << 16) |
               ((uint32_t)head[10] << 8) | head[11];
    ctx_address = (uint32_t)p_frame[0x1c] | ((uint32_t)p_frame[0x1d] << 8) |
                  ((uint32_t)p_frame[0x1e] << 16) | ((uint32_t)p_frame[0x1f] << 24);
    ctx = h1e_voice_energy_test_resolve(ctx_address);
    if (body != NULL && length == 1u && declared == 1u && ctx != NULL &&
        ctx[0x10] == 0u && ctx[0x11] == 0u && ctx[0x12] == 0u &&
        ctx[0x13] == 0u && body[0] == 1u) {
        head[8] = 0u;
        head[9] = 1u;
        return 0;
    }
    head[8] = 1u;
    head[9] = 0u;
    return 1;
}

int h1e_voice_energy_test_vad_response(uint8_t *p_frame)
{
    (void)p_frame;
    response_calls++;
    return 0x2468;
}

int h1e_voice_energy_test_reply_v2_read(uint8_t reply[32])
{
    unsigned i;
    read_calls++;
    for (i = 0; i < 32u; ++i) reply[i] = 0u;
    reply[0] = 0u;
    reply[1] = 2u;
    reply[2] = 1u;
    reply[16] = 0x87u;
    reply[17] = 0x65u;
    reply[18] = 0x43u;
    reply[19] = 0x21u;
    return 0;
}

static void reset_parse(uint32_t command, uint32_t declared)
{
    memset(frame, 0, sizeof(frame));
    memset(head, 0, sizeof(head));
    memset(context, 0, sizeof(context));
    head[2] = (uint8_t)(command >> 8);
    head[3] = (uint8_t)command;
    put_be32(head + 8, declared);
    put_le32(frame + 0x14, 0x1000u);
    put_le32(frame + 0x1c, 0x3000u);
    parse_calls = 0u;
    last_parse_length = 0u;
    memset(last_parse_body, 0, sizeof(last_parse_body));
}

static void reset_response(uint32_t command, uint8_t state, uint32_t capacity)
{
    memset(frame, 0, sizeof(frame));
    memset(head, 0, sizeof(head));
    memset(output, 0xa5, sizeof(output));
    head[8] = 0u;
    head[9] = state;
    put_le32(frame + 0x18, command);
    put_le32(frame + 0x1c, 0x2000u);
    put_le32(frame + 0x20, capacity);
    put_le32(frame + 0x28, 0x1000u);
    response_calls = 0u;
    read_calls = 0u;
}

#define CHECK(expr, label) do { \
    if (!(expr)) { printf("FAIL %s\n", label); return 1; } \
    printf("PASS %s\n", label); \
} while (0)

int main(void)
{
    const uint8_t v2[] = { 2u };
    const uint8_t v1[] = { 1u };
    const uint8_t bad_v2[] = { 2u, 0u };

    reset_parse(0xf11au, 1u);
    CHECK(h1e_voice_energy_f11a_parse_shim(frame, v2, sizeof(v2)) == 0,
          "exact V2 selector accepts through VAD validation");
    CHECK(parse_calls == 1u && last_parse_body[0] == 1u && last_parse_length == 1u,
          "V2 common validation uses synthetic V1 token only");
    CHECK(v2[0] == 2u && head[8] == 0u && head[9] == 2u,
          "V2 preserves request bytes and records selector 2");

    reset_parse(0xf11au, 1u);
    CHECK(h1e_voice_energy_f11a_parse_shim(frame, v1, sizeof(v1)) == 0 &&
          last_parse_body[0] == 1u && head[9] == 1u,
          "V1 remains delegated unchanged");

    reset_parse(0xf117u, 1u);
    CHECK(h1e_voice_energy_f11a_parse_shim(frame, v2, sizeof(v2)) == -1 &&
          parse_calls == 1u && last_parse_body[0] == 2u,
          "F117 reaches the prior VAD-aware dispatcher unchanged");

    reset_parse(0xf11au, 2u);
    CHECK(h1e_voice_energy_f11a_parse_shim(frame, bad_v2, sizeof(bad_v2)) == 1 &&
          last_parse_length == 2u && last_parse_body[0] == 2u && head[9] == 0u,
          "non-exact V2-like frame is rejected by prior parser unchanged");

    reset_response(0xf11au, 2u, 32u);
    CHECK(h1e_voice_energy_f11a_response_shim(frame) == 32 && read_calls == 1u &&
          response_calls == 0u && output[12] == 0u && output[13] == 2u &&
          output[28] == 0x87u && output[31] == 0x21u,
          "state 2 emits the cache-only 32-byte V2 payload");

    reset_response(0xf11au, 1u, 32u);
    CHECK(h1e_voice_energy_f11a_response_shim(frame) == 0x2468 &&
          response_calls == 1u && read_calls == 0u,
          "V1 response remains delegated to prior VAD response");

    reset_response(0xf117u, 0u, 32u);
    CHECK(h1e_voice_energy_f11a_response_shim(frame) == 0x2468 &&
          response_calls == 1u && read_calls == 0u,
          "F117 response remains delegated to prior VAD response");

    reset_response(0xf11au, 2u, 31u);
    CHECK(h1e_voice_energy_f11a_response_shim(frame) == -2 && read_calls == 0u &&
          output[12] == 0xa5u,
          "short V2 capacity fails without query or partial output");

    printf("8 focused F11A dispatch cases passed\n");
    return 0;
}
