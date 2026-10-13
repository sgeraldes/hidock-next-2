#include "vadt_core.h"

#ifndef VADT_COMPILER_BARRIER
#if defined(__GNUC__) || defined(__clang__)
#define VADT_COMPILER_BARRIER() __asm__ __volatile__("" : : : "memory")
#else
#error "Define VADT_COMPILER_BARRIER for this compiler"
#endif
#endif

/* Target CPU ordering is a qualification requirement; the default is compiler-only. */
#ifndef VADT_CPU_BARRIER
#define VADT_CPU_BARRIER() VADT_COMPILER_BARRIER()
#endif

#ifdef VADT_TEST_HOOK
extern void VADT_TEST_HOOK(const vadt_telemetry_t *t, uint32_t try_index);
#define VADT_AFTER_PAYLOAD_READ(t, i) VADT_TEST_HOOK((t), (i))
#else
#define VADT_AFTER_PAYLOAD_READ(t, i) ((void)0)
#endif

void vadt_init(vadt_telemetry_t *t)
{
    t->sequence = 0u;
    t->attempted_reads = 0u;
    t->successful_reads = 0u;
    t->last_attempt_status = 0;
    t->last_good_raw_word = 0u;
    t->last_good_time_low = 0u;
    t->last_good_time_high = 0u;
    t->flags = 0u;
}

void vadt_record_completed(vadt_telemetry_t *t, int32_t status, uint32_t raw,
                           uint64_t time, int has_time)
{
    t->sequence = t->sequence + 1u;
    VADT_CPU_BARRIER();

    t->attempted_reads = t->attempted_reads + 1u;
    t->last_attempt_status = status;
    if (status == 0) {
        uint32_t flags = t->flags | VADT_FLAG_HAS_SAMPLE;

        t->successful_reads = t->successful_reads + 1u;
        t->last_good_raw_word = raw;
        if (has_time != 0) {
            t->last_good_time_low = (uint32_t)(time & 0xFFFFFFFFu);
            t->last_good_time_high = (uint32_t)(time >> 32);
            flags = flags | VADT_FLAG_HAS_TIME;
        } else {
            t->last_good_time_low = 0u;
            t->last_good_time_high = 0u;
            flags = flags & ~VADT_FLAG_HAS_TIME;
        }
        t->flags = flags;
    }

    VADT_CPU_BARRIER();
    t->sequence = t->sequence + 1u;
}

int32_t vadt_poll(vadt_telemetry_t *t, vadt_read_fn read, void *read_ctx,
                  vadt_clock_fn clock, void *clock_ctx, uint32_t *native_word)
{
    int32_t status = read(read_ctx, native_word);
    uint32_t raw = 0u;
    uint64_t now = 0u;
    int has_time = 0;

    if (status == 0) {
        raw = *native_word;
        if (clock != NULL) {
            now = clock(clock_ctx);
            has_time = 1;
        }
    }

    vadt_record_completed(t, status, raw, now, has_time);
    return status;
}

vadt_status_t vadt_snapshot(const vadt_telemetry_t *t, vadt_snapshot_t *out)
{
    uint32_t i;

    for (i = 0u; i < VADT_SNAPSHOT_TRIES; ++i) {
        uint32_t s1 = t->sequence;
        uint32_t attempted, successful, raw, tlow, thigh, flags;
        int32_t status;
        uint32_t s2;

        if ((s1 & 1u) != 0u) {
            continue;
        }
        VADT_CPU_BARRIER();

        attempted = t->attempted_reads;
        successful = t->successful_reads;
        status = t->last_attempt_status;
        raw = t->last_good_raw_word;
        tlow = t->last_good_time_low;
        thigh = t->last_good_time_high;
        flags = t->flags;

        VADT_CPU_BARRIER();
        VADT_AFTER_PAYLOAD_READ(t, i);
        s2 = t->sequence;

        if (s1 == s2) {
            out->sequence = s1;
            out->attempted_reads = attempted;
            out->successful_reads = successful;
            out->last_attempt_status = status;
            out->last_good_raw_word = raw;
            out->last_good_time = ((uint64_t)thigh << 32) | (uint64_t)tlow;
            out->flags = flags;
            return VADT_OK;
        }
    }
    return VADT_BUSY;
}

vadt_age_status_t vadt_age(const vadt_snapshot_t *s, uint64_t now, uint64_t *age)
{
    if ((s->flags & VADT_FLAG_HAS_SAMPLE) == 0u) {
        return VADT_AGE_NO_SAMPLE;
    }
    if ((s->flags & VADT_FLAG_HAS_TIME) == 0u) {
        return VADT_AGE_NO_TIME;
    }
    if (now < s->last_good_time) {
        return VADT_AGE_CLOCK_REGRESSED;
    }
    *age = now - s->last_good_time;
    return VADT_AGE_OK;
}

static void put_be32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v >> 24);
    p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);
    p[3] = (uint8_t)v;
}

static void encode_reply(uint8_t out[VADT_REPLY_SIZE], vadt_status_t status,
                         const vadt_snapshot_t *s, int with_age, uint64_t now,
                         uint8_t native_state)
{
    size_t i;
    uint8_t reply_flags = 0u;
    uint64_t age = 0u;

    for (i = 0u; i < VADT_REPLY_SIZE; ++i) {
        out[i] = 0u;
    }
    if (status == VADT_OK && s == NULL) {
        status = VADT_UNAVAILABLE;
    }
    out[0] = (uint8_t)status;
    out[1] = (uint8_t)VADT_REPLY_VERSION;
    /* UNAVAILABLE carries no native state; BUSY and OK pass it through. */
    out[3] = (status == VADT_UNAVAILABLE) ? 0u : native_state;

    if (status != VADT_OK) {
        return;
    }

    if ((s->flags & VADT_FLAG_HAS_SAMPLE) != 0u) {
        reply_flags = (uint8_t)(reply_flags | VADT_REPLY_FLAG_HAS_SAMPLE);
        if (with_age) {
            switch (vadt_age(s, now, &age)) {
            case VADT_AGE_OK:
                reply_flags = (uint8_t)(reply_flags | VADT_REPLY_FLAG_AGE_VALID);
                break;
            case VADT_AGE_CLOCK_REGRESSED:
                reply_flags = (uint8_t)(reply_flags | VADT_REPLY_FLAG_CLOCK_REGRESSED);
                age = 0u;
                break;
            case VADT_AGE_NO_SAMPLE:
            case VADT_AGE_NO_TIME:
            default:
                age = 0u;
                break;
            }
        }
    }

    out[2] = reply_flags;
    put_be32(out + 4, s->attempted_reads);
    put_be32(out + 8, s->successful_reads);
    put_be32(out + 12, (uint32_t)s->last_attempt_status);
    put_be32(out + 16, s->last_good_raw_word);
    put_be32(out + 20, (uint32_t)(age & 0xFFFFFFFFu));
    put_be32(out + 24, (uint32_t)(age >> 32));
    put_be32(out + 28, s->sequence);
}

void vadt_encode_reply(uint8_t out[VADT_REPLY_SIZE], vadt_status_t status,
                       const vadt_snapshot_t *s, uint8_t native_state)
{
    encode_reply(out, status, s, 0, 0u, native_state);
}

void vadt_encode_reply_with_age(uint8_t out[VADT_REPLY_SIZE], vadt_status_t status,
                                const vadt_snapshot_t *s, uint64_t now,
                                uint8_t native_state)
{
    encode_reply(out, status, s, 1, now, native_state);
}
