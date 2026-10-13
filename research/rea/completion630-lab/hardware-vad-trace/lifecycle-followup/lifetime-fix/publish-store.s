    .section .text.publish_store,"ax",@progbits
    .globl publish_store
    .type publish_store,@function
publish_store:
    st.w r7, (r5, 0)
