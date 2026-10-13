    .section .edits,"ax",@progbits
    .globl late_constructor_edits
late_constructor_edits:
    movi r0, 0x60                 /* 01021054: allocate 96 */
    .org 0x08
    mov r7, r0                    /* 0102105c: keep allocation private */
    .org 0x16
    mov r0, r7                    /* 0102106a: error-path free argument */
    .org 0x1c
    bsr late_publication_stub     /* 01021070: decide final status */
    .org 0x4a
    movi r2, 0x60                 /* 0102109e: clear 96 */
    .org 0x54
    mov r7, r7                    /* 010210a8: preserve private pointer */
    .org 0x8a
    mov r3, r7                    /* 010210de: pass private object to API setup */

    .section .stub,"ax",@progbits
    .globl late_publication_stub
late_publication_stub:
    cmpnei r4, 0                  /* original 01021070 predicate */
    bt .Lfailure                  /* nonzero status keeps old free path */
    st.w r7, (r5, 0)              /* publish only on final success */
    lrw r15, 0x01021038           /* existing success return path */
    jmp r15
.Lfailure:
    lrw r15, 0x01021074           /* existing free sequence; r0 still holds r7 */
    jmp r15
