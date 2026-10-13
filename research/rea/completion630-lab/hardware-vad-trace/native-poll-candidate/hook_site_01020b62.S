/*
 * Isolated BSR encoding at the old native call site 01020b62. Assembled at that
 * address only to obtain the instruction bytes. The target comes from --defsym
 * h1e_hook_target at link time. No image, no placement.
 */
    .text
    .align 1
    .globl hook_site
hook_site:
    bsr h1e_hook_target
