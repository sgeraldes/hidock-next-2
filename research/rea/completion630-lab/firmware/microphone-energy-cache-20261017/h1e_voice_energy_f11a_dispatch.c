#include "h1e_voice_energy_f11a_dispatch.h"

#include "h1e_voice_energy_f11a_reader.h"

#if defined(H1E_VOICE_ENERGY_DISPATCH_HOST_TEST)
#if defined(__csky__)
#error "host seams must never be selected by a C-SKY target build"
#endif
uint8_t *h1e_voice_energy_test_resolve(uint32_t address);
int h1e_voice_energy_test_vad_parse(
    uint8_t *frame, const uint8_t *body, uint32_t length);
int h1e_voice_energy_test_vad_response(uint8_t *frame);
int h1e_voice_energy_test_reply_v2_read(uint8_t reply[32]);
#define H1E_VE_RESOLVE(address) h1e_voice_energy_test_resolve(address)
#define H1E_VAD_PARSE(frame, body, length) \
    h1e_voice_energy_test_vad_parse((frame), (body), (length))
#define H1E_VAD_RESPONSE(frame) h1e_voice_energy_test_vad_response(frame)
#define H1E_V2_READ(reply) h1e_voice_energy_test_reply_v2_read(reply)
#else
#if !defined(__csky__)
#error "target dispatch requires C-SKY addresses; host tests use explicit seams"
#endif
extern int console630_vad_parse_current(
    uint8_t *frame, const uint8_t *body, uint32_t length);
extern int console630_vad_response_current(uint8_t *frame);
#define H1E_VE_RESOLVE(address) ((uint8_t *)(uintptr_t)(address))
#define H1E_VAD_PARSE(frame, body, length) \
    console630_vad_parse_current((frame), (body), (length))
#define H1E_VAD_RESPONSE(frame) console630_vad_response_current(frame)
#define H1E_V2_READ(reply) h1e_voice_energy_f11a_reply_v2_read(reply)
#endif

#define F11A_COMMAND 0xf11au
#define PARSE_HEAD_OFFSET 0x14u
#define RESPONSE_COMMAND_OFFSET 0x18u
#define RESPONSE_OUTPUT_OFFSET 0x1cu
#define RESPONSE_CAPACITY_OFFSET 0x20u
#define RESPONSE_HEAD_OFFSET 0x28u
#define RESPONSE_PAYLOAD_OFFSET 12u
#define RESPONSE_BYTES 32u

static uint32_t load_le32(const uint8_t *bytes)
{
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) |
           ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

static int v2_reply_is_valid(int status, const uint8_t reply[RESPONSE_BYTES])
{
    unsigned i;

    if (status < 0 || status > 2 || reply[0] != (uint8_t)status ||
        reply[1] != H1E_VOICE_ENERGY_REPLY_V2_VERSION || reply[3] != 0u) {
        return 0;
    }
    if (status == 0) {
        if ((reply[2] & (uint8_t)~1u) != 0u) {
            return 0;
        }
        for (i = 24u; i < RESPONSE_BYTES; ++i) {
            if (reply[i] != 0u) {
                return 0;
            }
        }
        return 1;
    }
    if (reply[2] != 0u) {
        return 0;
    }
    for (i = 4u; i < RESPONSE_BYTES; ++i) {
        if (reply[i] != 0u) {
            return 0;
        }
    }
    return 1;
}

int h1e_voice_energy_f11a_parse_shim(
    uint8_t *frame, const uint8_t *body, uint32_t length)
{
    static const uint8_t synthetic_v1_request = 1u;
    uint8_t *head;
    uint32_t command;
    int result;

    /* Reuse the accepted VAD parser for every ordinary request and all common
     * pending-command, fragment, declared-length, and pointer checks. For the
     * exact one-byte V2 selector only, present its V1-shaped validation byte,
     * then change just the saved selector after that parser accepts it.
     */
    if (frame != 0 && body != 0 && length == 1u && body[0] == 2u) {
        head = H1E_VE_RESOLVE(load_le32(frame + PARSE_HEAD_OFFSET));
        if (head != 0) {
            command = ((uint32_t)head[2] << 8) | (uint32_t)head[3];
            if (command == F11A_COMMAND) {
                result = H1E_VAD_PARSE(
                    frame, &synthetic_v1_request, 1u);
                if (result == 0) {
                    head[9] = 2u;
                }
                return result;
            }
        }
    }

    /* This is the VAD-aware dispatcher already in the exact system image:
     * F11A v1 and every other command (including F117) keep their routing. */
    return H1E_VAD_PARSE(frame, body, length);
}

int h1e_voice_energy_f11a_response_shim(uint8_t *frame)
{
    uint8_t *head;
    uint8_t *output;
    uint8_t staged[RESPONSE_BYTES];
    uint32_t command;
    uint32_t capacity;
    int status;
    unsigned i;

    if (frame == 0) {
        return -1;
    }
    command = load_le32(frame + RESPONSE_COMMAND_OFFSET);
    if (command != F11A_COMMAND) {
        return H1E_VAD_RESPONSE(frame);
    }

    head = H1E_VE_RESOLVE(load_le32(frame + RESPONSE_HEAD_OFFSET));
    if (head == 0 || head[8] != 0u || head[9] != 2u) {
        /* Preserve the accepted VAD response path for v1 and all error states. */
        return H1E_VAD_RESPONSE(frame);
    }

    capacity = load_le32(frame + RESPONSE_CAPACITY_OFFSET);
    output = H1E_VE_RESOLVE(load_le32(frame + RESPONSE_OUTPUT_OFFSET));
    if (output == 0 || capacity < RESPONSE_BYTES) {
        return -2;
    }

    for (i = 0u; i < RESPONSE_BYTES; ++i) {
        staged[i] = 0u;
    }
    status = H1E_V2_READ(staged);
    if (!v2_reply_is_valid(status, staged)) {
        return -2;
    }
    for (i = 0u; i < RESPONSE_BYTES; ++i) {
        output[RESPONSE_PAYLOAD_OFFSET + i] = staged[i];
    }
    return (int)RESPONSE_BYTES;
}
