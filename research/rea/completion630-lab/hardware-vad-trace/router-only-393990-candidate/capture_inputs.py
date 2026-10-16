"""Capture immutable inputs for the router-only 393990 source link."""
import hashlib
import json
import sys
from pathlib import Path


LAB = Path(__file__).resolve().parent
TRACE = LAB.parent
REPO = LAB.parents[4]
CAPTURE = REPO / "research/rea/completion630-lab/firmware/capture-vector-selected-diagnostic"
NATIVE = CAPTURE / "out-NOTINSTALL/run2/native"
SYS = CAPTURE / "out-NOTINSTALL/container-compose3/system-decoded.bin"
BASELINE = REPO / "research/rea/completion630-lab/firmware/restore-build393988/generation-restore4"
ROUTER = REPO / "research/rea/hardening630-lab/fixed-router"
ACCEPTED = TRACE / "native-f11a-393990-candidate/output/accepted-vad-inputs.json"
PREVIOUS = TRACE / "native-f11a-393990-candidate/output"
LAYOUT = TRACE / "no-growth-393990-candidate"

EXPECTED = {
    SYS: "abff684071be35f29286010c13e27f8af51de364efbaedffdd12bb6e85ebd360",
    NATIVE / "native630.elf": "105ddea56a8879e40cd0a0fa570203edae3eb4b22dbccd4da870acda8a1fa8ee",
    NATIVE / "native630.bin": "9c9886db930ed54a51574d8b278d01b9359a07a99ab5e63407ed649d2acc09a2",
    ROUTER / "router630.elf": "f102c7703ce3f75e1f327bafb756367d5148fc0fa676f7f0391d26d56cc7bd3a",
    ROUTER / "router630.bin": "d518f0e40749eb73cf2dc9cdf3c0bb3efb3cf2b111115971a03f01cc0e547487",
    PREVIOUS / "f11a-393990-ck802-sdk-NOTINSTALL.elf": "8cdf67a3d019a206296207817ab55f18477e88ea96fcf611d10fa7a563b744e8",
    PREVIOUS / "sparse-source-hunks-393990.json": "a0568b6555111d272786ace658a41835291cb4d4bae10db37dcab4bc1539d01c",
    LAYOUT / "output/layout-readback.json": "a3c3209d0dfba4bef2084c1b07b18027cefb38bdcbbb4860a41cd2a6af4d7ea9",
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pin(path: Path, expected: str | None = None) -> dict:
    digest = sha(path)
    if expected is not None:
        assert digest == expected, f"hash drift: {path}: {digest} != {expected}"
    return {"path": str(path.relative_to(REPO)), "bytes": path.stat().st_size, "sha256": digest}


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: capture_inputs.py OUTPUT.json")

    accepted = json.loads(ACCEPTED.read_text())
    assert accepted["match"] is True
    accepted_hashes = accepted["hashes"]
    accepted_source_pins = {}
    for relative, expected in sorted(accepted_hashes.items()):
        raw = Path(relative.replace("\\", "/"))
        path = raw if raw.is_absolute() else REPO / raw
        accepted_source_pins[relative] = pin(path, expected)

    expected_artifacts = {str(path.relative_to(REPO)): pin(path, digest) for path, digest in EXPECTED.items()}
    extras = [
        NATIVE / "symbols.txt",
        ROUTER / "module.ld",
        ROUTER / "dependencies.ld",
        BASELINE / "system-decoded-NOTINSTALL.bin",
        BASELINE / "console-hooks.S",
        TRACE / "native-link-candidate/poll-hook.S",
        TRACE / "lifecycle-followup/late-publication/late-publication.s",
        TRACE / "native-f11a-393990-candidate/f11a_console_dispatch.c",
        TRACE / "native-f11a-393990-candidate/module.ld",
        TRACE / "native-f11a-393990-candidate/export_strict_manifest.py",
        TRACE / "native-f11a-393990-candidate/capture_inputs.py",
        TRACE / "native-f11a-393990-candidate/build_candidate.sh",
        TRACE / "native-ck802-candidate/check-inputs.py",
        TRACE / "native-ck802-candidate/sdk-profile/output/sparse-source-hunks.json",
        LAB / "output/accepted-vad-inputs.json",
        LAYOUT / "no-growth.ld",
        LAYOUT / "REPORT.md",
        LAB / "router-only.ld",
        LAB / "capture_inputs.py",
        LAB / "export_strict_manifest.py",
        LAB / "build_router_only.sh",
    ]
    extra_pins = {str(path.relative_to(REPO)): pin(path) for path in extras}

    record = {
        "schema": "h1e-vad-router-only-393990-input-pins-v1",
        "status": "offline_router_only_candidate_inputs_pinned",
        "current_system_sha256": EXPECTED[SYS],
        "accepted_source_pin_count": len(accepted_source_pins),
        "accepted_source_pins": accepted_source_pins,
        "expected_artifacts": expected_artifacts,
        "additional_inputs": extra_pins,
        "router_tail": {
            "candidate_start": "0x01128a40",
            "candidate_end_exclusive": "0x01129000",
            "candidate_bytes": 1472,
            "preimage_sha256": "d681b2309c3b48684ac24e27fafa6f215a294dc75bcbbf5fbfb4bbaacaed0e07",
            "ownership_accepted": False,
        },
        "console_tail_used": False,
        "firmware_image_generated": False,
        "composed": False,
        "installed": False,
    }
    output = Path(sys.argv[1])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"output": str(output), "accepted_sources": len(accepted_source_pins), "pinned_system": EXPECTED[SYS]}))


if __name__ == "__main__":
    main()
