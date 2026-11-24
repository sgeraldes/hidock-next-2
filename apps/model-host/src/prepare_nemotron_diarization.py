"""Prepare pinned NVIDIA diarization weights using the existing native runtime.

Source: NVIDIA HF model index at REVISION, NeMo-Speech.cpp v0.2.0.
This operation is explicit preparation, never an inference-time download.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import zipfile
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))

from prepare_nemotron_asr import ARCHIVE, ARCHIVE_SHA, VERSION, digest, download

MODEL = "nvidia/Nemotron-3-Diarization"
DIRECTORY = "nemotron-3-diarization-gguf"
REVISION = "f667ed73aee57d40cc39428eb768b4fd87a0a29e"
MODEL_FILE = "Nemotron-3-Diarization.q8_0.gguf"
MODEL_SIZE = 107012128
MODEL_SHA = "08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1"


def runtime_executable(runtime: Path) -> Path:
    """Resolve the shared, explicitly prepared Windows CUDA release."""
    executable = runtime / ARCHIVE.removesuffix(".zip") / "bin" / "nemo-speech.exe"
    if not executable.is_file():
        raise ValueError("Prepare the pinned NeMo-Speech.cpp CUDA runtime first")
    return executable


def prepare(root: Path) -> None:
    """Download only the 107 MB diarization model; do not reinstall the runtime."""
    runtime = root / "runtime" / "asr-nemotron"
    executable = runtime_executable(runtime)
    archive = runtime / ARCHIVE
    if not archive.is_file() or digest(archive) != ARCHIVE_SHA:
        raise ValueError("Pinned native runtime archive verification failed")
    with zipfile.ZipFile(archive) as release:
        entry = executable.relative_to(runtime).as_posix()
        with release.open(entry) as stream:
            expected_executable = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest(executable) != expected_executable:
        raise ValueError("Installed native executable differs from the pinned release")
    directory = root / "models" / DIRECTORY
    directory.mkdir(parents=True, exist_ok=True)
    download(f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{MODEL_FILE}",
             directory / MODEL_FILE, MODEL_SIZE, MODEL_SHA)
    manifest = directory / "hidock-manifest.json"
    temporary = directory / "hidock-manifest.json.partial"
    try:
        temporary.write_text(json.dumps({
            "model": MODEL, "revision": REVISION, "runtime": f"NeMo-Speech.cpp/{VERSION}",
            "provider": "cuda", "modelFile": MODEL_FILE, "modelSha256": MODEL_SHA,
            "modelBytes": MODEL_SIZE, "archiveSha256": ARCHIVE_SHA,
            "executableSha256": digest(executable), "speakerEmbeddings": False,
        }), encoding="utf-8")
        os.replace(temporary, manifest)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--model", choices=[MODEL], required=True)
    args = parser.parse_args()
    prepare(Path(args.root))
