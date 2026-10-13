/*
 * Snapshot-reader seam for the tentative f11a command. Source candidate only.
 *
 * h1e_vad_snapshot_read is declared here and DEFINED NOWHERE in this folder, on
 * purpose. Linking console630_f11a.c into anything fails with an undefined
 * reference until a reviewed definition exists. A definition must sit on the
 * accepted object loader, constructor-order, lifetime and IRQ-guard work
 * (see ../fresh-sample-candidate/CONTRACT.md section 8). No fake UNAVAILABLE
 * implementation is provided for production, and none may be added to make the
 * link succeed.
 *
 * Contract: fill all VADT_REPLY_SIZE bytes of reply, return the status written
 * in reply[0], never call the DSP getter, never write settings or storage. ctx
 * is NULL when called from the native response route.
 */
#ifndef H1E_VAD_SNAPSHOT_H
#define H1E_VAD_SNAPSHOT_H

#include "vadt_frame.h"

vadt_status_t h1e_vad_snapshot_read(void *ctx, uint8_t reply[VADT_REPLY_SIZE]);

#endif
