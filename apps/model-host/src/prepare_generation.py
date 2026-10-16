"""Fixed, hash-verified official Windows generation artifacts. No arbitrary URL/commands."""
import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path
import urllib.request
import zipfile

ARTIFACTS = [
 ('https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/7c41481f57cb95916b40956ab2f0b139b296d974/Qwen3-8B-Q4_K_M.gguf', 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785', 'model'),
 ('https://github.com/ggml-org/llama.cpp/releases/download/b11560/llama-b11560-bin-win-cuda-12.4-x64.zip', '5b0e7d7d6a0c6908005459a3371463d1b125b036ba99fbe9cb2f5e1636d85725', 'engine'),
 ('https://github.com/ggml-org/llama.cpp/releases/download/b11560/cudart-llama-bin-win-cuda-12.4-x64.zip', '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6', 'cuda'),
]

def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            h.update(chunk)
    return h.hexdigest()

def download_verified(url: str, target: Path, expected: str, size: int) -> None:
    """Resume exact ranges; activate only after complete hash verification."""
    if target.exists() and target.stat().st_size == size and digest(target) == expected:
        return
    partial = target.with_suffix('.partial')
    offset = partial.stat().st_size if partial.exists() else 0
    if offset >= size:
        if offset == size and digest(partial) == expected:
            partial.replace(target)
            return
        partial.unlink()
        offset = 0
    if shutil.disk_usage(target.parent).free < size - offset + 2_000_000_000:
        raise OSError('Insufficient disk space for verified generation artifact')
    request = urllib.request.Request(url, headers={'Accept-Encoding': 'identity', **({'Range': f'bytes={offset}-'} if offset else {})})
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.status == 206:
            match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
            if not match or tuple(map(int, match.groups())) != (offset, size - 1, size):
                raise ValueError('Invalid resume Content-Range')
        elif response.status == 200:
            offset = 0  # Range ignored: replace partial, never append full response
            if shutil.disk_usage(target.parent).free < size + 2_000_000_000:
                raise OSError('Insufficient disk space for full artifact')
        else:
            raise ValueError('Unexpected artifact HTTP status')
        if response.headers.get('Content-Length') and int(response.headers['Content-Length']) != size - offset:
            raise ValueError('Artifact Content-Length mismatch')
        with partial.open('ab' if offset else 'wb') as output:
            count = offset
            while chunk := response.read(1048576):
                if count + len(chunk) > size:
                    raise ValueError('Artifact exceeded pinned size')
                output.write(chunk)
                count += len(chunk)
        if count != size:
            raise OSError('Incomplete artifact; partial retained for resume')
    if digest(partial) != expected:
        partial.unlink()
        raise ValueError('Artifact SHA256 mismatch')
    partial.replace(target)

def prepare(root: Path) -> None:
    cache = root / 'downloads' / 'generation'
    cache.mkdir(parents=True, exist_ok=True)
    runtime = root / 'runtime' / 'generation'
    runtime.mkdir(parents=True, exist_ok=True)
    for url, expected, kind in ARTIFACTS:
        target = root / 'models' / 'qwen3-8b-gguf' / 'Qwen3-8B-Q4_K_M.gguf' if kind == 'model' else cache / (kind + '.zip')
        target.parent.mkdir(parents=True, exist_ok=True)
        download_verified(url, target, expected, {'model': 5027783488, 'engine': 265207451, 'cuda': 391443627}[kind])
        if kind != 'model':
            with zipfile.ZipFile(target) as archive:
                if sum(x.file_size for x in archive.infolist()) > 2_000_000_000:
                    raise ValueError('Expanded runtime exceeds limit')
                for entry in archive.infolist():
                    if entry.is_dir():
                        continue
                    # Official archives may have a top folder; only copy executable runtime files.
                    name = Path(entry.filename).name
                    if 'license' in name.lower() or 'copying' in name.lower() or 'notice' in name.lower():
                        license_dir = root / 'licenses' / 'generation' / kind
                        license_dir.mkdir(parents=True, exist_ok=True)
                        with archive.open(entry) as source, (license_dir / name).open('wb') as output:
                            shutil.copyfileobj(source, output, 1048576)
                        continue
                    if not name.lower().endswith(('.dll', '.exe')):
                        continue
                    if name in ('', '.', '..'):
                        raise ValueError('Invalid archive entry')
                    with archive.open(entry) as source, (runtime / name).open('wb') as output:
                        while chunk := source.read(1048576):
                            output.write(chunk)
    manifest = {
        'signed': False, 'signatureStatus': 'unsigned; upstream artifact hashes verified',
        'model': {'id': 'Qwen/Qwen3-8B-GGUF', 'revision': '7c41481f57cb95916b40956ab2f0b139b296d974',
                  'file': 'Qwen3-8B-Q4_K_M.gguf', 'sha256': ARTIFACTS[0][1], 'sourceUrl': ARTIFACTS[0][0],
                  'license': 'Apache-2.0', 'licenseUrl': 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/blob/7c41481f57cb95916b40956ab2f0b139b296d974/LICENSE'},
        'engine': {'release': 'b11560', 'commit': 'b13a93a3d5fa44b57899d86467a4de463e7415a7',
                   'license': 'MIT', 'licenseUrl': 'https://github.com/ggml-org/llama.cpp/blob/b11560/LICENSE',
                   'archives': [{'sourceUrl': url, 'sha256': sha} for url, sha, kind in ARTIFACTS if kind != 'model']},
        'limits': {'contextTokens': 8192, 'outputTokens': 2048, 'requestSeconds': 120, 'parallel': 1},
        'tokenizer': 'embedded GGUF tokenizer and chat template', 'backend': 'CUDA required; observed PID proof required',
        'resources': {'memory': 'min(16GiB,25%total,50%free); require8GiB', 'cpuMaximumPercent': 50, 'priority': 'below-normal', 'windowsJobRequired': True},
        'validationLimitation': 'Preparation tests Spanish JSON, observed CUDA and teardown; does not establish business quality or cancellation proof.'
    }
    (root / 'generation-pack.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    if not (runtime / 'llama-server.exe').is_file():
        raise ValueError('Official archive missing llama-server.exe')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    prepare(Path(parser.parse_args().root).resolve())
