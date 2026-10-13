/*
 * C-SKY saved-PSR guard primitive. Isolated object only, never linked into an
 * image here. It mirrors the save, clear IE, restore pattern the current image
 * uses at 01074606/0107460a/0107464c. It is a small same-core mask, not the
 * broader scheduler/VIC lock of the related SDK, and it does not synchronize
 * another core or the DSP.
 *
 * PSR also holds the condition flag, so psrclr and mtcr change it. Both asm
 * statements declare "cc" so inlining or LTO cannot reuse a comparison result
 * across them.
 */
#include "vadt_binding.h"

#if !defined(__csky__)
#error "vadt_csky_guard.c is C-SKY only"
#endif

uint32_t vadt_csky_guard_enter(void *ctx)
{
    uint32_t key;

    (void)ctx;
    __asm__ __volatile__("mfcr %0, psr\n\tpsrclr ie" : "=r"(key) : : "memory", "cc");
    return key;
}

void vadt_csky_guard_exit(void *ctx, uint32_t key)
{
    (void)ctx;
    __asm__ __volatile__("mtcr %0, psr" : : "r"(key) : "memory", "cc");
}
