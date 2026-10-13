/*
 * vadt_frame: narrow native Jensen parser and response adapter for the
 * tentative f11a VAD snapshot command. Source candidate only.
 * NOT CONNECTED: no hook is installed, f11a is not allocated in any image,
 * and the snapshot reader is injected by the caller.
 *
 * Build with -I<fresh-sample-candidate> for vadt_core.h (VADT_REPLY_SIZE,
 * vadt_status_t). That folder is read only here.
 *
 * Frame offsets are the ones used by the frozen console630.c hooks:
 *   parser:   frame+0x14 word = head pointer, frame+0x1c word = ctx pointer
 *   response: frame+0x18 word = command, frame+0x1c word = output header base,
 *             frame+0x20 word = payload capacity (excludes the 12 byte header),
 *             frame+0x28 word = head pointer
 * head: command BE16 at +2, declared body length BE32 at +8 (so writing
 * head[8] and head[9] destroys it; the parser reads it first).
 * ctx: fragment state word at +0x10, zero means no outstanding fragment.
 *
 * Pointer extents are not known from the frame. The core checks pointers for
 * NULL only and assumes the dispatcher contract: head >= 12 bytes, ctx >= 0x14
 * bytes, body >= length bytes, output >= 12 + capacity bytes. It never reads
 * body[0] before checking length == 1.
 */
#ifndef VADT_FRAME_H
#define VADT_FRAME_H

#include <stddef.h>
#include <stdint.h>

#include "vadt_core.h"

#define VADT_F11A_CMD 0xf11au
#define VADT_F11A_REQ_VERSION 1u
#define VADT_F11A_REQ_LENGTH 1u
#define VADT_F11A_RESP_TOTAL 32u
#define VADT_HDR_SIZE 12u

#define VADT_PARSE_OFF_HEAD 0x14u
#define VADT_PARSE_OFF_CTX 0x1cu
#define VADT_RESP_OFF_CMD 0x18u
#define VADT_RESP_OFF_OUT 0x1cu
#define VADT_RESP_OFF_CAP 0x20u
#define VADT_RESP_OFF_HEAD 0x28u
#define VADT_CTX_OFF_FRAGMENT 0x10u

typedef char vadt_resp_total_must_equal_core_reply[(VADT_F11A_RESP_TOTAL == VADT_REPLY_SIZE) ? 1 : -1];

/* Turn a 32-bit address word from the frame into a usable pointer. Target: identity cast. */
typedef uint8_t *(*vadt_resolve_fn)(void *ctx, uint32_t addr);
/* Value of the pending command (volatile uint16 at 0x855dc on target), zero extended. */
typedef uint32_t (*vadt_pending_fn)(void *ctx);

typedef struct vadt_frame_env {
    vadt_resolve_fn resolve;
    void *resolve_ctx;
    vadt_pending_fn pending;
    void *pending_ctx;
} vadt_frame_env_t;

/*
 * Snapshot reader, the existing unclocked vadt_binding_read shape: fills all
 * 32 bytes of reply and returns the status written in reply[0]. It must not
 * call the DSP getter.
 */
typedef vadt_status_t (*vadt_f11a_read_fn)(void *ctx, uint8_t reply[VADT_REPLY_SIZE]);

/*
 * Parser. Returns:
 *   -1  not f11a, head unresolved, or pending command differs. No writes, so
 *       the caller can fall back. The pending reader runs only for f11a.
 *    0  valid request: head[8] = 0, head[9] = 1.
 *    1  recognized request with a bad body or bad framing: head[8] = 1,
 *       head[9] = 0. The declared length is read before these writes.
 */
int vadt_f11a_parse_frame(const uint8_t *frame, const uint8_t *body, uint32_t length,
                          const vadt_frame_env_t *env);

/*
 * Response. Returns:
 *   -1  command is not f11a. Nothing else is read or written.
 *   -2  NULL head or output, capacity 0, no valid recorded request, capacity
 *       below 32, no reader, or a reader result that fails the checks below.
 *       Nothing is written to the output and, for capacity or NULL failures,
 *       the reader is not called.
 *    1  recorded bad request, capacity >= 1: out[12] = 1.
 *   32  success: out[12..43] is the reader's reply, byte 0 is its status.
 * The reader fills a local 32 byte buffer first, so a rejected reply leaves
 * the output untouched. Accepted replies: status 0, 1 or 2 equal to reply[0];
 * reply[1] == 1; OK flags only HAS_SAMPLE and both age words zero (unclocked);
 * BUSY and UNAVAILABLE have flags zero and bytes 4..31 zero; UNAVAILABLE byte 3
 * is zero.
 */
int vadt_f11a_response_frame(const uint8_t *frame, const vadt_frame_env_t *env,
                             vadt_f11a_read_fn read, void *read_ctx);

/* Reader backed by the existing vadt_binding_read. ctx is a const vadt_binding_ops_t *. */
vadt_status_t vadt_f11a_binding_reader(void *ctx, uint8_t reply[VADT_REPLY_SIZE]);

/*
 * Target adapter (C-SKY only, vadt_frame_target.c). Native ABI shapes, not
 * installed anywhere. There is deliberately no one-argument response: the
 * reader must be supplied by whoever connects the binding.
 */
int vadt_f11a_parse(uint8_t *frame, const uint8_t *body, uint32_t length);
int vadt_f11a_response(uint8_t *frame, vadt_f11a_read_fn read, void *read_ctx);

#endif
