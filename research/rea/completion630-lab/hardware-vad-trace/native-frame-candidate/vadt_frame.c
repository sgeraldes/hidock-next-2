#include "vadt_frame.h"

/* Frame words are little-endian 32-bit (the target is elf32-csky-little). Byte composition avoids alignment assumptions. */
static uint32_t load_word(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint32_t be32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

int vadt_f11a_parse_frame(const uint8_t *frame, const uint8_t *body, uint32_t length,
                          const vadt_frame_env_t *env)
{
    uint8_t *head;
    const uint8_t *ctx;
    uint32_t cmd;
    uint32_t declared;
    int ok;

    if (frame == NULL || env == NULL || env->resolve == NULL || env->pending == NULL) {
        return -1;
    }
    head = env->resolve(env->resolve_ctx, load_word(frame + VADT_PARSE_OFF_HEAD));
    if (head == NULL) {
        return -1;
    }
    cmd = ((uint32_t)head[2] << 8) | (uint32_t)head[3];
    if (cmd != VADT_F11A_CMD) {
        return -1;
    }
    if (env->pending(env->pending_ctx) != cmd) {
        return -1;
    }

    ctx = env->resolve(env->resolve_ctx, load_word(frame + VADT_PARSE_OFF_CTX));
    declared = be32(head + 8);

    ok = body != NULL && ctx != NULL && length == VADT_F11A_REQ_LENGTH && declared == length &&
         load_word(ctx + VADT_CTX_OFF_FRAGMENT) == 0u && body[0] == VADT_F11A_REQ_VERSION;

    head[8] = ok ? 0u : 1u;
    head[9] = ok ? 1u : 0u;
    return ok ? 0 : 1;
}

static int reply_acceptable(vadt_status_t status, const uint8_t reply[VADT_F11A_RESP_TOTAL])
{
    unsigned st = (unsigned)status;
    size_t i;

    if (st > (unsigned)VADT_UNAVAILABLE) {
        return 0;
    }
    if (reply[0] != (uint8_t)st || reply[1] != (uint8_t)VADT_REPLY_VERSION) {
        return 0;
    }
    if (st == (unsigned)VADT_OK) {
        if ((reply[2] & (uint8_t)~VADT_REPLY_FLAG_HAS_SAMPLE) != 0u) {
            return 0;
        }
        for (i = 20u; i < 28u; ++i) {
            if (reply[i] != 0u) {
                return 0;
            }
        }
        return 1;
    }
    if (reply[2] != 0u) {
        return 0;
    }
    if (st == (unsigned)VADT_UNAVAILABLE && reply[3] != 0u) {
        return 0;
    }
    for (i = 4u; i < VADT_F11A_RESP_TOTAL; ++i) {
        if (reply[i] != 0u) {
            return 0;
        }
    }
    return 1;
}

int vadt_f11a_response_frame(const uint8_t *frame, const vadt_frame_env_t *env,
                             vadt_f11a_read_fn read, void *read_ctx)
{
    uint8_t *head;
    uint8_t *out;
    uint32_t capacity;
    uint8_t staged[VADT_F11A_RESP_TOTAL];
    vadt_status_t status;
    size_t i;

    if (frame == NULL || env == NULL || env->resolve == NULL) {
        return -1;
    }
    if (load_word(frame + VADT_RESP_OFF_CMD) != VADT_F11A_CMD) {
        return -1;
    }

    capacity = load_word(frame + VADT_RESP_OFF_CAP);
    head = env->resolve(env->resolve_ctx, load_word(frame + VADT_RESP_OFF_HEAD));
    out = env->resolve(env->resolve_ctx, load_word(frame + VADT_RESP_OFF_OUT));
    if (head == NULL || out == NULL || capacity == 0u) {
        return -2;
    }

    if (head[8] != 0u) {
        out[VADT_HDR_SIZE] = 1u;
        return 1;
    }
    if (head[9] != 1u || capacity < VADT_F11A_RESP_TOTAL || read == NULL) {
        return -2;
    }

    for (i = 0u; i < VADT_F11A_RESP_TOTAL; ++i) {
        staged[i] = 0u;
    }
    status = read(read_ctx, staged);
    if (!reply_acceptable(status, staged)) {
        return -2;
    }

    for (i = 0u; i < VADT_F11A_RESP_TOTAL; ++i) {
        out[VADT_HDR_SIZE + i] = staged[i];
    }
    return (int)VADT_F11A_RESP_TOTAL;
}
