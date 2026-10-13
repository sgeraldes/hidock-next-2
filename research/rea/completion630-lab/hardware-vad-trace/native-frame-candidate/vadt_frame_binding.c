#include "vadt_binding.h"
#include "vadt_frame.h"

vadt_status_t vadt_f11a_binding_reader(void *ctx, uint8_t reply[VADT_REPLY_SIZE])
{
    return vadt_binding_read((const vadt_binding_ops_t *)ctx, reply);
}
