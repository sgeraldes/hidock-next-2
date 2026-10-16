/* Conditional offline module ELF only. Never composes or installs firmware. */
ENTRY(console630_parser_hook)
PROVIDE(console630_parse_current = 0x0112b70c);
PROVIDE(console630_response_current = 0x0112b800);
SECTIONS {
 .vad_text 0x0112f000 : { *(.text*) *(.stub) *(.rodata*) }
 .data : { *(.data*) }
 .bss : { *(.bss*) *(COMMON) }
 .constructor_edits 0x01021054 : { KEEP(*(.edits)) }
 .poll_hook 0x01020b62 : { KEEP(*(.patch_vad_poll)) }
 .parser_hook 0x0103a996 : { KEEP(*(.patch_console_parser)) }
 .response_hook 0x0103907a : { KEEP(*(.patch_console_response)) }
 ASSERT(SIZEOF(.data) == 0 && SIZEOF(.bss) == 0, "Writable XIP globals prohibited")
 ASSERT(SIZEOF(.poll_hook) == 4, "Native poll hook must be four bytes")
 ASSERT(SIZEOF(.parser_hook) == 4 && SIZEOF(.response_hook) == 4, "Console hooks must be four bytes")
 ASSERT(SIZEOF(.vad_text) <= 16384, "Conditional module exceeds the offline 16 KiB ceiling")
}
