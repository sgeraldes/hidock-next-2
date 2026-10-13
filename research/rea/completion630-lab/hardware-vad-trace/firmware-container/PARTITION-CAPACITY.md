# Software partition-capacity evidence

## Finding

The retained files do **not** establish an H1E-specific upper bound or XIP region for the `0x12fa80` byte `zephyr.bin`. They contain a generic ATS2853P2 EVB Zephyr sample configuration with a linker ROM region, and separate H1E firmware/container metadata labeled `ats2835p_evb`. No retained evidence connects those two configurations or supplies the H1E production SYSTEM partition extent. Therefore target partition fit remains unproven.

## What the retained SDK config bounds

The captured `.config` is for `samples/bt_speaker/outdir/ats2853p2_evb_285l2`, with `CONFIG_BOARD="ats2853p2_evb"`, `CONFIG_SOC="ats2853p2"`, and `CONFIG_XIP=y` (`research/rea/references/build-contracts/samples--bt_speaker--outdir--ats2853p2_evb_285l2--.config:18-21,46`). It sets `CONFIG_FLASH_BASE_ADDRESS=0x01000000`, `CONFIG_FLASH_SIZE=1472`, `CONFIG_FLASH_LOAD_OFFSET=0`, and `CONFIG_FLASH_LOAD_SIZE=0` (same file:602-603,1523-1524). The retained linker script selects FLASH as the ROM region for XIP and computes its length as `CONFIG_FLASH_SIZE * 1K - CONFIG_FLASH_LOAD_OFFSET` when load size is zero (`research/rea/references/sdk-contracts/linker.ld:27,50-54,100`). Applied to that sample config, this gives a generic link region `[0x01000000, 0x01170000)` of `0x170000` bytes.

Conditionally placing a `0x12fa80` byte image linearly at `0x01000000` would end at `0x0112fa80`, `0x40580` bytes before that sample link-region end. This is only arithmetic against the captured ATS2853P2 EVB sample. It does not show that the H1E production SYSTEM partition uses this region or size. The corresponding board defconfig defaults `CONFIG_FLASH_SIZE=2000` (`research/rea/references/build-contracts/boards--csky--ats2853p2_evb--ats2853p2_evb_defconfig:6-11,46-47`), while the captured sample `.config` uses 1472. Neither is identified as the H1E product partition map.

## What the H1E container metadata says

The frozen `6.3.4_restore001` manifest and its OTA XML label the board `ats2835p_evb`; the XML identifies `zephyr.bin` as SYSTEM partition id 3 and records its current file size and checksum (`research/rea/completion630-lab/firmware/restore-build393988/candidate-393988-restore3/manifest.json:12,25-34`; `.../parts/ota.xml:7,20-25`). The frozen file size is `0x12e200`; the experimental candidate records `0x12fa80`. These are payload lengths and CRCs, not partition capacities. The packed-container table uses zero load and run addresses for `zephyr.bin`; its offsets are offsets within the container file, not flash addresses.

The inner system header reports load address `0x01000000`, but its body-size and tail-size fields are zero and the header is explicitly marked unchecksummed (`manifest.json:97-105`). That marker does not define a usable image end or a flash partition limit. The actual container parser confirms the candidate's encoded `zephyr.bin` size is `0x12fa80`, but a valid container CRC only proves file integrity.

The retained vendor packer shows what is missing: it reads per-partition `address`, `size`, and `file_address` from a source `<firmware>` configuration and uses them to calculate and reject files larger than their partition (`research/rea/references/build_firmware.py:351-390,434-457`). The same script's 4 MiB `disk_size` is only a generic constructor default unless a source config provides `<disk_size>` (`build_firmware.py:328-361`); it is not a device-specific partition declaration. No such H1E firmware config or SYSTEM partition map is present in the retained `research/rea/references` files. The OTA XML is a delivery manifest and does not contain those address/limit fields.

## Required evidence to close this gate

The missing software descriptor is the production H1E firmware configuration (or equivalent authoritative partition table) that names the SYSTEM/Zephyr partition's flash start, maximum size/end, image/file load address, and the relevant flash capacity/topology. It must also tie the ATS2853P2 SDK target and linker region to the `ats2835p_evb` firmware identity used for H1E. Until that descriptor is retained and reconciled, neither the sample's `0x170000` linker span nor the previous image length can be used as a target-fit bound for this candidate.

No firmware build, test, device query, or hardware operation was performed for this review.
