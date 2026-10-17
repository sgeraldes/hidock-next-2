/* Exported instruction-only call sites for review. Never applied to a SYS. */
    .section .integration_poll_call,"ax",@progbits
    .globl h1e_voice_energy_poll_call_site
h1e_voice_energy_poll_call_site:
    bsr h1e_voice_energy_poll_bridge

    .section .integration_parse_call,"ax",@progbits
    .globl h1e_voice_energy_parse_call_site
h1e_voice_energy_parse_call_site:
    bsr h1e_voice_energy_f11a_parse_shim

    .section .integration_response_call,"ax",@progbits
    .globl h1e_voice_energy_response_call_site
h1e_voice_energy_response_call_site:
    bsr h1e_voice_energy_f11a_response_shim

    .section .plan_allocate_128,"ax",@progbits
    .globl h1e_voice_energy_allocate_128_instruction
h1e_voice_energy_allocate_128_instruction:
    movi r0, 0x80

    .section .plan_zero_128,"ax",@progbits
    .globl h1e_voice_energy_zero_128_instruction
h1e_voice_energy_zero_128_instruction:
    movi r2, 0x80
