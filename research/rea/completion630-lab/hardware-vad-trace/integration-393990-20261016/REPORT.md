# H1E 393990 offline VAD composition

This report records one decoded-system and ACTTEST0 container composition from the pinned current H1E `6.3.6_vectors001` / version code `393990` baseline. The output remains `EXPERIMENTAL` and `NOTINSTALL`. No device, USB, app, configuration, network-install, flash, recovery, or release action was performed.

## Inputs and source pins

The selected baseline container is 3,429,376 bytes, SHA-256 `d0cd083ff19d56325dca12ea7785c4deb270cf2ef68fa6b7af1c64b0baa651a0`. Its decoded system is 1,237,504 bytes, SHA-256 `abff684071be35f29286010c13e27f8af51de364efbaedffdd12bb6e85ebd360`; the decoded boot partition is SHA-256 `7bd8bce552f7a07d3ce5bd5f25a71eb162e46ae71118d4e495e285b6034fc168`.

The no-growth linker readback manifest is pinned at SHA-256 `a3c3209d0dfba4bef2084c1b07b18027cefb38bdcbbb4860a41cd2a6af4d7ea9`. It binds the CK802 ELF `cfa7e5f8b2ebf838b54484169921f388f24bf868b316b7fb366b1574d798cfbf` and symbols file `bbcf837ea099a6cd20298b8f979fe715aa8d77a734bf16263b9c1a73a49661c6`. The manifest records two segments, their exact baseline preimages and full candidate-window fills, preserved router/console extents, and the ten instruction patches. The router segment is 1,420 bytes at `0x01128a40` over the pinned `0xff` preimage; the console segment is 440 bytes at `0x0112be00` over the pinned `0x00` preimage. Each range is within the manifest's proposed window and declared reservation. The manifest keeps reservation and ownership acceptance false; fill bytes are not treated as proof of ownership.

Composer source: `compose_393990_nogrowth.py`, SHA-256 `b61a1dcc467e716cdf2fd6cd3b0a541c495cc5e749cab921239abe38dfc57ec1`. It pins the baseline, the accepted ELF/manifest/symbols by caller-supplied SHA-256, the CK802 objdump, and read-only helper/reference sources. It applies patch bytes from the actual ELF, decodes branch targets from those bytes, validates the linked symbols, and derives an exact inverse reconstruction of the pinned baseline. It also uses the pinned `package_vad_container.py` pack/readback functions for H1E packing and applies additional 393990 same-length/offset checks.

## Observed output

The one fresh output directory is `out-NOTINSTALL/vad-393990-nogrowth-20261016T063744Z-cfa7e5f8/`.

The decoded candidate is 1,237,504 bytes, SHA-256 `c5c91e98f76a6ee14ab3e6dd7a99c24b7b3bdd3dd7bd50ca07147e3f5f923ea7`. Its on-disk readback found 1,795 differing bytes, zero differences outside the two segment ranges and ten approved instruction windows, an unchanged first 48 bytes, and exact inverse reconstruction of the original decoded system. All four linked `bsr` targets matched both the Python decoder and CK802 objdump. The constructor now allocates and clears 96 bytes, preserving its 32-byte telemetry tail.

The packed container is 3,429,376 bytes, SHA-256 `d8dd3ad71a68a7ee104b2bb074fef3c8ede86b89026094b74a20f3121e24f5dc`. Its on-disk readback confirms the same partition offsets, encoded zephyr size, boot payload, and other partition payloads as baseline. The XML changed only the zephyr checksum value; the size remained unchanged. The package helper and the independent ACTTEST0/parser checks agree, and the packed zephyr decodes to the candidate SYS. Outer CRCs read back as header `0x48acb03c` and data `0x4ee4f38a`.

The receipt confirms all pinned inputs were unchanged after composition and sets `installable`, `approved_for_installation`, `installed`, `physical_boot_verified`, `hardware_qualified`, and release/publication to false. The candidate preserves the same version identity; it does not allocate a new version.

## Remaining qualification

This is offline structural evidence only. Shared reservation ownership/acceptance is still false in the layout manifest. No CK802 execution or physical H1E VAD behavior was tested. Installation, device boot, power/thermal behavior, recovery, installer handling of the same version, and release qualification remain unverified. Do not treat this artifact as install-qualified.
