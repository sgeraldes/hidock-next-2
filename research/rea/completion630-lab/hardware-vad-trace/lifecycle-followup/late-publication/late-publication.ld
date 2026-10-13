ENTRY(late_constructor_edits)
SECTIONS
{
  .edits 0x01021054 : { KEEP(*(.edits)) }
  .latepub 0x01122100 : { KEEP(*(.stub)) }
  /DISCARD/ : { *(.csky.attributes) *(.comment) }
}
