import json
import pathlib
import sys

receipt_path, config_path = sys.argv[1:]
receipt = json.loads(pathlib.Path(receipt_path).read_text(encoding="utf-8"))
config = json.loads(pathlib.Path(config_path).read_text(encoding="utf-8"))

def fail(message):
    raise SystemExit(message)

if receipt.get("image_sha256") != config.get("image_sha256"):
    fail("receipt candidate SYS SHA mismatch")
if receipt.get("image_bytes") != 1237504 or config.get("image_bytes") != 1237504:
    fail("candidate SYS byte count mismatch")
if receipt.get("image_import_verified") is not True:
    fail("exact imported Ghidra memory was not verified byte-for-byte")
if receipt.get("candidate_elf_sha256") is not None or config.get("candidate_elf_sha256") is not None:
    fail("receipt must not claim an ELF identity for the 393993 candidate SYS")
if receipt.get("reference_artifacts") != config.get("reference_artifacts"):
    fail("receipt reference artifact pins differ from pre-run config")
reference = receipt.get("reference_artifacts", {})
if reference.get("elf_sha256") != "50d0a27d79ccc7813a0a5150a5e6ed00d77171a4c3c3f8f7aa4566bc4d734a80":
    fail("symbol-reference ELF pin mismatch")
if reference.get("symbols_sha256") != "7222b982ab20c07f5aa270fa530128eed77e587cbab42be6820f30869a5a59a8":
    fail("symbol-reference symbols pin mismatch")
if reference.get("layout_sha256") != "5fd4795ac690fff59b09e5000bdaa601a974e34b27016baa9081b6f9c99424b1":
    fail("symbol-reference layout pin mismatch")

expected_ids = [
    "f11a-absent-snapshot-response",
    "f11a-present-snapshot-response",
    "poll-bridge-success",
    "poll-bridge-failure",
]
cases = receipt.get("cases")
if not isinstance(cases, list) or [c.get("id") for c in cases] != expected_ids:
    fail(f"expected exactly the four reviewed cases in order; got {[c.get('id') for c in cases or []]}")
failed = [case for case in cases if case.get("status") != "passed"]
if failed:
    print(json.dumps({"status": "failed", "failed_cases": failed}, indent=2))
    raise SystemExit(1)

absent = cases[0].get("actual", {})
if absent.get("return") != 32 or absent.get("getter_calls") != 0:
    fail("F11A absent case actual differs from contract")
if absent.get("reply_hex") != "0201000000000000000000000000000000000000000000000000000000000000":
    fail("F11A absent response bytes mismatch")

present = cases[1].get("actual", {})
if present.get("return") != 32 or present.get("getter_calls") != 0:
    fail("F11A present case actual differs from contract")
if present.get("reply_hex") != "0001010100000005000000040000000087654321000000000000000000000008":
    fail("F11A present response bytes mismatch")

for case, result, word, tail in (
    (cases[2], 0, 0x87654321, [2, 1, 1, 0, 0x87654321, 0, 0, 1]),
    (cases[3], -5, 0, [2, 1, 0, 0xfffffffb, 0, 0, 0, 0]),
):
    actual = case.get("actual", {})
    if actual.get("return") != result or actual.get("poll_bridge_hits") != 1 or actual.get("getter_calls") != 1:
        fail(f"{case['id']} return/bridge/getter count mismatch")
    if actual.get("getter_output_pointers") != ["0x0038e100"]:
        fail(f"{case['id']} getter r0 pointer mismatch")
    got_tail = actual.get("tail_words_le32")
    if got_tail != tail:
        fail(f"{case['id']} telemetry tail mismatch: expected {tail}, got {got_tail}")

if receipt.get("status") != "passed_exact_image_instruction_fixtures":
    fail(f"receipt status is not a pass: {receipt.get('status')}")
print(json.dumps({
    "status": receipt["status"],
    "case_count": len(cases),
    "image_sha256": receipt["image_sha256"],
    "image_bytes": receipt["image_bytes"],
    "candidate_elf_sha256": None,
    "reference_elf_sha256": reference["elf_sha256"],
}, sort_keys=True))
