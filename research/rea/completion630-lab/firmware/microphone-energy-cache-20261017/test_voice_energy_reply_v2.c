#include <stdint.h>
#include <stdio.h>

#include "h1e_voice_energy_reply_v2.h"

static int bytes_equal(const uint8_t *actual, const uint8_t *expected, uint32_t count)
{
    uint32_t i;

    for (i = 0u; i < count; ++i) {
        if (actual[i] != expected[i]) {
            return 0;
        }
    }
    return 1;
}

int main(void)
{
    static const uint8_t expected_ok[H1E_VOICE_ENERGY_REPLY_V2_BYTES] = {
        0x00u, 0x02u, 0x01u, 0x00u,
        0xaau, 0xbbu, 0xccu, 0xddu,
        0x01u, 0x02u, 0x03u, 0x04u,
        0xffu, 0xffu, 0xffu, 0xf9u,
        0x87u, 0x65u, 0x43u, 0x21u,
        0x11u, 0x22u, 0x33u, 0x44u,
        0x00u, 0x00u, 0x00u, 0x00u,
        0x00u, 0x00u, 0x00u, 0x00u
    };
    uint8_t reply[H1E_VOICE_ENERGY_REPLY_V2_BYTES];
    h1e_voice_energy_snapshot_t snapshot;
    uint32_t i;

    snapshot.sequence = 0x11223344u;
    snapshot.attempted_reads = 0xaabbccddu;
    snapshot.successful_reads = 0x01020304u;
    snapshot.last_attempt_status = -7;
    snapshot.last_good_raw_word = 0x87654321u;
    snapshot.flags = H1E_VOICE_ENERGY_HAS_SAMPLE;
    if (h1e_voice_energy_reply_v2_encode(reply, H1E_VOICE_ENERGY_REPLY_OK,
                                         &snapshot) != 0 ||
        !bytes_equal(reply, expected_ok, H1E_VOICE_ENERGY_REPLY_V2_BYTES)) {
        return 1;
    }

    if (h1e_voice_energy_reply_v2_encode(reply, H1E_VOICE_ENERGY_REPLY_BUSY,
                                         NULL) != 0 ||
        reply[0] != 1u || reply[1] != 2u || reply[2] != 0u || reply[3] != 0u) {
        return 2;
    }
    for (i = 4u; i < H1E_VOICE_ENERGY_REPLY_V2_BYTES; ++i) {
        if (reply[i] != 0u) {
            return 3;
        }
    }

    if (h1e_voice_energy_reply_v2_encode(reply, H1E_VOICE_ENERGY_REPLY_UNAVAILABLE,
                                         &snapshot) != 0 ||
        reply[0] != 2u || reply[1] != 2u || reply[2] != 0u || reply[3] != 0u) {
        return 4;
    }
    for (i = 4u; i < H1E_VOICE_ENERGY_REPLY_V2_BYTES; ++i) {
        if (reply[i] != 0u) {
            return 5;
        }
    }

    puts("focused v2 payload codec cases passed");
    return 0;
}
