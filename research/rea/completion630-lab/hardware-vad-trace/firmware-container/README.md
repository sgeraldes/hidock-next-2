# VAD container manifest seam

`adapt_vad_manifest.py` translates the accepted decoded-image readback into the input contract
used by `package_vad_container.py`. It does not build or rewrite the decoded candidate. The adapter
checks the pinned acceptance record, each declared input file, the CK802 ELF and sparse hunk
manifest, and the actual candidate bytes before it writes anything.

The generated manifest is created with exclusive-create at
`firmware-integration/output/container-packing-input-manifest.json`. Re-running against an existing
manifest fails with `OUTPUT_EXISTS`; preserve or inspect that file rather than replacing it. The
candidate stays at `firmware-integration/output/system-decoded-vad-ck802-NOTINSTALL.bin`.

Run the adapter from the repository root with the workspace Python:

```powershell
python -I research/rea/completion630-lab/hardware-vad-trace/firmware-container/adapt_vad_manifest.py
```

After reviewing the adapter's printed pins and range counts, make one fresh offline container
output with the pinned packer. This command is the downstream seam; it does not install or send the
artifact to a device:

```powershell
wsl.exe --exec python3 -I /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/firmware-container/package_vad_container.py --mode candidate --candidate-manifest /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/firmware-integration/output/container-packing-input-manifest.json --expect-candidate-sha256 ad86193a8a35a64d2ec036a5f32f6741a00ab4f29314b263205dc606db1b2ac0 --allow-growth --out-root /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/firmware-container/out-vad-adapter
```

The adapter derives ten ranges from the pinned unapplied CK802 sparse hunks and three ranges from
the actual append: zero gap, ELF `.vad_text`, and zero alignment pad. Every hunk preimage is checked
against the frozen baseline and every hunk result against the candidate readback. It checks the
whole baseline-length diff and verifies the appended `.vad_text` bytes against the pinned ELF.
The existing root-assembly manifest under the private Electron cache is not required for this
workflow. If it is present and an additional cross-check is useful, pass it explicitly with
`--compare-root-manifest <path>`; the adapter then verifies its pin and compares its ranges.

The output remains `EXPERIMENTAL` / `NOTINSTALL`: it preserves the 6.3.4_restore001 / 393988
identity. The manifest records `installable`, `hardware_qualified`,
`production_lifetime_qualified`, and `combined_pipeline_layout_qualified` as false. The packer's
receipt carries the remaining layout, lifetime, hardware, recovery, installer, and source gates.
The adapter validates evidence and makes the manifest consumable; it does not qualify any of those
gates or establish runtime VAD behavior.

For the packer's fixed inputs, output checks, and existing structural evidence, see [REPORT.md](REPORT.md).

## Observed adapter-to-packer run

On 2026-10-13, the adapter wrote the manifest above with SHA-256
`cb4326116421938b7617a81a15b9775066349a9d1f26eadb05f5cfb2d6bacb0f`. One WSL candidate-mode
packer run consumed it and wrote
`out-vad-adapter/vad-candidate-20261013T204414Z-ad86193a/receipt.json` (receipt SHA-256
`1e8a0f7ede8a3a54ec0b24713882e8aefb6f4f2e76b271277e7819dd80936d1a`). Its actual container
readback was 3,435,520 bytes, SHA-256
`5eea2c5af70e523b4518caa94fe0097a2660d02c34b4cdb747748612fd2211bd`; a separate on-disk hash
matched the receipt, and the decoded system hash matched the candidate pin. The receipt status is
`structural_readback_passed_EXPERIMENTAL_NOTINSTALL`, with `installable`, physical boot, hardware
qualification, and release flags false. Following partition offsets move because `zephyr.bin`
grew; flash geometry remains unqualified.
