"""Focused real-filesystem checks for build_candidate's no-clobber publisher."""
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
BUILDER = HERE / "build_candidate.py"
spec = importlib.util.spec_from_file_location("build_candidate", BUILDER)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def main():
    checks = {}
    with tempfile.TemporaryDirectory(prefix=".publication-check-", dir=HERE) as temporary:
        root = Path(temporary)
        same_device_as_output = root.stat().st_dev == builder.OUT.stat().st_dev
        assert same_device_as_output, "temporary directory is not on the output filesystem"

        source = root / "success.partial"
        destination = root / "success.bin"
        payload = b"candidate bytes\x00\xff"
        source.write_bytes(payload)
        builder.publish_no_clobber(source, destination)
        assert destination.read_bytes() == payload
        assert not source.exists()
        checks["success"] = {"destination_bytes": len(payload), "partial_removed": True}

        for label, destination_name in (
            ("final_collision", "candidate-NOTINSTALL.bin"),
            ("rejected_collision", "candidate-NOTINSTALL.bin.REJECTED"),
        ):
            source = root / f"{label}.partial"
            destination = root / destination_name
            existing = f"pre-existing {label}".encode()
            owned = f"owned partial {label}".encode()
            source.write_bytes(owned)
            assert not destination.exists()
            destination.write_bytes(existing)  # Simulate another creator after the old absence check.
            try:
                builder.publish_no_clobber(source, destination)
            except FileExistsError:
                pass
            else:
                raise AssertionError(f"publisher accepted existing destination: {destination}")
            assert destination.read_bytes() == existing
            assert source.read_bytes() == owned
            checks[label] = {
                "collision_rejected": True,
                "existing_destination_bytes_preserved": len(existing),
                "partial_bytes_preserved": len(owned),
            }

    print(json.dumps({"status": "PASS", "filesystem": os.name,
                      "same_device_as_output": same_device_as_output, "checks": checks}, sort_keys=True))


if __name__ == "__main__":
    main()
