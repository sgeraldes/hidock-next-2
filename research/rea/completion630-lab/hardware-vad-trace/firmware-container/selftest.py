#!/usr/bin/env python3
"""Synthetic code-path test for package_vad_container.py. Not candidate evidence.

Mutates 8 bytes of the baseline system inside a scratch directory, builds a fake integration
manifest there, and checks that the packer accepts it and rejects tampered variants.
Usage: python -I selftest.py <new-empty-scratch-dir>
"""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('pvc', HERE / 'package_vad_container.py')
pvc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pvc)

scratch = Path(sys.argv[1]).resolve()
scratch.mkdir(parents=True, exist_ok=False)
base = pvc.BASE_SYSTEM_FILE.read_bytes()
OFF, NEW = 0x1000, bytes(range(8))
cand = bytearray(base)
cand[OFF:OFF + 8] = NEW
cand = bytes(cand)
sha = lambda b: hashlib.sha256(b).hexdigest()
(scratch / 'candidate.bin').write_bytes(cand)


def manifest(name, **over):
    m = {'schema': pvc.SCHEMA, 'accepted': True, 'installable': False, 'baseline_system_sha256': pvc.BASE_SYSTEM_SHA,
         'candidate_system': {'path': 'candidate.bin', 'sha256': sha(cand), 'bytes': len(cand)},
         'readback': {'verified': True, 'candidate_sha256': sha(cand)},
         'changes': [{'offset': OFF, 'length': 8, 'new_sha256': sha(NEW)}]}
    m.update(over)
    path = scratch / name
    path.write_text(json.dumps(m))
    return path


def run(mf, pin, out):
    return pvc.main(['--mode', 'candidate', '--candidate-manifest', str(mf), '--expect-candidate-sha256', pin,
                     '--integration-root', str(scratch), '--out-root', str(scratch / out)])


assert run(manifest('ok.json'), sha(cand), 'out-ok') == 0, 'valid synthetic candidate rejected'
receipt = json.loads(next((scratch / 'out-ok').glob('*/receipt.json')).read_text())
changed = [p['name'] for p in receipt['readback']['partitions'] if p['relation'] != 'byte-identical-to-baseline']
assert changed == ['ota.xml', 'zephyr.bin'], changed
fields = receipt['readback']['ota_xml_changed_fields']
assert len(fields) == 1 and fields[0].endswith('/partition[zephyr.bin]/checksum'), fields
assert receipt['flags']['NOTINSTALL'] and not receipt['flags']['installable']

assert run(manifest('pin.json'), '0' * 64, 'out-pin') == 2, 'wrong external pin accepted'
assert run(manifest('range.json', changes=[{'offset': OFF + 1, 'length': 7, 'new_sha256': sha(NEW[1:])}]), sha(cand), 'out-range') == 2, 'change outside allowlist accepted'
assert run(manifest('acc.json', accepted=False), sha(cand), 'out-acc') == 2, 'unaccepted manifest accepted'
assert run(manifest('inst.json', installable=True), sha(cand), 'out-inst') == 2, 'installable claim accepted'
assert run(manifest('rb.json', readback={'verified': True, 'candidate_sha256': '0' * 64}), sha(cand), 'out-rb') == 2, 'readback mismatch accepted'
print('selftest ok: 1 positive, 5 fail-closed negatives')
