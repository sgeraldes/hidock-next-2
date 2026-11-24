# Restricted file-write prototype (backlog)

Current status at **12 October 2026, 23:19 UTC**: custom **393988 /6.3.4_restore001** is installed and boot-confirmed, with same-device identity/capability/idle/card readbacks; there is no device-side installed-image SHA attestation. Current 393988 app transfer evidence passes full 586-entry listing/paging, bounded reads and a 2,027,676-byte SHA-matched fixture download, but does not exercise f119. A single small owned-fixture original-name restore remains unqualified; 9 MiB/full-manifest, mass backup/restore stress and exhaustive recovery remain parked. The 25-item ledger is **5 verified, 15 in progress, 5 open**; f119 and full restoration are not closed. See [flash evidence](../../research/rea/completion630-lab/runtime/current-custom393988-flash.json), [transfer evidence](../../research/rea/completion630-lab/runtime/current-transfer-contracts-1791844924345.json), [active iteration plan](active-iteration-plan.md) and [completion checklist](completion-checklist.md).

User scope correction: the requested feature is uploading local files to the dock, not restoration as a separate feature. The complete uploader is now explicitly deferred. Preserve the current .wav/.hda writer and its existing interfaces unchanged; do not require a backup receipt as a future general-upload prerequisite. The historical restoration contract below describes the restricted prototype and does not establish a finished user-facing uploader.

## Exact artifacts and evidence

|Artifact|Identity and SHA256|Boundary|
|---|---|---|
|Prior installed upload2 (before 12 Oct 2026 22:33 UTC)|393986,3,423,232 bytes; `6940d83d790992d39d41791609b264d8b76041384b367076d7fbab1744c018f7`|Historical scoped physical boot/console/scratch/WAV-marker observations; no installed flash-hash attestation.|
|Installed custom restore (12 Oct 2026 22:33 UTC)|393988,6.3.4_restore001,3,429,376 bytes; `4942c98f9a150f09b9a31b606e7e9d985e99b16873c5ef64e6e17667808d82e8`|Frozen candidate flash/automatic reboot and same-device confirmation; no installed flash-hash attestation. f119 physical restoration remains open.|
|Offline forward stock|393989,6.3.5_reaRestore2,3,379,712 bytes; `f3fd009ae8eaac58271c2b4479a4ab7441c867d0bdc56afc5d70a4f77e224578`|Original stock system with forward identity; recovery artifact, not a routine test transition.|

The [frozen generation4 index](../../research/rea/completion630-lab/firmware/restore-build393988/generation-restore4/generation-snapshot.json) binds247 files and the [qualification](../../research/rea/completion630-lab/firmware/restore-build393988/generation-restore4/qualification.json) binds114 evidence files to decoded system `b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f`. Earlier snapshots/artifacts, including the rejected snapshot3 index collision, remain preserved. The old app resources were copied before replacement. [Firmware report](../../research/rea/completion630-lab/firmware/restore-build393988/generation-restore4/REPORT-RESTORE-EXTENSION.md), [exact wire contract](../../research/rea/completion630-lab/firmware/restore-build393988/generation-restore4/restore-contract.json), [command delta audit](../../research/rea/completion630-lab/map/restore393988-command-delta-report.md).

The [actual F:/G: backup ledger](../../research/rea/completion630-lab/application/restore4-firmware-backups.json) records eight file copies, independent destination SHA readback and durable file flush for official, retained installed-generation package, the 393988 custom candidate and offline forward packages. It does not prove that F:/G: are independent physical disks, or back up installed flash/NV/calibration.

## Supported files and ownership

RSTR2 restores downloaded recording bytes under their original flat ASCII filename, maximum 27 bytes, ending in exact lowercase `.hda` or `.wav`. Original REA recording names are supported. `.mp3`, non-ASCII/path names, unsupported extensions and files above **2,147,483,647 bytes** are rejected. MP3-encoded native recordings commonly use `.hda`; the interface does not transcode or rewrite media headers, markers, padding or trailers. Unsupported manifest entries must block full restoration, not be silently skipped or renamed.

BEGIN refuses any existing final or conflicting staging path and uses native exclusiveCREATE_NEW. It never overwrites a recording. Fixed stage names are `REA%08X.tmp`, `.r0` and `.r1`; the legacy `.rsm` name also blocks a collision. The two journal slots remain512 bytes each. Stage exclusion from CMD4/6/26 is source/native-model evidence; it still needs the planned physical count/catalog comparison. CMD21 can read a valid named SD file, so catalog filtering is not an independent path-access policy.

The renderer supplies a trusted recording ID, not a path, raw bytes, owner token or arbitrary filename. Main resolves the downloaded source, rejects symlinks/invalid metadata, fingerprints the file and computes full source SHA256/CRC plus bounded block proofs. Native owner tokens and exact source/session bindings are sealed through Electron safeStorage; process/session rebind occurs only through explicit fresh same-device STATUS. Mutations require explicit owned-recording consent and audio-quiescent assurance, plus main/SDK idle/version/session checks. Prior 393986 and stock/forward versions reject f119 before probing it.

## Explicit operation sequence

