#include "vad_provider_raw_get.h"

/*
 * Opt-in, one-word VoiceEnergy read for a proposed firmware integration.
 * This file installs no hook and performs no work unless the caller invokes
 * vad_provider_raw_get(). Builds default to a disabled stub.
 *
 * Call only from the ordinary RefChannelVAD poll context being extended,
 * outside an ISR or IRQ-masked critical section. This does not assume the
 * standalone native VoiceEnergy caller is already active. The native path can
 * wait for its timer/event machinery; this adapter adds no timeout.
 */
#define VAD_RAW_SLOT_80E70          ((uintptr_t)0x00080e70u)
#define VAD_RAW_SLOT_85290          ((uintptr_t)0x00085290u)
#define VAD_RAW_SLOT_852A4          ((uintptr_t)0x000852a4u)
#define VAD_RAW_STATE_80E88         ((uintptr_t)0x00080e88u)

#define VAD_RAW_EXPECT_80E70        ((uint32_t)0x0101f0ecu)
#define VAD_RAW_EXPECT_85290        ((uint32_t)0x0101fa78u)
#define VAD_RAW_EXPECT_852A4        ((uint32_t)0x0101f93au)
#define VAD_RAW_EXPECT_STATE        ((uint32_t)4u)

#define VAD_RAW_VOICEENERGY_ENTRY   ((uintptr_t)0x0101fa9cu)
#define VAD_RAW_PSR_IE_MASK         ((uint32_t)(1u << 6))

#if VAD_PROVIDER_RAW_ENABLE
typedef int32_t (*vad_voice_energy_fn)(uint32_t *raw_word);

static uint32_t vad_raw_read32(uintptr_t address)
{
    return *(volatile const uint32_t *)address;
}

static uint32_t vad_raw_read_psr(void)
{
    uint32_t psr;
    __asm__ volatile("mfcr %0, psr" : "=r"(psr) : : "memory");
    return psr;
}
#endif

int32_t vad_provider_raw_get(uint32_t *raw_word)
{
#if VAD_PROVIDER_RAW_ENABLE
    uint32_t local_word = 0u;
#endif

    if (raw_word == (uint32_t *)0) {
        return VAD_PROVIDER_RAW_STATUS_BAD_ARGUMENT;
    }

    *raw_word = 0u;

#if !VAD_PROVIDER_RAW_ENABLE
    return VAD_PROVIDER_RAW_STATUS_DISABLED;
#else
    /* One passive 32-bit sample per gate; never follow the function pointers. */
    if (vad_raw_read32(VAD_RAW_SLOT_80E70) != VAD_RAW_EXPECT_80E70) {
        return VAD_PROVIDER_RAW_STATUS_SLOT_80E70_MISMATCH;
    }
    if (vad_raw_read32(VAD_RAW_SLOT_852A4) != VAD_RAW_EXPECT_852A4) {
        return VAD_PROVIDER_RAW_STATUS_SLOT_852A4_MISMATCH;
    }
    if (vad_raw_read32(VAD_RAW_SLOT_85290) != VAD_RAW_EXPECT_85290) {
        return VAD_PROVIDER_RAW_STATUS_SLOT_85290_MISMATCH;
    }
    if (vad_raw_read32(VAD_RAW_STATE_80E88) != VAD_RAW_EXPECT_STATE) {
        return VAD_PROVIDER_RAW_STATUS_STATE_80E88_MISMATCH;
    }

    /* PSR.IE is bit 6; reject without changing the processor status register. */
    if ((vad_raw_read_psr() & VAD_RAW_PSR_IE_MASK) == 0u) {
        return VAD_PROVIDER_RAW_STATUS_IRQ_MASKED;
    }

    /* This is the native wrapper: it supplies selector 0x4009ffd0 and routes
       through slot 0x80e70, whose installed entry fixes the request to 1 word. */
    {
        int32_t native_status =
            ((vad_voice_energy_fn)VAD_RAW_VOICEENERGY_ENTRY)(&local_word);
        if (native_status != 0) {
            return native_status;
        }
    }

    *raw_word = local_word;
    return VAD_PROVIDER_RAW_STATUS_OK;
#endif
}
