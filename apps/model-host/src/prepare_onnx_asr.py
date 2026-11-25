"""Download fixed model artifacts and extract only ordinary files inside their root."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import urllib.request

ARTIFACTS = {
    "nvidia/parakeet-tdt-0.6b-v3": "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    "Qwen/Qwen3-ASR-0.6B": "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
}


def prepare(root, model):
    name = ARTIFACTS[model]
    destination = (Path(root) / "models").resolve()
    destination.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{name}.tar.bz2"
    archive = destination / (name + ".tar.bz2")
    partial = archive.with_suffix(".partial")
    if not archive.exists():
        print(f"Downloading {model} from sherpa-onnx official release artifacts", flush=True)
        with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as output:
            while block := response.read(1024 * 1024):
                output.write(block)
        partial.replace(archive)
    expected = (destination / name).resolve()
    with tarfile.open(archive, "r:bz2") as package:
        for member in package:
            target = (destination / member.name).resolve()
            if not target.is_relative_to(expected) or not (member.isfile() or member.isdir()):
                raise ValueError(f"Unsafe model archive entry: {member.name}")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with package.extractfile(member) as source, target.open("wb") as output:
                while block := source.read(1024 * 1024):
                    output.write(block)
    digest = hashlib.sha256()
    with archive.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    (expected / "hidock-manifest.json").write_text(json.dumps({
        "model": model, "artifact": name, "source": url, "sha256": digest.hexdigest(),
        "runtime": "sherpa-onnx==1.13.8", "precision": "int8", "provider": "cpu",
    }), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--model", choices=ARTIFACTS, required=True)
    args = parser.parse_args()
    prepare(args.root, args.model)
