#ifndef H1E_VOICE_ENERGY_CACHE_H
#define H1E_VOICE_ENERGY_CACHE_H

#include <stddef.h>
#include <stdint.h>

/*
 * Proposed sidecar after the accepted 96-byte H1E object. This is a layout
 * proposal only: the current object ends at +0x60. A future constructor would
 * have to allocate and zero 0x80 bytes before publishing the object pointer.
 */
#define H1E_VOICE_ENERGY_CACHE_OFFSET 0x60u
#define H1E_VOICE_ENERGY_CACHE_BYTES 0x20u
#define H1E_VOICE_ENERGY_OBJECT_BYTES 0x80u

#define H1E_VOICE_ENERGY_HAS_SAMPLE 0x00000001u
#define H1E_VOICE_ENERGY_SNAPSHOT_TRIES 3u

typedef struct h1e_voice_energy_cache {
    volatile uint32_t sequence;
    volatile uint32_t attempted_reads;
    volatile uint32_t successful_reads;
    volatile int32_t last_attempt_status;
    volatile uint32_t last_good_raw_word;
    volatile uint32_t flags;
    volatile uint32_t reserved[2];
} h1e_voice_energy_cache_t;

typedef struct h1e_voice_energy_snapshot {
    uint32_t sequence;
    uint32_t attempted_reads;
    uint32_t successful_reads;
    int32_t last_attempt_status;
    uint32_t last_good_raw_word;
    uint32_t flags;
} h1e_voice_energy_snapshot_t;

typedef enum h1e_voice_energy_snapshot_status {
    H1E_VOICE_ENERGY_SNAPSHOT_OK = 0,
    H1E_VOICE_ENERGY_SNAPSHOT_BUSY = 1
} h1e_voice_energy_snapshot_status_t;

typedef char h1e_voice_energy_sequence_offset[(offsetof(h1e_voice_energy_cache_t, sequence) == 0u) ? 1 : -1];
typedef char h1e_voice_energy_attempts_offset[(offsetof(h1e_voice_energy_cache_t, attempted_reads) == 4u) ? 1 : -1];
typedef char h1e_voice_energy_successes_offset[(offsetof(h1e_voice_energy_cache_t, successful_reads) == 8u) ? 1 : -1];
typedef char h1e_voice_energy_status_offset[(offsetof(h1e_voice_energy_cache_t, last_attempt_status) == 12u) ? 1 : -1];
typedef char h1e_voice_energy_raw_offset[(offsetof(h1e_voice_energy_cache_t, last_good_raw_word) == 16u) ? 1 : -1];
typedef char h1e_voice_energy_flags_offset[(offsetof(h1e_voice_energy_cache_t, flags) == 20u) ? 1 : -1];
typedef char h1e_voice_energy_cache_size[(sizeof(h1e_voice_energy_cache_t) == H1E_VOICE_ENERGY_CACHE_BYTES) ? 1 : -1];

/*
 * Initialize only before the object is published and before readers/writers
 * can access the cache. The existing constructor's proposed 0x80-byte zeroing
 * is sufficient; this helper exists for an explicit source integration.
 */
void h1e_voice_energy_cache_init(h1e_voice_energy_cache_t *cache);

/*
 * Publish one already-completed provider call. This function never calls the
 * provider, reads audio, interprets the word, takes a lock or allocates memory.
 * The caller must provide a valid, 4-byte-aligned cache pointer while holding
 * the same existing object guard used for the VADT tail. It must not retain an
 * object/cache pointer across an unguarded provider call. There must be exactly
 * one writer, and initialization must finish before publication/readers.
 *
 * status is stored verbatim on every attempt. raw is consumed only on status
 * zero; a failed attempt preserves last_good_raw_word and HAS_SAMPLE. Raw zero
 * after a successful call is a valid sample. The sequence counter makes a
 * bounded copy possible, not a voice-presence decision. The default barriers
 * are compiler-only, as in the current VADT core; CK802 target-memory ordering
 * must be reviewed and supplied through H1E_VE_CACHE_CPU_BARRIER before target
 * integration. The output pointer must be valid, aligned, and separate from
 * the cache storage.
 */
void h1e_voice_energy_cache_record_completed(h1e_voice_energy_cache_t *cache,
                                             int32_t status, uint32_t raw);

/* Copies one coherent snapshot in at most H1E_VOICE_ENERGY_SNAPSHOT_TRIES. */
h1e_voice_energy_snapshot_status_t
h1e_voice_energy_cache_snapshot(const h1e_voice_energy_cache_t *cache,
                                h1e_voice_energy_snapshot_t *out);

#endif
