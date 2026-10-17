#ifndef H1E_VOICE_ENERGY_LOADER128_H
#define H1E_VOICE_ENERGY_LOADER128_H

#include <stdint.h>

#include "../../hardware-vad-trace/native-poll-candidate/h1e_vad_native_poll.h"

/*
 * This source loader is deliberately not usable with the current 0x60-byte
 * constructor. Every target build must assert the proposed 0x80-byte
 * constructor, detach-before-free ordering, and explicit build admission.
 * Those assertions are not evidence that the lifecycle edits exist or passed
 * review; this module remains source-only until its parent integration supplies
 * and pins them.
 */
#if !defined(H1E_VOICE_ENERGY_ASSERT_CONSTRUCTOR128) || \
    ((H1E_VOICE_ENERGY_ASSERT_CONSTRUCTOR128 + 0) != 1)
#error "The 128-byte object loader requires an explicit constructor assertion"
#endif
#if !defined(H1E_VOICE_ENERGY_ASSERT_DETACH_BEFORE_FREE) || \
    ((H1E_VOICE_ENERGY_ASSERT_DETACH_BEFORE_FREE + 0) != 1)
#error "The object loader requires an explicit detach-before-free assertion"
#endif
#if !defined(H1E_VOICE_ENERGY_BUILD_ADMITTED) || \
    ((H1E_VOICE_ENERGY_BUILD_ADMITTED + 0) != 1)
#error "The object loader requires explicit build admission"
#endif
#if !defined(__csky__)
#error "The production 128-byte loader is C-SKY only; do not substitute a test stub"
#endif

/* Existing pointer slot and VADT-tail geometry, pinned from native-loader. */
#define H1E_VOICE_ENERGY_OBJECT_SLOT ((uintptr_t)0x000852c0u)
#define H1E_VOICE_ENERGY_TAIL_OFFSET ((uintptr_t)0x40u)
#define H1E_VOICE_ENERGY_OBJECT_EXTENT ((uintptr_t)0x80u)

/*
 * Called only with the existing same-core object guard held. Returns zero for
 * a non-NULL, non-wrapping, 4-byte-aligned 0x80-byte object and fills the
 * existing telemetry-tail pointer and native state byte. The state byte is
 * returned verbatim; it is not treated as a readiness or lifetime signal.
 */
int h1e_voice_energy_load_object_128(void *ctx,
                                     vadt_telemetry_t **tail,
                                     uint8_t *native_state);

#endif
