/*
 * Compile-time layout check for the 32-byte telemetry tail. Includes the
 * immutable vadt_core.h and never edits it. A failed assertion is a negative
 * array size, so it works in C99 without _Static_assert.
 *
 * The tail is the proposed object+0x40 .. object+0x5f region. Only the layout of
 * the struct is checked here. Nothing here says the allocation exists.
 *
 * REQUIRED LOADER CONTRACT, NOT IMPLEMENTED. h1e_vad_load_object() has no body in
 * this folder. A future loader must, before any access to a telemetry word:
 *   1. read the object pointer from the native slot inside the guard and reject
 *      NULL;
 *   2. compute base = object + 0x40 and reject it unless (uintptr_t)base % 4 == 0,
 *      since the words are accessed as aligned 32-bit values;
 *   3. return 0 only for an object that cannot be freed or replaced while the
 *      guard is held (lifetime requirement in vadt_binding.h, still unmet);
 *   4. not treat native state byte 5, or a second slot read, as a lifetime
 *      guarantee.
 * Runtime allocator success for 0x60 bytes and the base alignment are not
 * qualified by this source.
 */
#ifndef VADT_LAYOUT_CHECK_H
#define VADT_LAYOUT_CHECK_H

#include <stddef.h>

#include "../fresh-sample-candidate/vadt_core.h"

#define VADT_LAYOUT_ASSERT(name, condition) typedef char name[(condition) ? 1 : -1]

#define VADT_TAIL_OBJECT_OFFSET 0x40u
#define VADT_TAIL_BASE_ALIGNMENT 4u

VADT_LAYOUT_ASSERT(vadt_layout_sequence_at_0, offsetof(vadt_telemetry_t, sequence) == 0u);
VADT_LAYOUT_ASSERT(vadt_layout_attempted_reads_at_4, offsetof(vadt_telemetry_t, attempted_reads) == 4u);
VADT_LAYOUT_ASSERT(vadt_layout_successful_reads_at_8, offsetof(vadt_telemetry_t, successful_reads) == 8u);
VADT_LAYOUT_ASSERT(vadt_layout_last_attempt_status_at_12, offsetof(vadt_telemetry_t, last_attempt_status) == 12u);
VADT_LAYOUT_ASSERT(vadt_layout_last_good_raw_word_at_16, offsetof(vadt_telemetry_t, last_good_raw_word) == 16u);
VADT_LAYOUT_ASSERT(vadt_layout_last_good_time_low_at_20, offsetof(vadt_telemetry_t, last_good_time_low) == 20u);
VADT_LAYOUT_ASSERT(vadt_layout_last_good_time_high_at_24, offsetof(vadt_telemetry_t, last_good_time_high) == 24u);
VADT_LAYOUT_ASSERT(vadt_layout_flags_at_28, offsetof(vadt_telemetry_t, flags) == 28u);
VADT_LAYOUT_ASSERT(vadt_layout_size_is_32, sizeof(vadt_telemetry_t) == 32u);
VADT_LAYOUT_ASSERT(vadt_layout_tail_ends_at_0x60, VADT_TAIL_OBJECT_OFFSET + sizeof(vadt_telemetry_t) == 0x60u);

#endif
