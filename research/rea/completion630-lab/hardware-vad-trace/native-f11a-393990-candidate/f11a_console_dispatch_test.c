/* Focused host exercise of the real F11A-only dispatch functions. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "h1e_vad_snapshot.h"

int console630_parse(uint8_t *frame, const uint8_t *body, uint32_t length);
int console630_response(uint8_t *frame);

static unsigned checks;
static unsigned failures;
static uint8_t frame[0x40];
static uint8_t head[16];
static const uint8_t body[7] = { 'v', 'e', 'c', 't', 'o', 'r', 's' };
static uint8_t *parse_frame_seen;
static const uint8_t *parse_body_seen;
static uint32_t parse_length_seen;
static uint8_t *response_frame_seen;
static vadt_f11a_read_fn vad_reader_seen;
static void *vad_reader_ctx_seen;
static unsigned current_parse_calls;
static unsigned current_response_calls;
static unsigned vad_parse_calls;
static unsigned vad_response_calls;
static int current_parse_result;
static int current_response_result;
static int vad_parse_result;
static int vad_response_result;

#define CHECK(condition, description)                                      \
    do {                                                                   \
        checks++;                                                          \
        if (condition) {                                                   \
            printf("PASS %s\n", description);                            \
        } else {                                                           \
            failures++;                                                    \
            printf("FAIL %s\n", description);                            \
        }                                                                  \
    } while (0)

static void store_le32(uint8_t *p, uint32_t value)
{
    p[0] = (uint8_t)value;
    p[1] = (uint8_t)(value >> 8);
    p[2] = (uint8_t)(value >> 16);
    p[3] = (uint8_t)(value >> 24);
}

static void set_parse_command(uint32_t command, uint32_t head_word)
{
    memset(frame, 0, sizeof(frame));
    memset(head, 0, sizeof(head));
    head[2] = (uint8_t)(command >> 8);
    head[3] = (uint8_t)command;
    store_le32(frame + 0x14u, head_word);
}

static void set_response_command(uint32_t command)
{
    memset(frame, 0, sizeof(frame));
    store_le32(frame + 0x18u, command);
}

static void reset_observations(void)
{
    parse_frame_seen = NULL;
    parse_body_seen = NULL;
    parse_length_seen = 0u;
    response_frame_seen = NULL;
    vad_reader_seen = NULL;
    vad_reader_ctx_seen = (void *)(uintptr_t)1u;
    current_parse_calls = 0u;
    current_response_calls = 0u;
    vad_parse_calls = 0u;
    vad_response_calls = 0u;
    current_parse_result = 0x1357;
    current_response_result = 0x2468;
    vad_parse_result = -7;
    vad_response_result = 32;
}

uint8_t *f11a_test_resolve(uint32_t word)
{
    if (word == 0x1000u) {
        return head;
    }
    return NULL;
}

int f11a_test_current_parse(uint8_t *p_frame, const uint8_t *p_body, uint32_t length)
{
    current_parse_calls++;
    parse_frame_seen = p_frame;
    parse_body_seen = p_body;
    parse_length_seen = length;
    p_frame[0x3fu] = 0x5au;
    return current_parse_result;
}

int f11a_test_current_response(uint8_t *p_frame)
{
    current_response_calls++;
    response_frame_seen = p_frame;
    p_frame[0x3eu] = 0xa5u;
    return current_response_result;
}

int vadt_f11a_parse(uint8_t *p_frame, const uint8_t *p_body, uint32_t length)
{
    vad_parse_calls++;
    parse_frame_seen = p_frame;
    parse_body_seen = p_body;
    parse_length_seen = length;
    p_frame[0x3du] = 0x3cu;
    return vad_parse_result;
}

int vadt_f11a_response(uint8_t *p_frame, vadt_f11a_read_fn reader, void *reader_ctx)
{
    vad_response_calls++;
    response_frame_seen = p_frame;
    vad_reader_seen = reader;
    vad_reader_ctx_seen = reader_ctx;
    p_frame[0x3cu] = 0xc3u;
    return vad_response_result;
}

vadt_status_t h1e_vad_snapshot_read(void *ctx, uint8_t reply[VADT_REPLY_SIZE])
{
    (void)ctx;
    (void)reply;
    return (vadt_status_t)0;
}

static void test_parser_forwarding(uint32_t command, const char *label)
{
    reset_observations();
    set_parse_command(command, 0x1000u);
    CHECK(console630_parse(frame, body, sizeof(body)) == current_parse_result, label);
    CHECK(current_parse_calls == 1u && vad_parse_calls == 0u,
          "non-F11A parser selects current console only");
    CHECK(parse_frame_seen == frame && parse_body_seen == body && parse_length_seen == sizeof(body),
          "current parser receives identical arguments");
    CHECK(frame[0x3fu] == 0x5au, "current parser output mutation is visible");
}

static void test_response_forwarding(uint32_t command, const char *label)
{
    reset_observations();
    set_response_command(command);
    CHECK(console630_response(frame) == current_response_result, label);
    CHECK(current_response_calls == 1u && vad_response_calls == 0u,
          "non-F11A response selects current console only");
    CHECK(response_frame_seen == frame, "current response receives identical frame");
    CHECK(frame[0x3eu] == 0xa5u, "current response output mutation is visible");
}

int main(void)
{
    reset_observations();
    set_parse_command(0xf117u, 0x1000u);
    test_parser_forwarding(0xf117u, "F117 parser result forwards unchanged");

    test_parser_forwarding(0xf114u, "F114 parser result forwards unchanged");

    reset_observations();
    set_parse_command(0xf11au, 0x1000u);
    CHECK(console630_parse(frame, body, 3u) == vad_parse_result, "F11A parser result is returned unchanged");
    CHECK(vad_parse_calls == 1u && current_parse_calls == 0u, "F11A parser selects VAD handler only");
    CHECK(parse_frame_seen == frame && parse_body_seen == body && parse_length_seen == 3u,
          "F11A parser receives identical arguments");
    CHECK(frame[0x3du] == 0x3cu, "F11A parser output mutation is visible");

    reset_observations();
    CHECK(console630_parse(NULL, body, 1u) == -1, "NULL parser frame is rejected");
    CHECK(current_parse_calls == 0u && vad_parse_calls == 0u, "NULL parser frame calls no handler");

    reset_observations();
    set_parse_command(0xf117u, 0xdeadbeefu);
    CHECK(console630_parse(frame, body, sizeof(body)) == -1, "unresolved parser head is rejected");
    CHECK(current_parse_calls == 0u && vad_parse_calls == 0u, "unresolved parser head calls no handler");

    test_response_forwarding(0xf117u, "F117 response result forwards unchanged");
    test_response_forwarding(0xf114u, "F114 response result forwards unchanged");

    reset_observations();
    set_response_command(0xf11au);
    CHECK(console630_response(frame) == vad_response_result, "F11A response result is returned unchanged");
    CHECK(vad_response_calls == 1u && current_response_calls == 0u, "F11A response selects VAD handler only");
    CHECK(response_frame_seen == frame, "F11A response receives identical frame");
    CHECK(vad_reader_seen == h1e_vad_snapshot_read && vad_reader_ctx_seen == NULL,
          "F11A response receives the native snapshot reader and NULL context");
    CHECK(frame[0x3cu] == 0xc3u, "F11A response output mutation is visible");

    reset_observations();
    CHECK(console630_response(NULL) == -1, "NULL response frame is rejected");
    CHECK(current_response_calls == 0u && vad_response_calls == 0u,
          "NULL response frame calls no handler");

    printf("%u checks, %u failures\n", checks, failures);
    return failures == 0u ? 0 : 1;
}
