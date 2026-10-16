import json
import pathlib
import sys

receipt_path, expected_image, expected_elf = sys.argv[1:]
receipt = json.loads(pathlib.Path(receipt_path).read_text(encoding="utf-8"))
if receipt.get("image_sha256") != expected_image:
    raise SystemExit("receipt image SHA mismatch")
if receipt.get("elf_sha256") != expected_elf:
    raise SystemExit("receipt ELF SHA mismatch")
cases = receipt.get("cases")
if not isinstance(cases, list) or not cases:
    raise SystemExit("receipt has no exact-instruction cases")
failed = [c for c in cases if c.get("status") != "passed"]
if failed:
    print(json.dumps({"status": "failed", "failed_cases": failed}, indent=2))
    raise SystemExit(1)
if receipt.get("status") != "passed_exact_image_instruction_fixtures":
    raise SystemExit("receipt does not claim the expected bounded execution status")
print(json.dumps({"status": receipt["status"], "case_count": len(cases), "image_sha256": expected_image, "elf_sha256": expected_elf}, sort_keys=True))
