/*
 * Conditional-integration gate and configuration for the H1E VAD object loader
 * and snapshot reader. Source candidate only. Not linked into any image, not
 * placed at any address, never run on hardware.
 *
 * This header owns no function prototype. h1e_vad_load_object() is declared by
 * ../native-poll-candidate/h1e_vad_native_poll.h and h1e_vad_snapshot_read() by
 * ../native-dispatch-candidate/h1e_vad_snapshot.h. Both are included below, so a
 * signature mismatch with the definitions in h1e_vad_native_loader.c fails the
 * compile.
 *
 * WARNING: H1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES
 * ---------------------------------------------------------
 * A C-SKY build of h1e_vad_native_loader.c is refused unless the build supplies
 *     -DH1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES=1
 * Nothing in this folder defines that macro. Supplying it ASSERTS the following
 * and does not prove any of it:
 *
 *   1. All seven delayed-publication constructor hunks of
 *      lifecycle-followup/late-publication/REPORT.md are applied (01021054,
 *      0102105c, 0102106a, 01021070 with its stub, 0102109e, 010210a8, 010210de),
 *      so the object is 0x60 bytes, is zeroed before publication, and the slot
 *      0x852c0 becomes non-NULL only after constructor success.
 *   2. A published object has no free in the audited runtime path. Successful
 *      teardown, ROM paths, indirect consumers and interrupts are NOT audited.
 *      The loader does not check the native state byte or re-read the slot as a
 *      lifetime test, because neither is one.
 *   3. The native code calls the loader and the reader only after the one-shot
 *      startup order audited in lifecycle-followup/early-reader-order/REPORT.md,
 *      under the normal C-SKY callee-save ABI (r4-r7 preserved across callees).
 *   4. The caller holds the IRQ guard around the loader. The loader does not take
 *      one. vadt_binding_read and vadt_binding_poll do, through their ops table.
 *   5. The 0x60 allocation succeeded and is 4-byte aligned on the target. The
 *      loader rejects a misaligned base but cannot detect a short allocation.
 *
 * Still unqualified when the macro is supplied: CPU ordering (the core uses a
 * compiler barrier only), another core or the DSP, installed-image identity,
 * allocator behavior, and any physical behavior. The macro marks a source
 * integration condition. It is not evidence and not a release approval.
 *
 * Host test builds use H1E_VAD_NATIVE_LOADER_HOST_TEST from
 * h1e_vad_native_loader_host_config.h instead, which swaps in typed fakes for
 * the slot read and the guard.
 */
#ifndef H1E_VAD_NATIVE_LOADER_H
#define H1E_VAD_NATIVE_LOADER_H

#include <stddef.h>
#include <stdint.h>

#include "../native-poll-candidate/h1e_vad_native_poll.h"
#include "../native-poll-candidate/vadt_layout_check.h"
#include "../native-dispatch-candidate/h1e_vad_snapshot.h"

#if defined(__csky__) && defined(H1E_VAD_NATIVE_LOADER_HOST_TEST)
#error "refusing host-test build on the C-SKY target: H1E_VAD_NATIVE_LOADER_HOST_TEST bypasses the prerequisite gate"
#elif defined(H1E_VAD_NATIVE_LOADER_HOST_TEST)
#if !defined(H1E_VAD_SLOT_READ) || !defined(H1E_VAD_GUARD_ENTER) || !defined(H1E_VAD_GUARD_EXIT)
#error "host test build needs the typed fakes from h1e_vad_native_loader_host_config.h"
#endif
#elif defined(__csky__)
#if !defined(H1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES) || ((H1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES + 0) != 1)
#error "h1e_vad_native_loader.c asserts unproven prerequisites. Read the WARNING in h1e_vad_native_loader.h, then build with -DH1E_VAD_ASSERT_DELAYED_PUBLICATION_PREREQUISITES=1 only for an offline source check."
#endif
#if defined(H1E_VAD_SLOT_READ) || defined(H1E_VAD_GUARD_ENTER) || defined(H1E_VAD_GUARD_EXIT)
#error "H1E_VAD_SLOT_READ and the guard macros are host-test seams and are refused on the target"
#endif
typedef char h1e_vad_target_is_32_bit[(sizeof(void *) == 4u && sizeof(uintptr_t) == 4u) ? 1 : -1];
#else
#error "h1e_vad_native_loader.c builds for C-SKY, or for the host test with H1E_VAD_NATIVE_LOADER_HOST_TEST"
#endif

/* RAM pointer slot that holds the object pointer. The slot is not the object. */
#define H1E_VAD_SLOT_ADDRESS 0x000852c0u
/* Telemetry tail: object+0x40 .. object+0x5f, inside the extended 0x60-byte object. */
#define H1E_VAD_TAIL_OFFSET 0x40u
#define H1E_VAD_OBJECT_BYTES 0x60u
#define H1E_VAD_TAIL_ALIGN 4u
/* Largest base for which base + 0x5f does not wrap the address space. */
#define H1E_VAD_BASE_MAX ((uintptr_t)(UINTPTR_MAX - (H1E_VAD_OBJECT_BYTES - 1u)))

#endif
