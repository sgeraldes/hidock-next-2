    .section .text.constructor_edits,"ax",@progbits
    .globl constructor_edits
    .type constructor_edits,@function
constructor_edits:
    movi r0, 0x60
    mov r7, r0
    movi r2, 0x60
    st.w r7, (r5, 0)
