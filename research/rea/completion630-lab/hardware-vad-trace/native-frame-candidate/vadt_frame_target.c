/*
 * C-SKY target adapter for the f11a frame logic. Isolated object only, never
 * linked into an image here. It decodes the 32-bit frame words into the shared
 * core in vadt_frame.c and supplies the target pending-command reader.
 *
 * Target binding contract (declared, not measured here): the pending command is
 * the volatile uint16 at RAM 0x000855dc, the same cell the frozen console630.c
 * reads for f117. Frame address words are 32-bit and cast directly to pointers.
 * The environment is built on the stack for each call; there is no global state.
 */
#include "vadt_frame.h"

#if !defined(__csky__)
#error "vadt_frame_target.c is C-SKY only"
#endif

#define VADT_TARGET_PENDING_CMD_ADDR 0x000855dcu

static uint8_t *target_resolve(void *ctx, uint32_t addr)
{
    (void)ctx;
    return (uint8_t *)(uintptr_t)addr;
}

static uint32_t target_pending(void *ctx)
{
    (void)ctx;
    return (uint32_t)*(volatile uint16_t *)(uintptr_t)VADT_TARGET_PENDING_CMD_ADDR;
}

int vadt_f11a_parse(uint8_t *frame, const uint8_t *body, uint32_t length)
{
    vadt_frame_env_t env;

    env.resolve = target_resolve;
    env.resolve_ctx = NULL;
    env.pending = target_pending;
    env.pending_ctx = NULL;
    return vadt_f11a_parse_frame(frame, body, length, &env);
}

int vadt_f11a_response(uint8_t *frame, vadt_f11a_read_fn read, void *read_ctx)
{
    vadt_frame_env_t env;

    env.resolve = target_resolve;
    env.resolve_ctx = NULL;
    env.pending = target_pending;
    env.pending_ctx = NULL;
    return vadt_f11a_response_frame(frame, &env, read, read_ctx);
}
