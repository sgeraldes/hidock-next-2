    .section .text.cleanup_window,"ax",@progbits
    .globl cleanup_window
    .type cleanup_window,@function
cleanup_window:
    movi r3, 0
    st.w r3, (r5, 0)
    bsr native_free
    movi r4, 0
