#!/usr/bin/env python3
"""Offline H1E container packer: replaces only zephyr.bin (+ its ota.xml size/CRC).

EXPERIMENTAL-NOTINSTALL. Same identity (6.3.4_restore001 / 393988) as the baseline, so the
output is a structural candidate, never an update approved for installation.

Modes:
  baseline-roundtrip  repack the unchanged baseline system; must reproduce the baseline container.
  candidate           repack the decoded VAD candidate from a firmware-integration manifest.

Every run writes into a fresh output directory and derives its receipt only from the artifact it
re-reads from disk after the SDK builder exits. Nothing from earlier runs is read.
"""
import argparse
import datetime
import hashlib
import json
import re
import struct
import subprocess
import sys
import tempfile
import types
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
LAB = HERE.parents[1]
REA = HERE.parents[2]

SEED = 0x08000050
VERSION_NAME = '6.3.4_restore001'
VERSION_CODE = 393988
SCHEMA = 'h1e-vad-candidate-manifest-v1'
SYSTEM_HEADER_SIZE = 48

PINS = {
    'sdk': ('references/build_atf_image.py', '30b5d37f67bb57af44d02da829429c59bb734d5c7c0acc1a1ce5f15029401c17'),
    'decoder': ('decode_randomizer.py', '3a9a945dafe6a81327d9f15e0619befc30109fd9e8ce58e2af8e7d5e7e734de5'),
    'parser': ('extract_acttest.py', '8adf114c2ee531f12778b346482c344717659a130892515258505781efccc592'),
}
BASE_DIR = LAB / 'firmware/restore-build393988/candidate-393988-restore3'
BASE_CONTAINER = BASE_DIR / 'H1E-6.3.4_restore001-EXPERIMENTAL-NOT-INSTALL-VALIDATED.bin'
BASE_SYSTEM_FILE = BASE_DIR / 'system-decoded.bin'
BASE_CONTAINER_SHA = '4942c98f9a150f09b9a31b606e7e9d985e99b16873c5ef64e6e17667808d82e8'
BASE_SYSTEM_SHA = 'b338e4d5e7d456dd2b7a0048bb8e2c338e2464ad25029267b5e46cb4ad880c2f'
BASE_BOOT_SHA = '78dee3943ad56561cb89d66c56e476f234ee3681b223f8e7e45e3d30badb41f6'
BASE_ZEPHYR_ENC_SHA = 'b8d55ca24d1926c6a0a95a89e8316f7f98a4137100635bd202d2139ad54b5146'
UNTOUCHED = ('mbrec.bin', 'RomeApp.bin', 'UAC.bin', 'IG1202dl.bin', 'sdfs.bin')

ZEPHYR_XML = re.compile(rb'(<file_name>zephyr\.bin</file_name>\s*<file_size>)[^<]+(</file_size>\s*<checksum>)[^<]+(</checksum>)')

REMAINING_GATES = [
    'layout: zephyr.bin size/flash-partition fit and relocation of the following partitions are not qualified',
    'lifetime: VAD runtime ownership, task/stack lifetime, CK802 bridge and unload/teardown behavior are not qualified',
    'hardware: no physical boot, microphone stream, power or thermal qualification on a device',
    'recovery: ROM unbrick/recovery path is not verified',
    'installer: same version identity, so installer acceptance and downgrade/equal-version policy are untested',
    'source: not a full vendor source rebuild',
]


class PackError(Exception):
    pass


def need(cond, msg):
    if not cond:
        raise PackError(msg)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load_pinned(key):
    rel, digest = PINS[key]
    path = REA / rel
    src = path.read_bytes()
    need(sha(src) == digest, f'{rel}: pinned hash mismatch')
    module = types.ModuleType(path.stem)
    module.__file__ = str(path)
    exec(compile(src, str(path), 'exec'), module.__dict__)
    return module, src


