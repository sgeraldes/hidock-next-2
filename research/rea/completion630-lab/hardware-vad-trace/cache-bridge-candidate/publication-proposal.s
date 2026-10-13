/* Instruction encoding experiment only. Not a firmware patch. */
.text
.global publication_proposal_instructions
publication_proposal_instructions:
    movi r0, 0x60
    mov r7, r0
    movi r2, 0x60
    st.w r7, (r5, 0)
