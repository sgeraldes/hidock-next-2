# H1E VAD firmware container packaging seam

Status: EXPERIMENTAL-NOTINSTALL. Offline structural packer only. Same identity as the baseline
(6.3.4_restore001 / 393988), no new version allocated, so any output is not an update approved for
installation. No binary release or publication.

## What exists

| File | Role |
| --- | --- |
| `package_vad_container.py` | Fail-closed packer. Run with `python -I`. SHA-256 `2477a315db72eee36086089686b280da078655c525d7ecd330a09ef1fa436918` (after the out-root fix; the baseline roundtrip and root's packing ran the earlier `3f7c0a11...0ca4`) |
| `selftest.py` | Synthetic code-path test (1 accept, 5 reject). Not candidate evidence. SHA-256 `4ce87cef623e7a4bd66f0162173896fe030aafa8700db289499f98604c7596ed` |
| `out/<run-id>/` | One fresh directory per run: the artifact and `receipt.json`. Never overwritten. |

## Pinned inputs (verified before any work)

| Input | SHA-256 |
| --- | --- |
| baseline container `candidate-393988-restore3/H1E-6.3.4_restore001-...bin` | `4942c98f9a150f09b9a31b606e7e9d985e99b16873c5ef64e6e17667808d82e8` |
| baseline decoded system | `b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f` |
| baseline encoded `zephyr.bin` | `b8d55ca24d1926c6a0a95a89e8316f7f98a4137100635bd202d2139ad54b5146` |
| baseline decoded boot | `78dee3943ad56561cb89d66c56e476f234ee3681b223f8e7e45e3d30badb41f6` |
| `references/build_atf_image.py` (SDK builder) | `30b5d37f67bb57af44d02da829429c59bb734d5c7c0acc1a1ce5f15029401c17` |
| `decode_randomizer.py` | `3a9a945dafe6a81327d9f15e0619befc30109fd9e8ce58e2af8e7d5e7e734de5` |
| `extract_acttest.py` | `8adf114c2ee531f12778b346482c344717659a130892515258505781efccc592` |

Helpers are loaded from their bytes after the hash check. The SDK builder is copied into a temp
directory and run with `python -I`, so nothing in the output directory is imported.

## Usage

```powershell
# Baseline roundtrip (unchanged system). Evidence for the packer only.
python -I package_vad_container.py --mode baseline-roundtrip

# Actual candidate, once firmware-integration/ has an accepted manifest.
python -I package_vad_container.py --mode candidate `
  --candidate-manifest G:\...\firmware-integration\<manifest>.json `
  --expect-candidate-sha256 <sha256 given by root, not read from the manifest> [--allow-growth]
```

Exit 0 on success, 2 on any fail-closed check. Failures print `FAIL-CLOSED: <reason>` and leave no receipt.

## Candidate manifest contract

Root's `packing-input-manifest.json` uses this schema and the packer accepted it unchanged. Anything else is rejected.

```json
{
  "schema": "h1e-vad-candidate-manifest-v1",
  "accepted": true,
  "installable": false,
  "baseline_system_sha256": "b338e4d5...",
  "candidate_system": {"path": "relative/file.bin", "sha256": "...", "bytes": 0},
  "readback": {"verified": true, "candidate_sha256": "..."},
  "changes": [{"offset": 0, "length": 0, "new_sha256": "..."}]
}
```

Checks before packing: manifest and candidate sit inside the integration root; candidate SHA-256
matches the externally supplied pin, the manifest claim and the readback entry; every byte that
differs from the baseline system lies inside a listed change range, each range hash matches the
candidate bytes, ranges do not overlap; system inner header (first 48 bytes) unchanged and parses the
same; growth past the baseline size is refused unless `--allow-growth` is passed and the appended bytes
are fully covered by changes; an unchanged candidate is refused (use roundtrip mode).

## Packing

`zephyr.bin` = candidate through `decode_randomizer.transform(..., 0x08000050, decrypt=False)`.
`ota.xml` changes only the zephyr `file_size` and `checksum` fields. The other six partitions are
passed to the SDK builder as the baseline bytes, in baseline order.

## Readback (computed from the artifact re-read from disk after the builder exits)

- Independent ACTTEST0 parser (in this script): outer header CRC, outer data CRC, per-partition CRC,
  contiguous 512-aligned offsets, 0xff padding, no trailing bytes. The pinned `extract_acttest.parse` must agree.
- Decoded `zephyr.bin` from the real container equals the candidate system.
- `mbrec.bin`, `RomeApp.bin`, `UAC.bin`, `IG1202dl.bin`, `sdfs.bin` byte-identical to the baseline.
- Boot FVER block: version 393988, name `6.3.4_restore001`, CRC valid, decoded hash equals baseline boot.
- `ota.xml` field-level diff against the baseline: only zephyr `file_size` and `checksum` may differ.
- Partition order and load/run addresses unchanged.

`receipt.json` is written last, from those values only. It records script and helper hashes, the
flags below and the gates below. Nothing is read from earlier runs.

## Evidence 1: VAD candidate, structural NOTINSTALL

Input from root: `root-assembly/packing-input-manifest.json` (schema `h1e-vad-candidate-manifest-v1`), candidate
system SHA-256 `ad86193a8a35a64d2ec036a5f32f6741a00ab4f29314b263205dc606db1b2ac0`, passed as the external pin.
Run once with `--allow-growth` and a fresh relative `--out-root out-vad-relative`
(run `vad-candidate-20261013T195411Z-ad86193a`), exit 0.

| Item | Value |
| --- | --- |
| Packed container SHA-256 | `5eea2c5af70e523b4518caa94fe0097a2660d02c34b4cdb747748612fd2211bd` |
| Root's earlier absolute-path run | same SHA-256, same outer CRCs `0x5b1b4c84` / `0xbfa7d070`, same decoded system, same per-partition hashes |
| Decoded `zephyr.bin` from the container | equals the candidate system |
| `zephyr.bin` | 1237504 -> 1243776 bytes (+6272 appended, 22 changed bytes inside the baseline span, 13 allowlisted ranges) |
| Container | 3429376 -> 3435520 bytes (+6144) |
| `ota.xml` | only zephyr `file_size` and `checksum` changed |
| `mbrec.bin`, `RomeApp.bin`, `UAC.bin`, `IG1202dl.bin`, `sdfs.bin` | byte-identical to baseline |
| Boot identity | unchanged, 6.3.4_restore001 / 393988 |
| Receipt status | `structural_readback_passed_EXPERIMENTAL_NOTINSTALL`, `installable` false, `NOTINSTALL` true |

The five partitions after `zephyr.bin` keep their bytes but all moved to higher offsets because the system grew
(`offset_moved` is true for each in the receipt). Whether the device layout tolerates that shift is the layout gate below.
Identity is unchanged, no version was allocated, so this container is not an update approved for installation.
The receipt and artifact are under `out-vad-relative/vad-candidate-20261013T195411Z-ad86193a/`; the artifact is
not a release and must not be published.

## CLI fix: relative `--out-root`

A relative `--out-root` reached the SDK builder subprocess as a relative artifact path while the subprocess ran in a
temp working directory, so it failed with `FileNotFoundError`. `main()` now resolves `--out-root` to an absolute path
before creating directories or invoking the builder (`args.out_root = args.out_root.resolve()`). Helper pins and every
safety check are unchanged. The run above is the verification: relative root, exit 0, artifact hash equal to root's.

## Evidence 2: baseline roundtrip (packer check only, not VAD evidence)

Run `baseline-roundtrip-20261013T194649Z-b338e4d5`, unchanged system, not VAD candidate evidence.
The rebuilt container is byte-identical to the baseline (`4942c98f...2e8`), outer header CRC `0x12306564`,
outer data CRC `0x725f3c06`, all seven partitions byte-identical, `ota.xml` field diff empty.
This shows the packer, the randomizer and the pinned SDK builder reproduce the known container.
`selftest.py` exercised the candidate path on a synthetic 8-byte change in a scratch directory
(deleted afterwards): accepted the valid case and rejected a wrong external pin, a change outside the
allowlist, an unaccepted manifest, an installable claim and a readback mismatch. It does not cover
growth, range overlap, helper-hash tampering or a failing SDK build.

## Receipt flags

`EXPERIMENTAL`, `NOTINSTALL` true. `installable`, `approved_for_installation`, `installed`,
`physical_boot_verified`, `hardware_qualified`, `new_version_allocated`, `release_or_publication`,
`full_vendor_source_rebuild`, `ROM_unbrick_recovery` false. `same_identity_as_baseline` true.

## Remaining gates (also in every receipt)

- Layout: zephyr size and flash-partition fit, and any shift of following partitions, are not qualified.
  The packer reports the size delta and whether offsets moved; it does not judge fit.
- Lifetime: VAD runtime ownership, task and stack lifetime, CK802 bridge and teardown are not qualified.
- Hardware: no physical boot, microphone stream, power or thermal qualification.
- Recovery: ROM unbrick path not verified.
- Installer: equal-version identity, so installer acceptance is untested and the file must not be installed.
- Source: not a full vendor source rebuild.
