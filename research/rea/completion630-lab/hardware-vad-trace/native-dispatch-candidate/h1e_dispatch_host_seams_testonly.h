/*
 * TEST ONLY. Used when console630_f11a.c is built with -DH1E_DISPATCH_HOST_TEST.
 * It replaces the fixed target addresses of the frozen console630.c (pending
 * command 0x855dc, f117 idle flag 0x855cc, fallbacks 0x01128698/0x01128798,
 * kernel getter 0x0103c664, firmware word 0x00100f84, uptime getter 0x01090054)
 * and the 32-bit frame-word-to-pointer cast with functions the host test
 * defines, so the real dispatch functions run without any mapped address.
 * Never include this from a target build.
 */
#ifndef H1E_DISPATCH_HOST_SEAMS_TESTONLY_H
#define H1E_DISPATCH_HOST_SEAMS_TESTONLY_H

#include <stdint.h>

extern uint8_t *h1e_test_resolve(uint32_t word);
extern uint32_t h1e_test_pending_cmd(void);
extern uint32_t h1e_test_f117_idle(void);
extern int h1e_test_fallback_parse(uint8_t *frame, const uint8_t *body, uint32_t length);
extern int h1e_test_fallback_response(uint8_t *frame);
extern uint32_t h1e_test_kernel_version(void);
extern uint32_t h1e_test_fw_version(void);
extern uint32_t h1e_test_uptime_low(void);

#define H1E_PTR(w) h1e_test_resolve(w)
#define H1E_PENDING_CMD() h1e_test_pending_cmd()
#define H1E_F117_IDLE() h1e_test_f117_idle()
#define H1E_FALLBACK_PARSE(f, b, l) h1e_test_fallback_parse(f, b, l)
#define H1E_FALLBACK_RESPONSE(f) h1e_test_fallback_response(f)
#define H1E_KERNEL_VERSION() h1e_test_kernel_version()
#define H1E_FW_VERSION() h1e_test_fw_version()
#define H1E_UPTIME_LOW() h1e_test_uptime_low()

#endif
