from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[6]
IMAGE = ROOT / "research/rea/h1e-6.3.0-verified/zephyr-decoded.bin"
PROBE = Path(__file__).with_name("csky-control-register-probe-all.bin")
OUT = Path(__file__).with_name("opcode-scan-summary.json")
LOAD_BASE = 0x01000000
EXPECTED_SHA256 = "5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce"
RAM_SRC_START = 0x01115290
RAM_SRC_END = 0x011174F7  # exclusive; 0x2267 bytes copied to 0x80000


def read_sig(raw: bytes, offset: int) -> bytes:
    return raw[offset : offset + 4]


def main() -> None:
    image = IMAGE.read_bytes()
    sha = hashlib.sha256(image).hexdigest()
    if sha != EXPECTED_SHA256:
        raise SystemExit(f"unexpected image SHA-256: {sha}")
    probe = PROBE.read_bytes()
    patterns: dict[str, set[bytes]] = {
        "mfcr psr": {read_sig(probe, r * 12) for r in range(16)},
        "mfcr epsr": {read_sig(probe, r * 12 + 4) for r in range(16)},
        "mfcr epc": {read_sig(probe, r * 12 + 8) for r in range(16)},
        "psrclr ie": {read_sig(probe, 0xC0)},
        "mtcr psr": {read_sig(probe, 0xC4 + r * 12) for r in range(16)},
        "mtcr epsr": {read_sig(probe, 0xC8 + r * 12) for r in range(16)},
        "mtcr epc": {read_sig(probe, 0xCC + r * 12) for r in range(16)},
        "rte": {read_sig(probe, 0x184)},
    }
    src_lo = RAM_SRC_START - LOAD_BASE
    src_hi = RAM_SRC_END - LOAD_BASE
    regions = {
        "whole_image": (0, len(image), LOAD_BASE),
        "ram_init_source": (src_lo, src_hi, RAM_SRC_START),
    }
    hits: dict[str, list[dict[str, object]]] = {}
    for region, (start, end, base) in regions.items():
        region_data = image[start:end]
        for name, sigs in patterns.items():
            found = []
            for offset in range(0, len(region_data) - 3, 2):
                word = region_data[offset : offset + 4]
                if word in sigs:
                    found.append({
                        "address": f"0x{base + offset:08x}",
                        "bytes": word.hex(" "),
                    })
            hits[f"{region}:{name}"] = found
    result = {
        "image": str(IMAGE.relative_to(ROOT)).replace("\\", "/"),
        "imageBytes": len(image),
        "imageSha256": sha,
        "probeBinary": str(PROBE.name),
        "probeSha256": hashlib.sha256(probe).hexdigest(),
        "instructionSet": "C-SKY ABI-v2 CK802 assembled with retained csky-20210423 toolchain; see csky-control-register-probe-all.dis",
        "mappedRamInitializer": {
            "sourceStart": f"0x{RAM_SRC_START:08x}",
            "sourceEndExclusive": f"0x{RAM_SRC_END:08x}",
            "sourceBytes": src_hi - src_lo,
            "destinationStart": "0x00080000",
            "destinationEndExclusive": f"0x{0x80000 + (src_hi - src_lo):08x}",
        },
        "matches": hits,
    }
    OUT.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    for name, found in hits.items():
        print(f"{name}: {len(found)}")
        for row in found:
            print(f"  {row['address']}  {row['bytes']}")
    print(f"written {OUT}")


if __name__ == "__main__":
    main()