def load_candidate(manifest_path, integration_root, expect_sha, allow_growth, base_system, decoder):
    manifest_path = manifest_path.resolve()
    root = integration_root.resolve()
    need(manifest_path.is_file() and manifest_path.is_relative_to(root), 'candidate manifest must be a file inside the integration root')
    manifest_bytes = manifest_path.read_bytes()
    m = json.loads(manifest_bytes)
    need(m.get('schema') == SCHEMA, f'manifest schema must be {SCHEMA}')
    need(m.get('accepted') is True, 'manifest is not marked accepted')
    need(m.get('installable', False) is False, 'manifest claims installable')
    need(m.get('baseline_system_sha256') == BASE_SYSTEM_SHA, 'manifest baseline system hash differs from pinned baseline')
    cand = m.get('candidate_system') or {}
    path = (manifest_path.parent / cand.get('path', '')).resolve()
    need(path.is_file() and path.is_relative_to(root), 'candidate path must be a file inside the integration root')
    data = path.read_bytes()
    need(re.fullmatch(r'[0-9a-f]{64}', expect_sha or ''), '--expect-candidate-sha256 must be a lowercase sha256')
    digest = sha(data)
    need(digest == expect_sha, 'candidate hash differs from the externally supplied pin')
    need(cand.get('sha256') == digest and cand.get('bytes') == len(data), 'candidate hash/size differs from manifest claim')
    rb = m.get('readback') or {}
    need(rb.get('verified') is True and rb.get('candidate_sha256') == digest, 'manifest readback does not confirm this candidate hash')

    allowed = bytearray(len(data))
    ranges = []
    changes = m.get('changes')
    need(isinstance(changes, list) and changes, 'manifest has no allowlisted changes')
    for c in changes:
        off, length = c.get('offset'), c.get('length')
        need(isinstance(off, int) and isinstance(length, int) and off >= 0 and length > 0 and off + length <= len(data), 'change range out of bounds')
        need(sha(data[off:off + length]) == c.get('new_sha256'), f'change @{off:#x} hash differs from candidate bytes')
        ranges.append((off, off + length))
    ranges.sort()
    for (a0, a1), (b0, b1) in zip(ranges, ranges[1:]):
        need(a1 <= b0, 'allowlisted change ranges overlap')
    for a, b in ranges:
        allowed[a:b] = b'\x01' * (b - a)

    need(len(data) >= len(base_system), 'candidate shorter than baseline system')
    if len(data) != len(base_system):
        need(allow_growth, 'candidate grows the system image; pass --allow-growth to accept layout risk')
        need(all(allowed[len(base_system):]), 'appended bytes are not fully covered by allowlisted changes')
    need(data[:SYSTEM_HEADER_SIZE] == base_system[:SYSTEM_HEADER_SIZE], 'system inner header changed')
    diff = [i for i, (x, y) in enumerate(zip(base_system, data)) if x != y]
    need(all(allowed[i] for i in diff), 'candidate differs from baseline outside the allowlisted changes')
    need(diff or len(data) > len(base_system), 'candidate is identical to baseline; use baseline-roundtrip mode')
    need(decoder.image_header(data, True) == decoder.image_header(base_system, True), 'system inner header parse differs from baseline')
    info = {
        'manifest_sha256': sha(manifest_bytes),
        'changed_bytes_in_baseline_span': len(diff),
        'appended_bytes': len(data) - len(base_system),
        'allowlisted_ranges': [{'offset': a, 'length': b - a} for a, b in ranges],
    }
    return data, info


def raw_parse(data):
    """Independent ACTTEST0 structure check mirroring the SDK builder's layout rules."""
    need(data[:8] == b'ACTTEST0', 'container magic')
    header_crc, count = struct.unpack_from('<IB', data, 8)
    version, total, data_crc = struct.unpack_from('<III', data, 16)
    need(data[13:16] == bytes(3) and data[28:32] == bytes(4), 'container reserved bytes')
    need(version == 0x01000000 and total == len(data) and 1 <= count <= 15, 'container header fields')
    need(zlib.crc32(data[12:512]) == header_crc, 'outer header CRC')
    need(zlib.crc32(data[512:]) == data_crc, 'outer data CRC')
    need(data[32 + 32 * count:512] == bytes(512 - 32 - 32 * count), 'directory padding not zero')
    entries, cursor = [], 512
    for i in range(count):
        name, load, offset, size, run, crc = struct.unpack_from('<12sIIIII', data, 32 + 32 * i)
        label = name.rstrip(b'\0')
        need(name == label.ljust(12, b'\0') and re.fullmatch(rb'[A-Za-z0-9_.-]+', label), 'entry name')
        need(offset == cursor and size > 0 and offset + size <= len(data), f'{label!r}: offset/size')
        payload = data[offset:offset + size]
        need(zlib.crc32(payload) == crc, f'{label!r}: payload CRC')
        end = offset + size + 512 - size % 512
        need(data[offset + size:end] == b'\xff' * (end - offset - size), f'{label!r}: pad not 0xff')
        entries.append({'name': label.decode(), 'load': load, 'run': run, 'offset': offset, 'size': size, 'crc': crc})
        cursor = end
    need(cursor == len(data), 'container has trailing bytes')
    return entries


