"""Install hash-pinned official NeMo-Speech.cpp Windows CUDA artifacts."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.request
import zipfile

MODEL = "nvidia/nemotron-3.5-asr-streaming-0.6b"
DIRECTORY = "nemotron-3.5-asr-streaming-0.6b-gguf"
VERSION = "0.2.0"
REVISION = "1c8deaecc64b91f034d73e08dd8b64625eb3395d"
MODEL_FILE = "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf"
MODEL_SHA = "a5c435f294eea8f88ce68dd27b8c3bfea7f777cb2fbba04fcd30eaa555f429ae"
MODEL_SIZE = 741548352
ARCHIVE = "nemo-speech-0.2.0-windows-x86_64-cuda.zip"
ARCHIVE_SHA = "9ffe5e842c39a7d3211f3b2c3b3aa1bca8c0b2455d96d961ed5f22ec5108f98d"
ARCHIVE_SIZE = 102183465


def digest(path: Path) -> str:
    """Hash without loading a model into memory."""
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url: str, path: Path, size: int, expected: str) -> None:
    """Publish only artifacts matching NVIDIA's pinned index/release hashes."""
    if path.is_file() and path.stat().st_size == size and digest(path) == expected:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".partial")
    try:
        with urllib.request.urlopen(url, timeout=90) as response, temporary.open("wb") as output:
            received = 0
            while chunk := response.read(1024 * 1024):
                received += len(chunk)
                if received > size:
                    raise ValueError("Artifact exceeds pinned size")
                output.write(chunk)
        if temporary.stat().st_size != size or digest(temporary) != expected:
            raise ValueError("Artifact does not match NVIDIA's pinned SHA-256 and size")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def extract_runtime(archive: Path, destination: Path) -> None:
    """Reject traversal and symlinks before extracting an authenticated archive."""
    base = destination.resolve()
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            target = (base / entry.filename).resolve()
            if not target.is_relative_to(base) or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("Unsafe archive entry")
        source.extractall(base)


def prepare(root: Path) -> None:
    runtime = root / "runtime" / "asr-nemotron"
    runtime.mkdir(parents=True, exist_ok=True)
    model = root / "models" / DIRECTORY
    model.mkdir(parents=True, exist_ok=True)
    archive = runtime / ARCHIVE
    download(f"https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v{VERSION}/{ARCHIVE}",
             archive, ARCHIVE_SIZE, ARCHIVE_SHA)
    # The containing model-host tray is stopped during this operation.
    extract_runtime(archive, runtime)
    download(f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{MODEL_FILE}",
             model / MODEL_FILE, MODEL_SIZE, MODEL_SHA)
    executable = runtime / ARCHIVE.removesuffix(".zip") / "bin" / "nemo-speech.exe"
    if not executable.is_file():
        raise ValueError("Official runtime archive has no CLI executable")
    (model / "hidock-manifest.json").write_text(json.dumps({
        "model": MODEL, "revision": REVISION, "runtime": f"NeMo-Speech.cpp/{VERSION}",
        "provider": "cuda", "modelFile": MODEL_FILE, "modelSha256": MODEL_SHA,
        "modelBytes": MODEL_SIZE, "archiveSha256": ARCHIVE_SHA,
        "executableSha256": digest(executable),
    }), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--model", choices=[MODEL], required=True)
    args = parser.parse_args()
    prepare(Path(args.root))
