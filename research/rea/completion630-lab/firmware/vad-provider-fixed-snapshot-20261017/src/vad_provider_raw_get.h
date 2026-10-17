#ifndef VAD_PROVIDER_RAW_GET_H
#define VAD_PROVIDER_RAW_GET_H

#include <stdint.h>

/* Opt in at compile time; omitted builds return DISABLED without reading RAM. */
#ifndef VAD_PROVIDER_RAW_ENABLE
#define VAD_PROVIDER_RAW_ENABLE 0
#endif

enum vad_provider_raw_status {
    VAD_PROVIDER_RAW_STATUS_OK = 0,
    VAD_PROVIDER_RAW_STATUS_DISABLED = -1,
    VAD_PROVIDER_RAW_STATUS_BAD_ARGUMENT = -2,
    VAD_PROVIDER_RAW_STATUS_SLOT_80E70_MISMATCH = -3,
    VAD_PROVIDER_RAW_STATUS_SLOT_852A4_MISMATCH = -4,
    VAD_PROVIDER_RAW_STATUS_SLOT_85290_MISMATCH = -5,
    VAD_PROVIDER_RAW_STATUS_STATE_80E88_MISMATCH = -6,
    VAD_PROVIDER_RAW_STATUS_IRQ_MASKED = -7
};

/*
 * On any non-OK return, a non-null output is zeroed and no raw value is exposed.
 * If the native wrapper is called, its exact nonzero status is returned as-is;
 * negative adapter statuses above describe rejection before that call.
 */
int32_t vad_provider_raw_get(uint32_t *raw_word);

#endif