def xml_fields(el, path=''):
    tag = el.tag + (f"[{el.findtext('file_name')}]" if el.tag == 'partition' else '')
    here = f'{path}/{tag}'
    out = {here: (el.text or '').strip()} if len(el) == 0 else {}
    for child in el:
        out.update(xml_fields(child, here))
    return out


def check_boot(boot, decoder):
    need(len(boot) == 4096 and boot[0xf80:0xf84] == b'FVER', 'boot FVER block')
    need(zlib.crc32(boot[0xf80:0xffc]) == struct.unpack_from('<I', boot, 0xffc)[0], 'boot FVER CRC')
    need(struct.unpack_from('<I', boot, 0xf84)[0] == VERSION_CODE, 'boot version code changed')
    need(boot[0xf8c:0xfcc].rstrip(b'\0') == VERSION_NAME.encode(), 'boot version name changed')
    decoder.image_header(boot)
    need(sha(boot) == BASE_BOOT_SHA, 'boot hash differs from pinned baseline boot')


def pack(base_payloads, names, candidate, decoder, sdk_src, out_path):
    zephyr = decoder.transform(candidate, SEED, decrypt=False)
    xml, n = ZEPHYR_XML.subn(
        lambda m: m[1] + b'0x%x' % len(zephyr) + m[2] + b'0x%08x' % zlib.crc32(zephyr) + m[3], base_payloads['ota.xml'])
    need(n == 1, 'ota.xml zephyr entry not found exactly once')
    payloads = dict(base_payloads, **{'zephyr.bin': zephyr, 'ota.xml': xml})
    with tempfile.TemporaryDirectory(dir=out_path.parent, prefix='work-') as tmp:
        tmp = Path(tmp)
        parts = tmp / 'parts'
        parts.mkdir()
        for name in names:
            (parts / name).write_bytes(payloads[name])
        (tmp / 'empty.cfg').write_bytes(b'')
        (tmp / 'atf_builder.py').write_bytes(sdk_src)
        run = subprocess.run(
            [sys.executable, '-I', str(tmp / 'atf_builder.py'), '-cf', str(tmp / 'empty.cfg'), '-o', str(out_path),
             *[str(parts / name) for name in names]],
            capture_output=True, text=True, timeout=120, cwd=tmp)
        need(run.returncode == 0, f'SDK builder failed rc={run.returncode}: {run.stderr[-300:]}')
    return sha(run.stdout.encode())


