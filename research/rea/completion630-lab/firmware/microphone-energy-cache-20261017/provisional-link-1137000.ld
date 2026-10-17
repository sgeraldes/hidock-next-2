/*
 * Offline evaluation layout only. This is not a reservation and is never used
 * by an image composer. The declared SYS geometry contains this interval, but
 * no owner has granted VMA ownership for the VoiceEnergy cache here.
 */
SECTIONS
{
  . = 0x01137000;
  .voice_energy_text : { *(.text .text.*) }
  .voice_energy_rodata : { *(.rodata .rodata.*) }
  .voice_energy_data : { *(.data .data.*) }
  .voice_energy_bss (NOLOAD) : { *(.bss .bss.* COMMON) }
  . = ALIGN(4);
  __voice_energy_provisional_end = .;

  ASSERT(__voice_energy_provisional_end <= 0x01137800,
         "VoiceEnergy provisional link exceeds its 2 KiB evaluation window")

  /DISCARD/ : { *(.comment) *(.note .note.*) *(.csky.attributes) *(.csky_stack_size) }
}
