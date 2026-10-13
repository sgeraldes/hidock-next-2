#include "vadt_binding.h"

int32_t vadt_getter_adapter(void *ctx, uint32_t *out_word)
{
    const vadt_getter_adapter_ctx_t *a = (const vadt_getter_adapter_ctx_t *)ctx;

    return a->getter(out_word);
}

int32_t vadt_binding_poll(const vadt_binding_ops_t *ops, vadt_native_getter_fn getter,
                          uint32_t *native_word)
{
    int32_t status = getter(native_word);
    uint32_t raw = 0u;
    uint32_t key;
    vadt_telemetry_t *tail = NULL;
    uint8_t native_state = 0u;

    if (status == 0) {
        raw = *native_word;
    }

    key = ops->guard_enter(ops->ctx);
    if (ops->load_object(ops->ctx, &tail, &native_state) == 0) {
        vadt_record_completed(tail, status, raw, 0u, 0);
    }
    ops->guard_exit(ops->ctx, key);

    return status;
}

vadt_status_t vadt_binding_read(const vadt_binding_ops_t *ops, uint8_t reply[VADT_REPLY_SIZE])
{
    vadt_snapshot_t snap;
    vadt_telemetry_t *tail = NULL;
    uint8_t native_state = 0u;
    vadt_status_t st = VADT_UNAVAILABLE;
    uint32_t key;

    key = ops->guard_enter(ops->ctx);
    if (ops->load_object(ops->ctx, &tail, &native_state) == 0) {
        st = vadt_snapshot(tail, &snap);
    }
    ops->guard_exit(ops->ctx, key);

    if (st == VADT_OK) {
        vadt_encode_reply(reply, st, &snap, native_state);
    } else {
        vadt_encode_reply(reply, st, NULL, st == VADT_UNAVAILABLE ? 0u : native_state);
    }
    return st;
}
