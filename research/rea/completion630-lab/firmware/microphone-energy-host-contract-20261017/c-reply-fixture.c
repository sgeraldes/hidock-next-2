#include <stdint.h>
#include <stdio.h>

#include "h1e_voice_energy_reply_v2.h"

static int print_reply(const char *label,
                       h1e_voice_energy_reply_status_t status,
                       const h1e_voice_energy_snapshot_t *snapshot)
{
    uint8_t bytes[H1E_VOICE_ENERGY_REPLY_V2_BYTES];
    size_t i;

    if (h1e_voice_energy_reply_v2_encode(bytes, status, snapshot) != 0) {
        return -1;
    }
    printf("%s ", label);
    for (i = 0u; i < sizeof(bytes); ++i) {
        printf("%02x", bytes[i]);
    }
    putchar('\n');
    return 0;
}

int main(void)
{
    h1e_voice_energy_snapshot_t snapshot = {
        0x11223344u,
        0xaabbccddu,
        0x01020304u,
        -7,
        0x87654321u,
        H1E_VOICE_ENERGY_HAS_SAMPLE
    };

    if (print_reply("ok-sample", H1E_VOICE_ENERGY_REPLY_OK, &snapshot) != 0) return 1;

    snapshot.flags = 0u;
    snapshot.successful_reads = 0u;
    snapshot.last_good_raw_word = 0u;
    if (print_reply("ok-no-sample", H1E_VOICE_ENERGY_REPLY_OK, &snapshot) != 0) return 2;

    snapshot.flags = H1E_VOICE_ENERGY_HAS_SAMPLE;
    snapshot.successful_reads = 0x01020304u;
    snapshot.last_good_raw_word = 0u;
    if (print_reply("ok-zero-sample", H1E_VOICE_ENERGY_REPLY_OK, &snapshot) != 0) return 3;

    if (print_reply("busy", H1E_VOICE_ENERGY_REPLY_BUSY, NULL) != 0) return 4;
    if (print_reply("unavailable", H1E_VOICE_ENERGY_REPLY_UNAVAILABLE, &snapshot) != 0) return 5;
    return 0;
}
