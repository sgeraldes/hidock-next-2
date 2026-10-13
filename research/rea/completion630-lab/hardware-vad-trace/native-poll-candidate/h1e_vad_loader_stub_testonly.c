/*
 * TEST ONLY. Not a binding, not a candidate loader, not for any image.
 * It exists so an isolated link of the wrapper objects can resolve the one
 * external symbol. It always reports the object as unavailable, so a wrapper
 * linked against it can never record metadata.
 */
#include "h1e_vad_native_poll.h"

const char h1e_vad_loader_stub_version[] = "TESTONLY-UNAVAILABLE-STUB-v1 not a real binding";

int h1e_vad_load_object(void *ctx, vadt_telemetry_t **tail, uint8_t *native_state)
{
    (void)ctx;
    (void)tail;
    (void)native_state;
    return 1;
}
