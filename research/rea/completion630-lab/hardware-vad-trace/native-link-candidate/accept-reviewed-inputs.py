"""Coordinator action after source review; no hardware or release acceptance."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--conditional-source-review-accepted", action="store_true")
args = parser.parse_args()
if not args.conditional_source_review_accepted:
    parser.error("Coordinator must inspect the finalized source review first")
lab = Path(__file__).resolve().parent
vad = lab.parent
repo = vad.parents[3]
frozen = repo / "research/rea/completion630-lab/firmware/restore-build393988/generation-restore4"
paths = [frozen / n for n in ("system-decoded-NOTINSTALL.bin", "symbols.txt", "module.ld", "console-hooks.S")]
for folder in ("fresh-sample-candidate", "native-frame-candidate", "native-poll-candidate", "native-dispatch-candidate", "native-loader-candidate"):
    paths.extend(sorted((vad / folder).glob("*.c")))
    paths.extend(sorted((vad / folder).glob("*.h")))
paths += [vad / "lifecycle-followup/late-publication/late-publication.s", lab / "module.ld", lab / "poll-hook.S", lab / "build-offline.sh"]
paths += [vad / "native-dispatch-candidate/REPORT.md", vad / "native-loader-candidate/REPORT.md", vad / "combined-source-review/native-glue-review.md"]
hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
assert hashes[str(paths[0])] == "b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f"
manifest = {
    "status": "conditional_source_only_not_target_qualified",
    "accepted_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "hardware_qualified": False,
    "release_approved": False,
    "hashes": hashes,
}
target = lab / "accepted-inputs.json"
target.write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"manifest": str(target), "inputs": len(hashes), "status": manifest["status"]}))
