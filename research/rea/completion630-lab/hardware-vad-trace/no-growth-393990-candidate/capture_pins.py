"""Pin the exact offline inputs used by the NO-GROWTH CK802 candidate."""
import hashlib
import json
import sys
from pathlib import Path


LAB = Path(__file__).resolve().parent
TRACE = LAB.parent
REPO = LAB.parents[4]
OUT = LAB / "output"
VAD = TRACE / "native-f11a-393990-candidate" / "output"
CAPTURE = REPO / "research/rea/completion630-lab/firmware/capture-vector-selected-diagnostic"
SYS = CAPTURE / "out-NOTINSTALL/container-compose3/system-decoded.bin"
CONSOLE = CAPTURE / "out-NOTINSTALL/run2/native"
ROUTER = REPO / "research/rea/hardening630-lab/fixed-router"
RESTORE4 = REPO / "research/rea/completion630-lab/firmware/restore-build393988/generation-restore4"

EXPECTED = {
    "current_system": "abff684071be35f29286010c13e27f8af51de364efbaedffdd12bb6e85ebd360",
    "current_console_elf": "105ddea56a8879e40cd0a0fa570203edae3eb4b22dbccd4da870acda8a1fa8ee",
    "current_console_bin": "9c9886db930ed54a51574d8b278d01b9359a07a99ab5e63407ed649d2acc09a2",
    "router_elf": "f102c7703ce3f75e1f327bafb756367d5148fc0fa676f7f0391d26d56cc7bd3a",
    "router_bin": "d518f0e40749eb73cf2dc9cdf3c0bb3efb3cf2b111115971a03f01cc0e547487",
    "f11a_elf": "8cdf67a3d019a206296207817ab55f18477e88ea96fcf611d10fa7a563b744e8",
    "source_hunks": "a0568b6555111d272786ace658a41835291cb4d4bae10db37dcab4bc1539d01c",
}

OBJECTS = [
    "vadt_core.o",
    "vadt_binding.o",
    "vadt_csky_guard.o",
    "vadt_frame.o",
    "vadt_frame_target.o",
    "h1e_vad_native_poll.o",
    "h1e_vad_native_loader.o",
    "f11a_console_dispatch.o",
    "console-hooks.o",
    "constructor.o",
    "poll-hook.o",
]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def pin(name: str, path: Path, expected: str | None = None) -> dict:
    data = path.read_bytes()
    digest = sha(data)
    if expected is not None:
        assert digest == expected, f"{name} hash drift: {digest} != {expected}"
    return {"path": str(path.relative_to(REPO)), "bytes": len(data), "sha256": digest}


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: capture_pins.py OUTPUT.json")

    vad_receipt = json.loads((VAD / "link-receipt.json").read_text())
    accepted = json.loads((VAD / "accepted-vad-inputs.json").read_text())
    pins = {
        "current_system": pin("current_system", SYS, EXPECTED["current_system"]),
        "current_console_elf": pin("current_console_elf", CONSOLE / "native630.elf", EXPECTED["current_console_elf"]),
        "current_console_bin": pin("current_console_bin", CONSOLE / "native630.bin", EXPECTED["current_console_bin"]),
        "current_console_symbols": pin("current_console_symbols", CONSOLE / "symbols.txt"),
        "router_elf": pin("router_elf", ROUTER / "router630.elf", EXPECTED["router_elf"]),
        "router_bin": pin("router_bin", ROUTER / "router630.bin", EXPECTED["router_bin"]),
        "router_linker_script": pin("router_linker_script", ROUTER / "module.ld"),
        "router_dependencies": pin("router_dependencies", ROUTER / "dependencies.ld"),
        "console_reservation_linker_script": pin("console_reservation_linker_script", RESTORE4 / "module.ld"),
        "source_hunk_manifest": pin("source_hunk_manifest", VAD / "sparse-source-hunks-393990.json", EXPECTED["source_hunks"]),
        "f11a_elf": pin("f11a_elf", VAD / "f11a-393990-ck802-sdk-NOTINSTALL.elf", EXPECTED["f11a_elf"]),
        "f11a_link_receipt": pin("f11a_link_receipt", VAD / "link-receipt.json"),
        "accepted_vad_inputs": pin("accepted_vad_inputs", VAD / "accepted-vad-inputs.json"),
        "objects": {},
        "accepted_source_pins": {},
    }

    for name in OBJECTS:
        expected = vad_receipt["files"][name]
        pins["objects"][name] = pin(name, VAD / name, expected)

    # Re-hash the upstream source pins that justified the reused SDK objects.
    for relative, expected in sorted(accepted["hashes"].items()):
        raw_path = Path(relative.replace("\\", "/"))
        path = raw_path if raw_path.is_absolute() else REPO / raw_path
        pins["accepted_source_pins"][relative] = pin(relative, path, expected)

    payload = {
        "schema": "h1e-vad-no-growth-393990-input-pins-v1",
        "status": "offline_candidate_inputs_only",
        "current_system_bytes": len(SYS.read_bytes()),
        "current_system_load_base": "0x01000000",
    "candidate_elf_address": "0x01128a40 and 0x0112be00 (proposed suballocations)",
        "firmware_image_generated": False,
        "installed": False,
        "pins": pins,
    }
    target = Path(sys.argv[1])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2) + "\n")
    print(json.dumps({"output": str(target), "objects": len(OBJECTS), "source_pins": len(pins["accepted_source_pins"])}))


if __name__ == "__main__":
    main()
