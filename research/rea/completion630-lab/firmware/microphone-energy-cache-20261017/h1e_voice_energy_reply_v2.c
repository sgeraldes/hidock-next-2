#include "h1e_voice_energy_reply_v2.h"

static void put_be32(uint8_t *out, uint32_t value)
{
    out[0] = (uint8_t)(value >> 24);
    out[1] = (uint8_t)(value >> 16);
    out[2] = (uint8_t)(value >> 8);
    out[3] = (uint8_t)value;
}

int h1e_voice_energy_reply_v2_encode(
    uint8_t out[H1E_VOICE_ENERGY_REPLY_V2_BYTES],
    h1e_voice_energy_reply_status_t status,
    const h1e_voice_energy_snapshot_t *snapshot)
{
    size_t i;

    if (out == NULL || (unsigned)status > (unsigned)H1E_VOICE_ENERGY_REPLY_UNAVAILABLE ||
        (status == H1E_VOICE_ENERGY_REPLY_OK && snapshot == NULL)) {
        return -1;
    }

    for (i = 0u; i < H1E_VOICE_ENERGY_REPLY_V2_BYTES; ++i) {
        out[i] = 0u;
    }
    out[0] = (uint8_t)status;
    out[1] = (uint8_t)H1E_VOICE_ENERGY_REPLY_V2_VERSION;

    if (status != H1E_VOICE_ENERGY_REPLY_OK) {
        return 0;
    }

    if ((snapshot->flags & H1E_VOICE_ENERGY_HAS_SAMPLE) != 0u) {
        out[2] = (uint8_t)H1E_VOICE_ENERGY_HAS_SAMPLE;
    }
    put_be32(out + 4u, snapshot->attempted_reads);
    put_be32(out + 8u, snapshot->successful_reads);
    put_be32(out + 12u, (uint32_t)snapshot->last_attempt_status);
    put_be32(out + 16u, snapshot->last_good_raw_word);
    put_be32(out + 20u, snapshot->sequence);
    /* Bytes 24..31 are reserved and remain zero. */
    return 0;
}
