/* Offline router-tail-only candidate. Never composes or installs a SYS image. */
ENTRY(console630_parser_hook)
PROVIDE(console630_parse_current = 0x0112b70c);
PROVIDE(console630_response_current = 0x0112b81c);

SECTIONS {
  .router_tail 0x01128a40 : {
    *(.text .text.* .gnu.linkonce.t.*)
    *(.rodata .rodata.* .srodata .srodata.* .gnu.linkonce.r.*)
    KEEP(*(.stub .stub.*))
  }

  .data : { *(.data .data.* .sdata .sdata.* .got .got.*) }
  .bss : { *(.bss .bss.* .sbss .sbss.* COMMON) }

  /* Every native patch input remains a GC root; its relocations retain its callee. */
  .constructor_edits 0x01021054 : { KEEP(*(.edits)) }
  .poll_hook 0x01020b62 : { KEEP(*(.patch_vad_poll)) }
  .parser_hook 0x0103a996 : { KEEP(*(.patch_console_parser)) }
  .response_hook 0x0103907a : { KEEP(*(.patch_console_response)) }

  ASSERT(ADDR(.router_tail) == 0x01128a40, "router-tail base changed")
  ASSERT(SIZEOF(.router_tail) <= 1472, "router-only module exceeds the proposed 1472-byte router tail")
  ASSERT(SIZEOF(.data) == 0 && SIZEOF(.bss) == 0, "Writable XIP globals prohibited")
  ASSERT(SIZEOF(.poll_hook) == 4, "Native poll hook must be four bytes")
  ASSERT(SIZEOF(.parser_hook) == 4 && SIZEOF(.response_hook) == 4,
         "Console hooks must be four bytes")
  ASSERT(SIZEOF(.constructor_edits) == 140, "Constructor edit section changed")
}
