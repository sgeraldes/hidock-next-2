"""Hash the accepted conditional-source inputs and compare them to accepted-inputs.json.

Read-only on every input. Writes only the JSON path given as the last argument.
Exit 0: all hashes match the acceptance manifest. Exit 3: at least one differs
(the differences are printed and stored in the output). The path list is the one
build-offline.sh in native-link-candidate hashes, so the two recipes pin the
same files.
"""
import hashlib
import json
import pathlib
import sys

frozen, vad, link_lab, out = map(pathlib.Path, sys.argv[1:5])
frozen_bin = frozen / "system-decoded-NOTINSTALL.bin"
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(frozen_bin) == "b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f", "frozen 393988 decoded image changed"
expected = {"upload630_parse": "0112c2c4", "upload630_response": "0112ca1c",
            "restore630_parse": "0112d7d8", "restore630_response": "0112e162"}
symbols = {s[2]: s[0] for line in (frozen / "symbols.txt").read_text().splitlines() if len(s := line.split()) == 3}
assert all(symbols[k] == v for k, v in expected.items()), "imported upload/restore symbol addresses changed"

paths = [frozen_bin, frozen / "symbols.txt", frozen / "module.ld", frozen / "console-hooks.S"]
for folder in ["fresh-sample-candidate", "native-frame-candidate", "native-poll-candidate",
               "native-dispatch-candidate", "native-loader-candidate"]:
    paths.extend(sorted((vad / folder).glob("*.c")))
    paths.extend(sorted((vad / folder).glob("*.h")))
paths += [vad / "lifecycle-followup/late-publication/late-publication.s",
          link_lab / "module.ld", link_lab / "poll-hook.S", link_lab / "build-offline.sh"]
paths += [vad / "native-dispatch-candidate/REPORT.md", vad / "native-loader-candidate/REPORT.md",
          vad / "combined-source-review/native-glue-review.md"]
actual = {str(p): sha(p) for p in paths}
accepted = json.loads((link_lab / "accepted-inputs.json").read_text())["hashes"]

changed = sorted(k for k in actual if k in accepted and accepted[k] != actual[k])
added = sorted(k for k in actual if k not in accepted)
missing = sorted(k for k in accepted if k not in actual)
result = {"match": not (changed or added or missing), "pinned_count": len(actual),
          "changed": {k: {"accepted": accepted[k], "now": actual[k]} for k in changed},
          "not_in_acceptance": added, "in_acceptance_but_not_hashed": missing, "hashes": actual}
out.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({k: v for k, v in result.items() if k != "hashes"}, indent=2))
sys.exit(0 if result["match"] else 3)
