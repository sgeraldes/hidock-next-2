#include "h1e_voice_energy_loader128.h"

/* One volatile slot read, matching the accepted 96-byte loader's access. */
#define H1E_VOICE_ENERGY_SLOT_READ() \
    (*(volatile uintptr_t *)H1E_VOICE_ENERGY_OBJECT_SLOT)

typedef char h1e_voice_energy_loader_is_32_bit[
    (sizeof(void *) == 4u && sizeof(uintptr_t) == 4u) ? 1 : -1];

int h1e_voice_energy_load_object_128(void *ctx,
                                     vadt_telemetry_t **tail,
                                     uint8_t *native_state)
{
    uintptr_t base;

    (void)ctx;
    if (tail == NULL || native_state == NULL) {
        return 1;
    }
    *tail = NULL;
    *native_state = 0u;

    base = H1E_VOICE_ENERGY_SLOT_READ();
    if (base == 0u) {
        return 1;
    }
    /* Validate the complete proposed 0x80-byte extent before dereferencing. */
    if (base > (uintptr_t)(UINTPTR_MAX - (H1E_VOICE_ENERGY_OBJECT_EXTENT - 1u))) {
        return 1;
    }
    if (((base + H1E_VOICE_ENERGY_TAIL_OFFSET) & (uintptr_t)3u) != 0u) {
        return 1;
    }

    *native_state = *(const volatile uint8_t *)base;
    *tail = (vadt_telemetry_t *)(base + H1E_VOICE_ENERGY_TAIL_OFFSET);
    return 0;
}
