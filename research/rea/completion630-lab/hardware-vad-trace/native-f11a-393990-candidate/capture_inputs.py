"""Capture and pin only the inputs used by the conditional 393990 source link."""
import hashlib
import json
import sys
from pathlib import Path

lab = Path(__file__).resolve().parent
vad = lab.parent
repo = lab.parents[4]
capture = repo / "research/rea/completion630-lab/firmware/capture-vector-selected-diagnostic"
native = capture / "out-NOTINSTALL/run2/native"
current_sys = capture / "out-NOTINSTALL/container-compose3/system-decoded.bin"
baseline = repo / "research/rea/completion630-lab/firmware/restore-build393988/generation-restore4"
accepted_vad = vad / "native-ck802-candidate"

expected = {
    current_sys: "abff684071be35f29286010c13e27f8af51de364efbaedffdd12bb6e85ebd360",
    native / "native630.elf": "105ddea56a8879e40cd0a0fa570203edae3eb4b22dbccd4da870acda8a1fa8ee",
    native / "native630.bin": "9c9886db930ed54a51574d8b278d01b9359a07a99ab5e63407ed649d2acc09a2",
    baseline / "system-decoded-NOTINSTALL.bin": "b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f",
}

paths = list(expected)
paths += [
    native / "symbols.txt",
    native / "console630.c",
    capture / "REPORT.md",
    capture / "receipts/root-system-compose1.json",
    capture / "out-NOTINSTALL/container-compose3/manifest.json",
    capture / "out-NOTINSTALL/container-compose3/parts/ota.xml",
    baseline / "module.ld",
    baseline / "console-hooks.S",
    baseline / "symbols.txt",
    vad / "native-link-candidate/poll-hook.S",
    vad / "lifecycle-followup/late-publication/late-publication.s",
    vad / "lifecycle-closure-20261016/REPORT.md",
    vad / "native-ck802-candidate/check-inputs.py",
    accepted_vad / "sdk-profile/REPORT.md",
    accepted_vad / "sdk-profile/output/sparse-source-hunks.json",
    accepted_vad / "sdk-profile/output/conditional-source-ck802-sdk-NOTINSTALL.elf",
    accepted_vad / "sdk-profile/output/symbols.txt",
    vad / "native-frame-candidate/vadt_frame.h",
    vad / "native-dispatch-candidate/h1e_vad_snapshot.h",
]

for folder in [
    "fresh-sample-candidate",
    "native-frame-candidate",
    "native-poll-candidate",
    "native-loader-candidate",
]:
    source_folder = vad / folder
    paths.extend(sorted(source_folder.glob("*.c")))
    paths.extend(sorted(source_folder.glob("*.h")))

paths += [
    lab / "f11a_console_dispatch.c",
    lab / "f11a_dispatch_host_seams_testonly.h",
    lab / "f11a_console_dispatch_test.c",
    lab / "module.ld",
    lab / "export_strict_manifest.py",
    lab / "capture_inputs.py",
    lab / "build_candidate.sh",
    repo / "research/rea/completion630-lab/hardware-vad-trace/placement-393990-20261016/REPORT.md",
    repo / "research/rea/completion630-lab/hardware-vad-trace/placement-393990-20261016/COMPATIBILITY-393990.json",
]

sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
for path, expected_sha in expected.items():
    actual_sha = sha(path)
    assert actual_sha == expected_sha, (str(path), actual_sha, expected_sha)

symbols = {}
for line in (native / "symbols.txt").read_text().splitlines():
    parts = line.split()
    if len(parts) >= 3:
        try:
            symbols[parts[-1]] = int(parts[0], 16)
        except ValueError:
            pass
assert symbols.get("console630_parse") == 0x0112B70C
assert symbols.get("console630_response") == 0x0112B800
assert symbols.get("console630_parser_hook") == 0x0112BA58
assert symbols.get("console630_response_hook") == 0x0112BAA0

resolved = sorted({path.resolve() for path in paths}, key=lambda path: str(path))
pins = {
    "schema": "h1e-vad-393990-build-input-pins-v1",
    "status": "conditional_source_link_inputs_pinned",
    "expected_artifact_sha256": {str(path.relative_to(repo)): digest for path, digest in expected.items()},
    "hashes": {str(path.relative_to(repo)): sha(path) for path in resolved},
}
output = Path(sys.argv[1]).resolve()
output.write_text(json.dumps(pins, indent=2) + "\n")
print(json.dumps({"path": str(output), "input_count": len(resolved), "pinned_current_sys": pins["expected_artifact_sha256"][str(current_sys.relative_to(repo))]}))