def verify_container(path, base_raw, base_payloads, base_entries, candidate, decoder, parser):
    """Everything returned is computed from the bytes re-read from `path`."""
    data = path.read_bytes()
    entries = raw_parse(data)
    helper = parser.parse(data)
    need([(e['name'], e['offset'], e['size'], int(e['crc32'], 16)) for e in helper['entries']] ==
         [(e['name'], e['offset'], e['size'], e['crc']) for e in entries], 'independent and helper parsers disagree')
    need(helper['version'] == VERSION_NAME and helper['board'] == 'ats2835p_evb', 'XML identity changed')
    need([(e['name'], e['load'], e['run']) for e in entries] == [(e['name'], e['load'], e['run']) for e in base_entries], 'partition order/addresses changed')
    got = {e['name']: data[e['offset']:e['offset'] + e['size']] for e in entries}

    for name in UNTOUCHED:
        need(got[name] == base_payloads[name], f'{name} is not byte-identical to baseline')
    base_xml, new_xml = base_payloads['ota.xml'], got['ota.xml']
    mask = lambda x: ZEPHYR_XML.sub(lambda m: m[1] + b'@' + m[2] + b'@' + m[3], x)
    need(mask(base_xml) == mask(new_xml), 'ota.xml differs outside zephyr size/checksum')
    old_f, new_f = xml_fields(ET.fromstring(base_xml)), xml_fields(ET.fromstring(new_xml))
    changed = sorted(k for k in set(old_f) | set(new_f) if old_f.get(k) != new_f.get(k))
    need(all(k.endswith(('/partition[zephyr.bin]/file_size', '/partition[zephyr.bin]/checksum')) for k in changed), 'unexpected ota.xml field changed')

    boot = decoder.transform(got['mbrec.bin'], SEED)
    check_boot(boot, decoder)
    system = decoder.transform(got['zephyr.bin'], SEED)
    need(system == candidate, 'decoded zephyr.bin differs from candidate system')

    table = []
    for e in entries:
        base = next(b for b in base_entries if b['name'] == e['name'])
        if got[e['name']] == base_payloads[e['name']]:
            relation = 'byte-identical-to-baseline'
        else:
            relation = {'zephyr.bin': 'replaced-with-encoded-candidate', 'ota.xml': 'xml-zephyr-size-crc-only'}[e['name']]
        table.append({'name': e['name'], 'offset': e['offset'], 'size': e['size'], 'crc32': f"0x{e['crc']:08x}",
                      'sha256': sha(got[e['name']]), 'relation': relation, 'offset_moved': e['offset'] != base['offset']})
    return {
        'artifact_sha256': sha(data),
        'artifact_bytes': len(data),
        'byte_identical_to_baseline_container': data == base_raw,
        'outer_header_crc32': f'0x{struct.unpack_from("<I", data, 8)[0]:08x}',
        'outer_data_crc32': f'0x{struct.unpack_from("<I", data, 24)[0]:08x}',
        'partitions': table,
        'ota_xml_changed_fields': changed,
        'decoded_system_sha256': sha(system),
        'decoded_system_bytes': len(system),
        'boot_decoded_sha256': sha(boot),
        'checks_passed': [
            'independent ACTTEST0 parse: outer header/data CRC, per-partition CRC, offsets, 0xff padding',
            'helper parser agrees with independent parse; XML size/CRC agree with table',
            'decoded zephyr.bin from the actual container == candidate system',
            'mbrec.bin, RomeApp.bin, UAC.bin, IG1202dl.bin, sdfs.bin byte-identical to baseline',
            'boot FVER identity unchanged (6.3.4_restore001 / 393988)',
            'ota.xml differs only in zephyr.bin file_size/checksum',
        ],
    }


