/*
 * h1e_vad_native_poll_bridge: the thin one-argument wrapper for the native
 * getter call at 01020b62. Source candidate only.
 *
 * The caller's pointer goes to the original getter at 0101fb68 through
 * vadt_binding_poll, which calls it once outside the guard and returns its
 * status unchanged. The wrapper adds no DSP call and no other native call.
 *
 * The three seams below are macros so a host test can supply a typed fake getter,
 * guard and loader through a forced-include header. Without that header the real
 * values apply, and this file refuses to build off C-SKY.
 */
#include "h1e_vad_native_poll.h"
#include "vadt_layout_check.h"

#if !defined(__csky__) && !defined(H1E_VAD_NATIVE_POLL_HOST_TEST)
#error "h1e_vad_native_poll.c builds for C-SKY, or for the host test with H1E_VAD_NATIVE_POLL_HOST_TEST"
#endif

#ifndef H1E_VAD_NATIVE_GETTER
#define H1E_VAD_NATIVE_GETTER ((vadt_native_getter_fn)(uintptr_t)0x0101fb68u)
#endif
#ifndef H1E_VAD_GUARD_ENTER
#define H1E_VAD_GUARD_ENTER vadt_csky_guard_enter
#endif
#ifndef H1E_VAD_GUARD_EXIT
#define H1E_VAD_GUARD_EXIT vadt_csky_guard_exit
#endif
#ifndef H1E_VAD_LOAD_OBJECT
#define H1E_VAD_LOAD_OBJECT h1e_vad_load_object
#endif

static const vadt_binding_ops_t h1e_vad_native_poll_ops = {
    NULL,
    H1E_VAD_GUARD_ENTER,
    H1E_VAD_GUARD_EXIT,
    H1E_VAD_LOAD_OBJECT
};

int32_t h1e_vad_native_poll_bridge(uint32_t *native_word)
{
    return vadt_binding_poll(&h1e_vad_native_poll_ops, H1E_VAD_NATIVE_GETTER, native_word);
}
