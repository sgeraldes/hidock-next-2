"""Fetch a pinned bounded Spanish test subset; no datasets package or inference."""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request
import struct

REVISION = '70bb2e84b976b7e960aa89f1c648e09c59f894dd'
MAX_DOWNLOAD = 600 * 1024 * 1024


def wav_frames(data: bytes) -> int:
    """Read bounded RIFF metadata, including FLEURS IEEE-float WAV, without decoding."""
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE' or len(data) < 12:
        raise ValueError('Invalid WAV header')
    limit = struct.unpack_from('<I', data, 4)[0] + 8
    if limit != len(data): raise ValueError('WAV length mismatch')
    offset, fmt, payload = 12, None, None
    while offset + 8 <= limit:
        kind, length = struct.unpack_from('<4sI', data, offset)
        start = offset + 8
        if start + length > limit: raise ValueError('Truncated WAV chunk')
        if kind == b'fmt ':
            if fmt is not None or length < 16: raise ValueError('Invalid WAV format chunk')
            fmt = struct.unpack_from('<HHIIHH', data, start)
        elif kind == b'data':
            if payload is not None: raise ValueError('Duplicate WAV audio chunk')
            payload = length
        offset = start + length + (length % 2)
    if offset != limit or fmt is None or payload is None: raise ValueError('Incomplete WAV')
    encoding, channels, rate, byte_rate, alignment, bits = fmt
    if (encoding not in (1, 3) or channels != 1 or rate != 16000 or bits not in (16, 24, 32)
            or (encoding == 3 and bits != 32) or alignment != channels * bits // 8
            or byte_rate != rate * alignment or payload % alignment):
        raise ValueError('Unexpected corpus audio format')
    return payload // alignment


def fetch(destination: Path, language: str = 'es_419'):
    if language not in ('es_419', 'en_us'): raise ValueError('Unsupported corpus language')
    base = f'https://huggingface.co/datasets/google/fleurs/resolve/{REVISION}/data/{language}/'
    destination.mkdir(parents=True, exist_ok=True)
    manifest = destination / 'reference.json'
    if manifest.exists(): raise ValueError('Existing manifest: refusing to redefine benchmark')
    with urllib.request.urlopen(base + 'test.tsv', timeout=60) as response:
        tsv = response.read(2 * 1024 * 1024)
    if len(tsv) >= 2 * 1024 * 1024: raise ValueError('TSV exceeds cap')
    rows = list(csv.reader(io.StringIO(tsv.decode('utf-8')), delimiter='\t'))
    eligible = [r for r in rows if len(r) >= 7 and 3 * 16000 <= int(r[5]) <= 30 * 16000]
    # Fixed seed + sentence ID; choose one filename per unique sentence, before any model output exists.
    seed = 'hidock-es419-v1:' if language == 'es_419' else 'hidock-enus-v1:'
    eligible.sort(key=lambda r: (hashlib.sha256((seed + r[0]).encode()).hexdigest(), r[1]))
    selected, sentence_ids = [], set()
    for row in eligible:
        if row[0] in sentence_ids: continue
        sentence_ids.add(row[0]); selected.append(row)
        if len(selected) == 30: break
    if len(selected) != 30: raise ValueError('Insufficient eligible independent sentences')
    (destination / 'selection.json').write_text(json.dumps({'revision': REVISION, 'filenames': [r[1] for r in selected],
        'tsvSha256': hashlib.sha256(tsv).hexdigest()}, indent=2), encoding='utf-8')
    archive = destination / 'test.tar.gz'
    # Fixed immutable URL, timeout, size ceiling; retain archive for reproducibility.
    digest = hashlib.sha256(); downloaded = 0
    if not archive.exists():
        partial = destination / 'test.tar.gz.part'
        with urllib.request.urlopen(base + 'audio/test.tar.gz', timeout=60) as response, partial.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                downloaded += len(chunk)
                if downloaded > MAX_DOWNLOAD: raise ValueError('Archive exceeds 600 MiB')
                digest.update(chunk); output.write(chunk)
        partial.rename(archive)
    else:
        if archive.stat().st_size > MAX_DOWNLOAD: raise ValueError('Existing archive exceeds cap')
        with archive.open('rb') as source:
            while chunk := source.read(1024 * 1024): digest.update(chunk); downloaded += len(chunk)
    wanted = {r[1]: r for r in selected}; found = {}
    with tarfile.open(archive, 'r:gz') as tar:
        for entry in tar:
            filename = Path(entry.name).name
            if filename not in wanted: continue
            if filename in found or not entry.isfile() or entry.size > 10 * 1024 * 1024:
                raise ValueError('Invalid or duplicate selected archive member')
            data = tar.extractfile(entry).read()
            frames = wav_frames(data)
            if frames != int(wanted[filename][5]): raise ValueError('Audio/TSV sample count mismatch')
            duration = frames / 16000
            target = destination / filename
            target.write_bytes(data)
            r = wanted[filename]
            found[filename] = {'id': filename.removesuffix('.wav'), 'sentenceId': r[0], 'audioPath': str(target.resolve()),
                'audioSha256': hashlib.sha256(data).hexdigest(), 'text': r[2], 'publishedNormalizedText': r[3],
                'durationSeconds': duration, 'gender': r[6]}
    if set(found) != set(wanted): raise ValueError('Missing selected audio; no benchmark manifest published')
    result = {'schemaVersion': 1, 'purpose': 'pilot', 'provenance': {'referenceKind': 'public-dataset',
        'source': 'https://huggingface.co/datasets/google/fleurs', 'revision': REVISION, 'language': language,
        'split': 'test', 'heldOut': True, 'trainingContamination': 'unknown; test split does not prove unseen by pretrained models',
        'license': 'CC-BY-4.0', 'archiveSha256': digest.hexdigest(), 'archiveBytes': downloaded},
        'items': [found[r[1]] for r in selected]}
    manifest.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'manifest': str(manifest), 'items': len(found), 'seconds': sum(x['durationSeconds'] for x in found.values())}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--out', required=True)
    parser.add_argument('--language', choices=['es_419', 'en_us'], default='es_419')
    args = parser.parse_args()
    fetch(Path(args.out).resolve(), args.language)
