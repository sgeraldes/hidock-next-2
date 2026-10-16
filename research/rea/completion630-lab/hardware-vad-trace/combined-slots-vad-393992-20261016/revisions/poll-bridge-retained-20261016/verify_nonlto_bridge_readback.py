#!/usr/bin/env python3
"""Independent readback for the one-off CK802 non-LTO poll bridge link."""
from __future__ import annotations

import hashlib
import json
import re
import struct
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TRACE = ROOT.parent
OUT = HERE / "link" / "output-nonlto-bridge"
SOURCE = TRACE / "native-poll-candidate" / "h1e_vad_native_poll.c"
ELF = OUT / "vad-router-only-slots-393992-nonlto-poll-bridge-NOTINSTALL.elf"
MODULE = OUT / "module-vad-router-tail.bin"
MAP = OUT / "router-only-nonlto-poll-bridge.map"
OBJDUMP = OUT / "objdump.txt"
SIZED = OUT / "sized-symbols.txt"
SIZE = OUT / "size.txt"
UNDEFINED = OUT / "undefined.txt"
RECEIPT = OUT / "bridge-readback.json"


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def main() -> None:
    assert not RECEIPT.exists(), f"refusing to overwrite {RECEIPT}"
    assert sha(SOURCE.read_bytes()) == "454d10055a2b1f24a78a639188e76ce74f1b2c5f842223fa545d831c807851f0"
    assert sha((ROOT / "inputs" / "accepted-vad-inputs.json").read_bytes()) == "24c97109ea79776cb7b1045acbf78865b528f78b493208840692693555051c70"
    assert sha((ROOT / "inputs" / "input-pins-before.json").read_bytes()) == "2278b2177e9efb59f650757c99bda285431519093c1a5f578ca2375802695f81"
    assert ((ROOT / "inputs" / "input-pins-before.json").read_bytes() ==
            (ROOT / "inputs" / "input-pins-after.json").read_bytes())

    elf = ELF.read_bytes()
    module = MODULE.read_bytes()
    map_text = MAP.read_text(errors="replace")
    dis = OBJDUMP.read_text(errors="replace")
    sized_lines = [line.split() for line in SIZED.read_text().splitlines()]
    row = next(row for row in sized_lines if row and row[-1] == "h1e_vad_native_poll_bridge")
    address, size = int(row[0], 16), int(row[1], 16)
    assert address == 0x01128E34 and size == 0x18
    assert len(module) == 1248 and len(module) <= 1472
    assert not UNDEFINED.read_bytes().strip()
    size_fields = SIZE.read_text().splitlines()[1].split()
    assert tuple(map(int, size_fields[:3])) == (1400, 0, 0)
    assert re.search(r'Tag_CSKY_CPU_NAME:\s+"ck802"', (OUT / "sections.txt").read_text())

    assert re.search(r"(?m)^\s*\.router_tail\s+0x0*1128a40\s+0x0*4e0\b", map_text), "router output section/base/size changed"
    section_marker = " .text.h1e_vad_native_poll_bridge\n"
    pos = map_text.index(section_marker) + len(section_marker)
    section_row = map_text[pos:].splitlines()[0].split()
    assert int(section_row[0], 16) == address and int(section_row[1], 16) == size

    bridge = re.search(rf"(?mi)^{address:08x} <h1e_vad_native_poll_bridge>:\s*\n((?:\s+[^\n]+\n)+)", dis)
    assert bridge
    body = bridge.group(1)
    assert re.search(r"(?m)^\s*1128e34:\s+\S+\s+push\s+r15", body)
    assert re.search(r"(?m)^\s*1128e3c:\s+\S+\s+bsr\s+0x1128dba\s+// 1128dba <vadt_binding_poll>", body)
    assert re.search(r"(?m)^\s*1128e40:\s+\S+\s+pop\s+r15", body)
    hook = re.search(r"(?mi)^\s*1020b62:\s+\S+\s+bsr\s+0x([0-9a-f]+)", dis)
    assert hook and int(hook.group(1), 16) == address
    for token in ("vadt_binding_poll", "vadt_csky_guard_enter", "vadt_csky_guard_exit", "h1e_vad_load_object"):
        assert token in map_text and token in dis, f"poll path lacks {token}"
    assert re.search(r"1128b4c:\s+\S+\s+bsr\s+0x1128aa2.*vadt_csky_guard_enter", dis)
    assert re.search(r"1128b5a:\s+\S+\s+bsr\s+0x1128a68.*h1e_vad_load_object", dis)
    assert re.search(r"1128bb8:\s+\S+\s+bsr\s+0x1128a9c.*vadt_csky_guard_exit", dis)

    # Confirm ops-table callback pointers in the exact linked module bytes.
    table_address = 0x01128EF4
    table_off = table_address - 0x01128A40
    table = struct.unpack_from("<4I", module, table_off)
    assert table == (0, 0x01128AA2, 0x01128A9C, 0x01128A68), tuple(hex(x) for x in table)

    receipt = {
        "schema": "h1e-vad-393992-nonlto-poll-bridge-readback-v1",
        "status": "offline_linked_poll_bridge_body_verified_NOTINSTALL",
        "source": {"path": str(SOURCE), "sha256": sha(SOURCE.read_bytes())},
        "elf": {"path": str(ELF), "sha256": sha(elf), "bytes": len(elf)},
        "router_tail": {"address": "0x01128a40", "bytes": len(module), "sha256": sha(module),
                        "capacity": 1472, "remaining": 1472 - len(module)},
        "poll_bridge": {"address": f"0x{address:08x}", "size": size,
                        "linked_map_size_matches_symbol": True,
                        "first_path": "push r15; mov r2,r0; load getter/table; bsr vadt_binding_poll; pop r15",
                        "binding_poll": "0x01128dba", "binding_poll_size": 0x78,
                        "reachable_bkpt": False, "post_return_alignment_bkpt": "0x01128e42"},
        "poll_hook": {"address": "0x01020b62", "decoded_linked_bsr_target": f"0x{address:08x}",
                      "target_matches_bridge": True},
        "ops_table": {"address": f"0x{table_address:08x}",
                      "words": [f"0x{x:08x}" for x in table],
                      "callbacks": {"guard_enter": "0x01128aa2", "guard_exit": "0x01128a9c",
                                    "loader": "0x01128a68"}},
        "elf_size": {"text": 1400, "data": 0, "bss": 0, "undefined_symbols": 0},
        "verification_scope": "Static ELF/map/disassembly/readback only; no composed SYS, container, hardware, install, or release qualification.",
    }
    RECEIPT.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
