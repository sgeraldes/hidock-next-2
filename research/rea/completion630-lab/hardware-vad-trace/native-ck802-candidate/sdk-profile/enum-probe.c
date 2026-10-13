/* Compile-metadata probe only. Never linked into the module. */
#include "vadt_core.h"
#include "vadt_frame.h"

const unsigned char probe_sizeof_vadt_status = (unsigned char)sizeof(vadt_status_t);
const unsigned char probe_sizeof_vadt_age_status = (unsigned char)sizeof(vadt_age_status_t);
const unsigned char probe_char_is_signed = (unsigned char)((char)-1 < 0);
const unsigned char probe_sizeof_telemetry = (unsigned char)sizeof(vadt_telemetry_t);
