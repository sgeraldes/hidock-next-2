/*
 * Host test seam. Forced into the wrapper and test compiles with -include.
 * Never part of a C-SKY build. The fakes are defined in
 * h1e_vad_native_poll_test.c.
 */
#ifndef H1E_VAD_HOST_TEST_CONFIG_H
#define H1E_VAD_HOST_TEST_CONFIG_H

#include <stdint.h>

#include "../fresh-sample-candidate/vadt_binding.h"

#define H1E_VAD_NATIVE_POLL_HOST_TEST 1

int32_t h1e_test_getter(uint32_t *out_word);
uint32_t h1e_test_guard_enter(void *ctx);
void h1e_test_guard_exit(void *ctx, uint32_t key);
int h1e_test_load_object(void *ctx, vadt_telemetry_t **tail, uint8_t *native_state);

#define H1E_VAD_NATIVE_GETTER h1e_test_getter
#define H1E_VAD_GUARD_ENTER h1e_test_guard_enter
#define H1E_VAD_GUARD_EXIT h1e_test_guard_exit
#define H1E_VAD_LOAD_OBJECT h1e_test_load_object

#endif
