# VoiceEnergy raw getter: contract and prepared adapter

This note records the exact native path and a caller-invoked, default-disabled C adapter. It adds no hook, firmware integration, SDK/IPC change, or physical operation.

## Image identity and parity

- The pinned 6.3.0 decoded SYS is `research/rea/h1e-6.3.0-verified/zephyr-decoded.bin`, SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce`.
- Continuation SYS 393997 / 6.3.13 is `research/rea/completion630-lab/firmware/producer-continuation-system-393997/out-NOTINSTALL/system-decoded-393997-continuation-NOTINSTALL.bin`, SHA-256 `a86acfa502575c0151d31782996b91cebe5143e38f472aa5763915633e825c7e`; base `0x01000000`.
- Direct byte comparisons at the same base matched between those inputs for the native case path `0x0101efa4..0x0101f06e`, common slot entry `0x0101f0ec..0x0101f0f6`, callback/wrapper region `0x0101fa78..0x0101fd60` (including the function at `0x0101fb94`), and setter/init window `0x01020100..0x01020240`, including literal cells at `0x010201d4` and `0x0102020c`. The exact range hashes and whole-input hashes are in [sys-parity-630-vs-393997.json](evidence/sys-parity-630-vs-393997.json). Previously compared `0x0101f93a`, `0x0101f9cc`, `0x0108fad8..0x0108fb5e`, and `0x0106e764..0x0106e7e0` also match byte-for-byte. The retained path disassemblies are [SYS 393997 evidence](evidence/sys-393997-provider-path.txt) and [pinned 6.3.0 evidence](evidence/sys-630-provider-path.txt); targeted wait instructions are [wait-path-393997.txt](evidence/wait-path-393997.txt).

## ABI and return contract

1. Native caller `0x01020d9c` zeroes a 32-bit stack word and calls `0x0101fa9c` with its address (`research/rea/protocol-depth630-lab/audio-host/native/01020d9c.c:8-13`; table `.../01020d9c.tsv:1-18`).
2. Wrapper `0x0101fa9c` loads slot `0x80e70`, passes selector `0x4009ffd0` in r0 and the caller's output pointer in r1, calls the slot and propagates its status (`research/rea/protocol-depth630-lab/audio-host/native/0101fa9c.c:5-14`; disassembly excerpt in [wait-path-393997.txt](evidence/wait-path-393997.txt)).
3. Startup copy initializes `0x80e70` to `0x0101f0ec`. That common slot entry fixes r2 to 1 before calling `0x0101f0bc`; this overrides any prior caller value and requests at most one word. Target `0x0101f93a` writes metadata value 2 and returns 0. With the initialized state `*(uint32_t *)0x80e88 == 4`, the metadata-2 path reaches `0x0101f824`, where the request is clamped to one word and the transport is called with a 4-byte output length. Slot `0x85290` is expected to hold `0x0101fa78`; it accepts an 8-byte request descriptor, then requires the read count to equal the requested 4 bytes. These branches and call arguments are in the two retained SYS path disassemblies linked above.
4. The native wrapper's status is boolean on this route: `0` means the transport returned all four requested bytes; nonzero means failure/short transfer. `0x0101fa9c` returns that value unchanged. In `0x0101f9cc`, ten not-ready polls return a partial byte count; exhaustion of its outer counter returns `-1`. The adapter therefore copies its private 4-byte local word to the caller only on native status 0 and returns every nonzero native status unchanged.

The read remains semantically raw. These bytes do not establish that the value means speech, identify its channel, or prove freshness. The 393997 physical receipt independently observed `0x852a4 == 0x0101f93a`; it did not capture the other three preflight words or prove the raw value's meaning.

## Waiting and context

The 10-readiness-poll and 20-counter limits in `0x0101f9cc` bound local attempts, not elapsed time. Each not-ready result calls `0x0108fad8(1)`. That helper queues an event using the incremented value 2 and then calls `0x0106e764`; the latter waits until a context word changes, with no local counter or deadline. Its exact time unit and the latency of indirect manager vtable methods are not established here. A timer/event failure could therefore hold the synchronous read; this code does not prove a hard wall-clock timeout. This is an existing wait in the native polling route, not an adapter-only lock or evidence that normal timer delivery fails; it limits the latency claim and must be exercised in the real poll context.

The helper saves CR0/PSR, briefly clears IE while updating its timer list, then enters the event wait that enables IE. C-SKY's PSR.IE mask is bit 6: the kernel C-SKY `irqflags.h` reads PSR and defines IRQ-disabled as `!(flags & (1<<6))` ([source](https://raw.githubusercontent.com/torvalds/linux/master/arch/csky/include/asm/irqflags.h), lines 5-11 and 37-40). The adapter only reads PSR with `mfcr`; it never changes PSR. It rejects entry with IRQs already masked and is intended only for the ordinary RefChannelVAD poll context being extended, outside a critical section. This does not assume the standalone native VoiceEnergy caller is already active. Do not call it from USB, an ISR, or an IRQ-masked section. The RAM and PSR checks are sequential; they are not atomic and do not prevent later state changes.

## Prepared adapter

- [vad_provider_raw_get.c](src/vad_provider_raw_get.c) exposes `int32_t vad_provider_raw_get(uint32_t *raw_word)`. [vad_provider_raw_get.h](src/vad_provider_raw_get.h) documents its statuses.
- Compile-time default is `VAD_PROVIDER_RAW_ENABLE=0`; this stub zeros a non-null output and returns `STATUS_DISABLED` without reading RAM or calling firmware. No caller or hook is included. An enabled build still does nothing until a caller explicitly invokes it.
- Enabled entry zeros the caller output, samples each reached gate once as a volatile 32-bit word, and never follows pointers during preflight. It checks `0x80e70 == 0x0101f0ec`, `0x852a4 == 0x0101f93a`, `0x85290 == 0x0101fa78`, `0x80e88 == 4`, then PSR.IE bit 6. Distinct negative statuses are: `-3` slot `0x80e70`, `-4` slot `0x852a4`, `-5` slot `0x85290`, `-6` state `0x80e88`, and `-7` IRQ masked. `-1` is disabled; `-2` is a null output pointer. Once the native call is made, its exact return is preserved. The verified native callback reports a boolean full-transfer result (0/1), so these admission statuses are separate for this route; a future ABI should retain admission provenance separately from native status. On every nonzero result the caller's output remains zero.
- The gate validates the expected route and state only. It does not prove manager readiness, timer delivery, microphone activity, or raw semantics. No runtime call has been made.

## Compile evidence

Toolchain: existing `csky-abiv2-elf-gcc` 6.3.0; target CK802, little-endian, soft-float. Both default-disabled and explicitly enabled relocatable objects are in `build/`.

```text
csky-abiv2-elf-gcc -std=c99 -mcpu=ck802 -EL -msoft-float -Os -ffreestanding -fno-builtin -Wall -Wextra -Werror -c src/vad_provider_raw_get.c -o build/vad_provider_raw_get.disabled.o
csky-abiv2-elf-gcc -std=c99 -mcpu=ck802 -EL -msoft-float -Os -ffreestanding -fno-builtin -Wall -Wextra -Werror -DVAD_PROVIDER_RAW_ENABLE=1 -c src/vad_provider_raw_get.c -o build/vad_provider_raw_get.enabled.o
```

Both compiled cleanly. `size -A` reports `.text=20` bytes for the disabled object and `.text=148` bytes for the enabled object; both have `.data=0` and `.bss=0`. `nm -u` reports no undefined symbols. Enabled-object disassembly confirms four 32-bit gate loads, `mfcr cr<0,0>` followed by a bit-6 test, a call to absolute `0x0101fa9c`, and copying the local word only on status 0. These are compile/object checks only; the enabled object has not been linked into firmware or run.

## Remaining boundary

The next useful validation is an explicit call in the existing RefChannelVAD poll context that captures the returned raw word/status. Keep it default-off. A physical run is still needed to verify the context, timer/event behavior, provider response, and interpretation; none is claimed by this source preparation.