def build(args):
    started = datetime.datetime.now(datetime.timezone.utc)
    decoder, _ = load_pinned('decoder')
    parser, _ = load_pinned('parser')
    _, sdk_src = load_pinned('sdk')

    base_raw = BASE_CONTAINER.read_bytes()
    need(sha(base_raw) == BASE_CONTAINER_SHA, 'baseline container hash mismatch')
    base_system = BASE_SYSTEM_FILE.read_bytes()
    need(sha(base_system) == BASE_SYSTEM_SHA, 'baseline decoded system hash mismatch')

    if args.mode == 'candidate':
        need(args.candidate_manifest and args.expect_candidate_sha256, '--candidate-manifest and --expect-candidate-sha256 are required')
        candidate, cinfo = load_candidate(args.candidate_manifest, args.integration_root, args.expect_candidate_sha256, args.allow_growth, base_system, decoder)
        kind, label = 'vad-candidate-structural', 'vad-candidate'
    else:
        need(not args.candidate_manifest and not args.expect_candidate_sha256 and not args.allow_growth, 'baseline-roundtrip takes no candidate arguments')
        candidate, cinfo = base_system, {}
        kind, label = 'baseline-roundtrip-unchanged-system', 'baseline-roundtrip'

    base_table = parser.parse(base_raw)
    base_entries = raw_parse(base_raw)
    names = [e['name'] for e in base_entries]
    base_payloads = {e['name']: base_raw[e['offset']:e['offset'] + e['size']] for e in base_entries}
    need(sha(base_payloads['zephyr.bin']) == BASE_ZEPHYR_ENC_SHA, 'baseline encoded zephyr hash mismatch')
    need(sha(decoder.transform(base_payloads['zephyr.bin'], SEED)) == BASE_SYSTEM_SHA, 'baseline zephyr does not decode to pinned system')
    check_boot(decoder.transform(base_payloads['mbrec.bin'], SEED), decoder)
    need(base_table['version'] == VERSION_NAME, 'baseline version name')

    run_id = f"{label}-{started:%Y%m%dT%H%M%SZ}-{sha(candidate)[:8]}"
    run_dir = args.out_root / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    artifact = run_dir / f'H1E-{VERSION_NAME}-{label}-EXPERIMENTAL-NOTINSTALL.bin'
    sdk_stdout_sha = pack(base_payloads, names, candidate, decoder, sdk_src, artifact)

    result = verify_container(artifact, base_raw, base_payloads, base_entries, candidate, decoder, parser)
    if kind == 'baseline-roundtrip-unchanged-system':
        need(result['byte_identical_to_baseline_container'], 'roundtrip artifact differs from baseline container')
    else:
        need(not result['byte_identical_to_baseline_container'], 'candidate artifact is identical to baseline')

    receipt = {
        'run_id': run_id,
        'started_utc': started.isoformat(),
        'finished_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'status': 'structural_readback_passed_EXPERIMENTAL_NOTINSTALL',
        'evidence_kind': kind,
        'artifact': artifact.name,
        'flags': {
            'EXPERIMENTAL': True, 'NOTINSTALL': True, 'installable': False, 'approved_for_installation': False,
            'installed': False, 'physical_boot_verified': False, 'hardware_qualified': False,
            'new_version_allocated': False, 'same_identity_as_baseline': True, 'release_or_publication': False,
            'full_vendor_source_rebuild': False, 'ROM_unbrick_recovery': False,
        },
        'identity': {'version_name': VERSION_NAME, 'version_code': VERSION_CODE, 'board': 'ats2835p_evb'},
        'inputs': {
            'baseline_container_sha256': BASE_CONTAINER_SHA,
            'baseline_system_sha256': BASE_SYSTEM_SHA,
            'candidate_system_sha256': sha(candidate),
            'candidate_system_bytes': len(candidate),
            'candidate': cinfo,
            'pinned_helpers': {k: PINS[k][1] for k in PINS},
            'script_sha256': sha(Path(__file__).read_bytes()),
            'sdk_stdout_sha256': sdk_stdout_sha,
        },
        'layout_delta': {
            'zephyr_bytes_before': len(base_system), 'zephyr_bytes_after': len(candidate),
            'container_bytes_before': len(base_raw), 'container_bytes_after': result['artifact_bytes'],
        },
        'readback': result,
        'remaining_gates': REMAINING_GATES,
    }
    with (run_dir / 'receipt.json').open('x', encoding='utf-8') as f:
        json.dump(receipt, f, indent=2)
        f.write('\n')
    return run_dir, receipt


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--mode', choices=('baseline-roundtrip', 'candidate'), required=True)
    p.add_argument('--candidate-manifest', type=Path)
    p.add_argument('--expect-candidate-sha256')
    p.add_argument('--allow-growth', action='store_true')
    p.add_argument('--integration-root', type=Path, default=HERE.parent / 'firmware-integration')
    p.add_argument('--out-root', type=Path, default=HERE / 'out')
    args = p.parse_args(argv)
    args.out_root = args.out_root.resolve()
    try:
        args.out_root.mkdir(parents=True, exist_ok=True)
        run_dir, receipt = build(args)
    except PackError as e:
        print(f'FAIL-CLOSED: {e}', file=sys.stderr)
        return 2
    r = receipt['readback']
    print(json.dumps({'run_dir': str(run_dir), 'evidence_kind': receipt['evidence_kind'], 'artifact_sha256': r['artifact_sha256'],
                      'decoded_system_sha256': r['decoded_system_sha256'], 'NOTINSTALL': True}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
