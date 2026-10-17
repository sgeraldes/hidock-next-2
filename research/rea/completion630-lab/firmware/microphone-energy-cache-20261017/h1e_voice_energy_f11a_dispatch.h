#ifndef H1E_VOICE_ENERGY_F11A_DISPATCH_H
#define H1E_VOICE_ENERGY_F11A_DISPATCH_H

#include <stdint.h>

#if !defined(H1E_VOICE_ENERGY_F11A_DISPATCH_ADMITTED) || \
    ((H1E_VOICE_ENERGY_F11A_DISPATCH_ADMITTED + 0) != 1)
#error "F11A V2 dispatch requires explicit build admission"
#endif

/* Native console-hook ABI: parse(frame, body, length) and response(frame). */
int h1e_voice_energy_f11a_parse_shim(
    uint8_t *frame, const uint8_t *body, uint32_t length);
int h1e_voice_energy_f11a_response_shim(uint8_t *frame);

#endif
