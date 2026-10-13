/*
 * Host test seam. Forced into the loader and test compiles with -include.
 * Never part of a C-SKY build, where the loader header refuses these macros.
 * The fakes are defined in h1e_vad_native_loader_test.c.
 */
#ifndef H1E_VAD_NATIVE_LOADER_HOST_CONFIG_H
#define H1E_VAD_NATIVE_LOADER_HOST_CONFIG_H

#include <stdint.h>

#define H1E_VAD_NATIVE_LOADER_HOST_TEST 1

uintptr_t h1e_test_slot_read(void);
uint32_t h1e_test_guard_enter(void *ctx);
void h1e_test_guard_exit(void *ctx, uint32_t key);

#define H1E_VAD_SLOT_READ() h1e_test_slot_read()
#define H1E_VAD_GUARD_ENTER h1e_test_guard_enter
#define H1E_VAD_GUARD_EXIT h1e_test_guard_exit

#endif
