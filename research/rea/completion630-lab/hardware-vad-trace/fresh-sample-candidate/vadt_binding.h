/*
 * vadt_binding: source-only native binding design for the vadt core.
 * NOT CONNECTED to any image, address or native function.
 *
 * The binding takes three things by injection: the original one-argument
 * getter, an IRQ guard, and an object loader. It contains no target address.
 * No object loader for RAM slot 0x852c0 is written, on purpose. See the
 * lifetime requirement below and CONTRACT.md section 7.
 *
 * Rules the binding enforces:
 *  - The original getter is called exactly once per poll, with the caller's
 *    pointer, outside the guard. Its status is returned unchanged. The caller's
 *    word is read only on status 0, outside the guard, and never written.
 *  - Metadata is updated only inside the guard, after load_object() has been
 *    called inside that same guard. A failed load skips the update and still
 *    returns the getter status.
 *  - The reader copies a bounded snapshot inside the guard and formats the
 *    reply after the guard has been restored.
 *  - The tail pointer from load_object() is never used after guard_exit().
 *
 * LIFETIME REQUIREMENT (unmet, so the binding stays unconnected):
 * load_object() may return non-NULL only for an object that cannot be freed
 * while the guard is held. The native constructor failure path at 01021060
 * frees the object (call at 01021074) BEFORE it clears slot 0x852c0 (store at
 * 0102107c). A slot check inside the guard cannot detect that window. The
 * slot clear must come first and must happen inside the same guard, then the
 * free. A peer is resolving detach-before-free. Until that order is in the
 * image and reviewed, no loader for 0x852c0 may be written. A local guard also
 * does not synchronize another core or the DSP.
 */
#ifndef VADT_BINDING_H
#define VADT_BINDING_H

#include "vadt_core.h"

/* The unchanged native getter ABI: one argument, integer status. */
typedef int32_t (*vadt_native_getter_fn)(uint32_t *out_word);

typedef struct vadt_binding_ops {
    void *ctx;
    /* Save the CPU interrupt state, mask interrupts, return the saved key. */
    uint32_t (*guard_enter)(void *ctx);
    /* Restore exactly the saved key, including when IE was already clear. */
    void (*guard_exit)(void *ctx, uint32_t key);
    /*
     * Called only inside the guard. Returns 0 and fills *tail and
     * *native_state for a live object, nonzero otherwise.
     */
    int (*load_object)(void *ctx, vadt_telemetry_t **tail, uint8_t *native_state);
} vadt_binding_ops_t;

/* Writer: one original getter call, then guarded metadata update. */
int32_t vadt_binding_poll(const vadt_binding_ops_t *ops, vadt_native_getter_fn getter,
                          uint32_t *native_word);

/*
 * Reader: guarded bounded snapshot, then the unclocked reply is formatted after
 * the guard is restored. Returns the status written to reply[0]. VADT_BUSY means
 * the sequence was odd or unstable, which a same-core guarded writer cannot
 * cause, so it points at an unguarded or foreign writer.
 */
vadt_status_t vadt_binding_read(const vadt_binding_ops_t *ops, uint8_t reply[VADT_REPLY_SIZE]);

/*
 * Adapter for code that wants the ctx-first vadt_read_fn shape. The one-argument
 * getter is stored in a struct and called through its real type. It is never
 * cast to a ctx-first function type.
 */
typedef struct vadt_getter_adapter_ctx {
    vadt_native_getter_fn getter;
} vadt_getter_adapter_ctx_t;

int32_t vadt_getter_adapter(void *ctx, uint32_t *out_word);

#endif
