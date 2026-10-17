#ifndef H1E_VOICE_ENERGY_REPLY_V2_H
#define H1E_VOICE_ENERGY_REPLY_V2_H

#include <stdint.h>

#include "h1e_voice_energy_cache.h"

#define H1E_VOICE_ENERGY_REPLY_V2_BYTES 32u
#define H1E_VOICE_ENERGY_REPLY_V2_VERSION 2u

typedef enum h1e_voice_energy_reply_status {
    H1E_VOICE_ENERGY_REPLY_OK = 0,
    H1E_VOICE_ENERGY_REPLY_BUSY = 1,
    H1E_VOICE_ENERGY_REPLY_UNAVAILABLE = 2
} h1e_voice_energy_reply_status_t;

/*
 * Encode only the fixed 32-byte payload. No frame/USB access or cache read is
 * performed here. The caller supplies a coherent snapshot and an envelope
 * status; raw provider status is a separate field in the encoded payload.
 */
int h1e_voice_energy_reply_v2_encode(
    uint8_t out[H1E_VOICE_ENERGY_REPLY_V2_BYTES],
    h1e_voice_energy_reply_status_t status,
    const h1e_voice_energy_snapshot_t *snapshot);

#endif
