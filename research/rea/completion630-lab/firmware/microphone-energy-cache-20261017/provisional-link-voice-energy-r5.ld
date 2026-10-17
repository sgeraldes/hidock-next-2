/* Offline integration-link proposal only. This never composes a SYS. */
SECTIONS
{
  .poll_dispatch_call 0x01020b62 : { KEEP(*(.integration_poll_call)) }
  .constructor_allocate128 0x01021054 : { KEEP(*(.plan_allocate_128)) }
  .constructor_zero128 0x0102109e : { KEEP(*(.plan_zero_128)) }
  .parser_dispatch_call 0x01128e68 : { KEEP(*(.integration_parse_call)) }
  .response_dispatch_call 0x01128ea2 : { KEEP(*(.integration_response_call)) }

  . = 0x01137000;
  .voice_energy_text : { *(.text .text.*) }
  .voice_energy_rodata : { *(.rodata .rodata.*) }
  .voice_energy_data : { *(.data .data.*) }
  .voice_energy_bss (NOLOAD) : { *(.bss .bss.* COMMON) }
  . = ALIGN(4);
  __voice_energy_provisional_end = .;

  ASSERT(SIZEOF(.poll_dispatch_call) == 4,
         "poll integration call must be one CK802 BSR")
  ASSERT(SIZEOF(.constructor_allocate128) == 2,
         "constructor allocate-128 plan must be one CK802 instruction")
  ASSERT(SIZEOF(.constructor_zero128) == 2,
         "constructor zero-128 plan must be one CK802 instruction")
  ASSERT(SIZEOF(.parser_dispatch_call) == 4,
         "parser integration call must be one CK802 BSR")
  ASSERT(SIZEOF(.response_dispatch_call) == 4,
         "response integration call must be one CK802 BSR")
  ASSERT(__voice_energy_provisional_end <= 0x01137800,
         "VoiceEnergy provisional link exceeds its 2 KiB evaluation window")

  /DISCARD/ : { *(.comment) *(.note .note.*) *(.csky.attributes) *(.csky_stack_size) }
}
