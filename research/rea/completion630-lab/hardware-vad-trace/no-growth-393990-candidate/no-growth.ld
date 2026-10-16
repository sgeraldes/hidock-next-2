/* Offline NO-GROWTH candidate only. Does not compose or install a SYS image. */
ENTRY(console630_parser_hook)
PROVIDE(console630_parse_current = 0x0112b70c);
PROVIDE(console630_response_current = 0x0112b800);

SECTIONS {
  /* Whole immutable object sections are assigned to existing declared tails. */
  .router_tail 0x01128a40 : {
    *vadt_core.o(.text .text.* .rodata .rodata.*)
    *vadt_binding.o(.text .text.* .rodata .rodata.*)
    *vadt_frame.o(.text .text.* .rodata .rodata.*)
    *vadt_frame_target.o(.text .text.* .rodata .rodata.*)
    *vadt_csky_guard.o(.text .text.* .rodata .rodata.*)
  }

  .console_tail 0x0112be00 : {
    *h1e_vad_native_poll.o(.text .text.* .rodata .rodata.*)
    *h1e_vad_native_loader.o(.text .text.* .rodata .rodata.*)
    *f11a_console_dispatch.o(.text .text.* .rodata .rodata.*)
    *console-hooks.o(.text .text.* .rodata .rodata.*)
    *constructor.o(.text .text.* .rodata .rodata.* .stub)
    *poll-hook.o(.text .text.* .rodata .rodata.*)
  }

  .data : { *(.data*) }
  .bss : { *(.bss*) *(COMMON) }

  .constructor_edits 0x01021054 : { KEEP(*(.edits)) }
  .poll_hook 0x01020b62 : { KEEP(*(.patch_vad_poll)) }
  .parser_hook 0x0103a996 : { KEEP(*(.patch_console_parser)) }
  .response_hook 0x0103907a : { KEEP(*(.patch_console_response)) }

  ASSERT(ADDR(.router_tail) == 0x01128a40,
         "router-tail base changed")
  ASSERT(SIZEOF(.router_tail) <= 1472,
         "router-tail candidate exceeds the proposed 32-aligned bound")
  ASSERT(ADDR(.console_tail) == 0x0112be00,
         "console-tail base changed")
  ASSERT(SIZEOF(.console_tail) <= 512,
         "console-tail candidate exceeds the proposed 32-aligned bound")
  ASSERT(SIZEOF(.data) == 0 && SIZEOF(.bss) == 0,
         "Writable XIP globals prohibited")
  ASSERT(SIZEOF(.poll_hook) == 4,
         "Native poll hook must be four bytes")
  ASSERT(SIZEOF(.parser_hook) == 4 && SIZEOF(.response_hook) == 4,
         "Console hooks must be four bytes")
  ASSERT(SIZEOF(.constructor_edits) == 140,
         "Constructor edit section changed")
}
