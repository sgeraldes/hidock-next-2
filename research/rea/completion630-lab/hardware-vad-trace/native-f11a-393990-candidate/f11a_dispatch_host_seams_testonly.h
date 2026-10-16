/* Test-only replacements for the current-console import and 32-bit pointer map. */
#ifndef H1E_F11A_DISPATCH_HOST_SEAMS_TESTONLY_H
#define H1E_F11A_DISPATCH_HOST_SEAMS_TESTONLY_H

#include <stdint.h>

extern uint8_t *f11a_test_resolve(uint32_t word);
extern int f11a_test_current_parse(uint8_t *frame, const uint8_t *body, uint32_t length);
extern int f11a_test_current_response(uint8_t *frame);

#endif