The trusted preload exposes `beginOwnedRecordingRestore`, `appendOwnedRecordingRestore`, `verifyOwnedRecordingRestoreStep`, `recoverOwnedRecordingRestoreStep`, `abortOwnedRecordingRestore`, `getOwnedRecordingRestoreStatus` and `verifyOwnedRecordingRestoreReadback`. These are separate bounded owner operations; they do not automatically upload, commit or retry an uncertain mutation. [IPC owner](../../apps/electron/electron/main/ipc/jensen-handlers.ts), [service](../../apps/electron/electron/main/services/device-recording-restore.ts), [wire parser/encoder](../../packages/jensen-protocol/src/recording-restore.ts).

APPEND accepts at most **1024 bytes**, with a512-byte minimum except the final remainder, exact committed offset and chunk CRC. Each commit/recover step verifies at most **4096 payload bytes** in512-byte reads and yields between blocks. This budget does not bound FAT seek/directory traversal latency or prove physical watchdog/heap headroom on large files.

COMMIT first verifies the entire temporary file, checkpoints READY, renames only while the final is absent, checks path/size, then verifies the complete final CRC before FINISHED. Both names present requires manual investigation. RECOVER verifies the committed prefix before shortening only an owned extra tail; it never extends a file. ABORT refuses to unlink a final. A torn first owner record can require manual investigation. Rename, sector writes and power-loss recovery are not claimed atomic.

STATUS is read-only journal/stat access. A validated owner can receive full metadata with OFFSET/AMBIGUOUS errors; a four-byte rejection contains only a pre-operation hint and does not establish a durable checkpoint. After an uncertain reply, perform explicit STATUS before deciding whether an explicit RECOVER is appropriate. Never infer a new committed offset from an ACK alone.

## CRC completion versus actual source integrity

The SHA returned by RSTR2 is **stored expected-source provenance**, not a device-computed SHA. FINISHED means the firmware's full final CRC verification completed. The host reports `restore-verified` only after a complete bounded downloaded readback equals the immutable source's independently computed full SHA256 and the source/session/owner checks still agree. Listing MD5 covers at most the first1024 returned bytes and is not a substitute for full-file SHA.

Native fixtures cover215 restore cases, including wrong owner/CRC/offset, fragmentation, torn journals, short/write/sync/close faults, rename ambiguity, original names and sparse>8MiB/INT_MAX offsets. Native CMD6/CMD4/CMD26 post-publication and three CMD21 ranges reproduce an 8200-byte file exactly, with MD5-prefix evidence. ROM primitives, lower filesystem/disk/media and scheduling boundaries are explicitly modeled. The [source service report](../../research/rea/completion630-lab/application/restore-service-source-report.md) and [integrated service report](../../research/rea/completion630-lab/application/restore-service-report.md) separate those boundaries.

The latest [SDK run](../../research/rea/completion630-lab/protocol/sdk-combined-settings-final-tests.json) passed **601 tests in 44 Vitest suites/17 files**. Root's74 IPC,24 trusted-source helper and33 readback cases provide additional software evidence. The [actual Windows DPAPI test](../../research/rea/completion630-lab/application/restore-service-dpapi-physical.json) used two isolated Electron processes,752-byte ciphertext and exact strict token/SHA round-trip, with no existing app profile or device call. This proves OS sealing/process reopen for the synthetic record; it does not prove dock restoration.

## Remaining physical acceptance

The last pre-393988 catalog baseline at 18:09 UTC is 574 entries, including owned fixtures; 558 original names/sizes remain preserved. Earlier562-entry/four-owned-file observations retain their historical scope. The original recordings were not all byte-hashed.

Historical proposed sequence at 18:09 UTC: after review and explicit custom installation, verify exact393988 boot/capabilities, then one trusted owned source whose final name is absent. The 393988 boot is now confirmed, but the single-fixture f119 write/readback still remains the next physical restore acceptance. Preserve all existing originals; successful publication under an absent name alone is not a full-manifest restore. The proposed 9 MiB source and exhaustive recovery/status/readback stress are parked; the package's first stale-version-name afterPack rejection remains historical.

Full restoration, FAT timestamps, all NV/configuration/calibration, native MSC ownership/exit/card identity, missing target ROM and peripheral recovery remain unsupported or unqualified. No formatting/factory/identity/peripheral operation becomes safe merely because these software tests or package backups pass. Follow the [validation plan](validation-plan.md) and [current completion ledger](completion-checklist.md).

## Later observations after the 18:09 baseline

Historical pre-flash packaged checks at 18:11–18:13 UTC: the app ran on then-current 393986, completed 574/574 listing and an owned 556-byte full-SHA readback, returned console/profile/format/rules getters and rejected f119 before dispatch. The 17,608-file package/native/resource boundary passed; the normal installed app was not replaced. One same-value eight-byte CMD12 request returned success in 31 ms, with all four settings unchanged and native idle before/after. These do not qualify the now-installed 393988 or original-name restoration. [Packaged evidence](../../research/rea/completion630-lab/application/restore4-packaged-boundary.json), [physical smoke](../../research/rea/completion630-lab/runtime/restore4-package-current-custom-smoke.json), [physical same-value setter](../../research/rea/completion630-lab/runtime/guarded-settings-same-value-1791828838995.json).




