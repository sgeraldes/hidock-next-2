    .text
    .global probe
probe:
    mfcr r4, psr
    mfcr r4, epsr
    mfcr r4, epc
    psrclr ie
    mtcr r4, psr
    mtcr r4, epsr
    mtcr r4, epc
    rte
    br probe
