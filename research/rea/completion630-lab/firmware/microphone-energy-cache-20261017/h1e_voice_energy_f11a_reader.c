#include "h1e_voice_energy_f11a_reader.h"

#include "h1e_voice_energy_loader128.h"
#include "../../hardware-vad-trace/fresh-sample-candidate/vadt_binding.h"

typedef char h1e_voice_energy_tail_is_32_bytes[
    (sizeof(vadt_telemetry_t) == 0x20u) ? 1 : -1];

int h1e_voice_energy_f11a_reply_v2_read(
    uint8_t reply[H1E_VOICE_ENERGY_REPLY_V2_BYTES])
{
    h1e_voice_energy_snapshot_t snapshot;
    h1e_voice_energy_reply_status_t reply_status;
    vadt_telemetry_t *tail = NULL;
    h1e_voice_energy_cache_t *cache = NULL;
    uint8_t native_state = 0u;
    uint32_t key;
    int loaded;
    int live_object;
    h1e_voice_energy_snapshot_status_t snapshot_status;

    if (reply == NULL) {
        return -1;
    }

    key = vadt_csky_guard_enter(NULL);
    loaded = h1e_voice_energy_load_object_128(NULL, &tail, &native_state);
    (void)native_state;
    live_object = loaded == 0 && tail != NULL &&
                  (((uintptr_t)tail & (uintptr_t)3u) == 0u);
    if (live_object) {
        cache = (h1e_voice_energy_cache_t *)
            ((uint8_t *)tail + sizeof(vadt_telemetry_t));
        snapshot_status = h1e_voice_energy_cache_snapshot(cache, &snapshot);
    } else {
        snapshot_status = H1E_VOICE_ENERGY_SNAPSHOT_BUSY;
    }
    vadt_csky_guard_exit(NULL, key);
    tail = NULL;
    cache = NULL;
    (void)tail;
    (void)cache;

    if (!live_object) {
        reply_status = H1E_VOICE_ENERGY_REPLY_UNAVAILABLE;
    } else if (snapshot_status == H1E_VOICE_ENERGY_SNAPSHOT_BUSY) {
        reply_status = H1E_VOICE_ENERGY_REPLY_BUSY;
    } else {
        reply_status = H1E_VOICE_ENERGY_REPLY_OK;
    }

    if (h1e_voice_energy_reply_v2_encode(
            reply, reply_status,
            reply_status == H1E_VOICE_ENERGY_REPLY_OK ? &snapshot : NULL) != 0) {
        return -1;
    }
    return (int)reply[0];
}

int h1e_voice_energy_f11a_reply_select(
    uint8_t saved_parse_state,
    h1e_voice_energy_v1_reply_fn existing_v1,
    void *v1_ctx,
    uint8_t reply[H1E_VOICE_ENERGY_REPLY_V2_BYTES])
{
    if (saved_parse_state == 1u) {
        if (existing_v1 == NULL || reply == NULL) {
            return -1;
        }
        /* V1 remains byte-for-byte the existing response implementation. */
        return existing_v1(v1_ctx, reply);
    }
    if (saved_parse_state == 2u) {
        return h1e_voice_energy_f11a_reply_v2_read(reply);
    }
    return -1;
}
