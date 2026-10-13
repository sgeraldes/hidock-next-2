/*
 * vadt_core: fresh-sample telemetry for the H1E RefChannelVAD poller.
 * Source candidate only. Not firmware qualification. See CONTRACT.md.
 *
 * Single writer (native poll context) records completed native reads. One
 * reader at a time (serialized Jensen context) takes a bounded snapshot. The
 * telemetry storage is caller-owned, 32 bytes, all-zero meaning "no sample yet".
 *
 * The recorded word is the initialized 32-bit word the native caller consumes
 * after status 0. It is not proven DSP data and not a voice boolean.
 * A recorded time, when present, is the local native clock at observation. It
 * is not DSP or acoustic acquisition time.
 */
#ifndef VADT_CORE_H
#define VADT_CORE_H

#include <stddef.h>
#include <stdint.h>

#define VADT_FLAG_HAS_SAMPLE 0x00000001u
/* The last good sample carries a local observation time in the time fields. */
#define VADT_FLAG_HAS_TIME 0x00000002u

#define VADT_SNAPSHOT_TRIES 3u

#define VADT_REPLY_SIZE 32u
#define VADT_REPLY_VERSION 1u
#define VADT_REPLY_FLAG_HAS_SAMPLE 0x01u
#define VADT_REPLY_FLAG_AGE_VALID 0x02u
#define VADT_REPLY_FLAG_CLOCK_REGRESSED 0x04u

typedef struct vadt_telemetry {
    volatile uint32_t sequence;
    volatile uint32_t attempted_reads;
    volatile uint32_t successful_reads;
    volatile int32_t last_attempt_status;
    volatile uint32_t last_good_raw_word;
    volatile uint32_t last_good_time_low;
    volatile uint32_t last_good_time_high;
    volatile uint32_t flags;
} vadt_telemetry_t;

typedef char vadt_telemetry_size_must_be_32[(sizeof(vadt_telemetry_t) == 32u) ? 1 : -1];

typedef struct vadt_snapshot {
    uint32_t sequence;
    uint32_t attempted_reads;
    uint32_t successful_reads;
    int32_t last_attempt_status;
    uint32_t last_good_raw_word;
    uint64_t last_good_time;
    uint32_t flags;
} vadt_snapshot_t;

typedef enum vadt_status {
    VADT_OK = 0,
    VADT_BUSY = 1,
    VADT_UNAVAILABLE = 2
} vadt_status_t;

typedef enum vadt_age_status {
    VADT_AGE_OK = 0,
    VADT_AGE_NO_SAMPLE = 1,
    VADT_AGE_CLOCK_REGRESSED = 2,
    VADT_AGE_NO_TIME = 3
} vadt_age_status_t;

/* Original read: must forward to the unchanged native getter exactly once. */
typedef int32_t (*vadt_read_fn)(void *ctx, uint32_t *out_word);
typedef uint64_t (*vadt_clock_fn)(void *ctx);

/* Zero every field: no sample, counters 0, sequence 0 (even). */
void vadt_init(vadt_telemetry_t *t);

/*
 * Pure writer step for one completed native read. No callbacks, no clock, no
 * native pointer. status and raw are copies taken by the caller.
 *
 * status != 0: raw, time and has_time are ignored. Only attempted_reads and
 *   last_attempt_status change; the last good sample is preserved.
 * status == 0: raw is recorded and HAS_SAMPLE is set. With has_time != 0 the
 *   time is recorded and HAS_TIME is set. With has_time == 0 the time fields
 *   are zeroed and HAS_TIME is cleared, so a stale time never pairs with a new
 *   word.
 * Counters wrap modulo 2^32. The sequence is odd while the update runs.
 */
void vadt_record_completed(vadt_telemetry_t *t, int32_t status, uint32_t raw,
                           uint64_t time, int has_time);

/*
 * Single writer, portable form. Calls read(read_ctx, native_word) exactly once,
 * passing native_word through unchanged, and returns the status unchanged.
 * *native_word is read only when status is 0 and is never written here.
 * clock == NULL is the explicit unclocked path: no clock call, no time recorded.
 * A non-NULL clock is called only when status is 0 and its value is recorded as
 * the local observation time. That clocked behavior is optional and its target
 * binding is not qualified.
 */
int32_t vadt_poll(vadt_telemetry_t *t, vadt_read_fn read, void *read_ctx,
                  vadt_clock_fn clock, void *clock_ctx, uint32_t *native_word);

/*
 * Reader. Up to VADT_SNAPSHOT_TRIES attempts, no waiting. Returns VADT_BUSY
 * when the sequence stays odd or changes on every attempt; *out is then left
 * untouched.
 */
vadt_status_t vadt_snapshot(const vadt_telemetry_t *t, vadt_snapshot_t *out);

/*
 * Optional, separately qualified: now - last_good_time in 64 bits. *age is
 * written only on VADT_AGE_OK. A sample without a recorded time is NO_TIME and
 * is never given an age.
 */
vadt_age_status_t vadt_age(const vadt_snapshot_t *s, uint64_t now, uint64_t *age);

/*
 * Tentative 32-byte reply, unclocked (the intended path). Reply flags carry
 * only HAS_SAMPLE; AGE_VALID and CLOCK_REGRESSED stay clear and both age words
 * are zero, whatever the snapshot holds. For anything but VADT_OK with a
 * non-NULL snapshot only bytes 0..3 are filled and bytes 4..31 are zero.
 * Byte 3 (nativeState): UNAVAILABLE, explicit or from OK with a NULL snapshot,
 * always writes 0 whatever native_state was passed. BUSY and OK write the
 * passed native_state.
 */
void vadt_encode_reply(uint8_t out[VADT_REPLY_SIZE], vadt_status_t status,
                       const vadt_snapshot_t *s, uint8_t native_state);

/*
 * Optional, separately qualified: same layout with an age computed against a
 * caller-supplied local clock value. Needs a qualified target clock binding.
 */
void vadt_encode_reply_with_age(uint8_t out[VADT_REPLY_SIZE], vadt_status_t status,
                                const vadt_snapshot_t *s, uint64_t now,
                                uint8_t native_state);

#endif
