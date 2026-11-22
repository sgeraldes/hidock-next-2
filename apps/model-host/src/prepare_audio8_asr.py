"""Prepare pinned Audio8 weights and the official pure-Torch inference package."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

MODEL = "Edge0/Audio8-ASR-Infinite"
REVISION = "7476824bc222e4ad509d286e8cae8b8d3f371129"
SOURCE_REVISION = "c8ba8eea829be0339e8d7757f8ca52dac06e1e32"
SOURCE_FILES = ("__init__.py", "modeling/__init__.py", "modeling/configuration_audio8_asr_infinite.py",
                "modeling/modeling_audio8_asr_infinite.py", "simulated_streaming_audio.py", "streaming_inference.py")
REQUIRED = ("config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json",
            "model.safetensors", "semantic_vad_heads.safetensors", "model.safetensors.index.json")


def validate_checkpoint(root: Path) -> dict:
    manifest = json.loads((root / "hidock-manifest.json").read_text(encoding="utf-8"))
    if (manifest.get("model"), manifest.get("revision"), manifest.get("sourceRevision")) != (
            MODEL, REVISION, SOURCE_REVISION):
        raise ValueError("Audio8 checkpoint/code revision is not the pinned version")
    for name in REQUIRED:
        if not (root / name).is_file() or not (root / name).stat().st_size:
            raise ValueError("Audio8 checkpoint is incomplete")
    for name in SOURCE_FILES:
        path = root / "source" / "audio8_asr_infinite" / name
        if hashlib.sha256(path.read_bytes()).hexdigest() != manifest.get("sourceHashes", {}).get(name):
            raise ValueError("Audio8 prepared source integrity check failed")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()
    from huggingface_hub import snapshot_download
    root = Path(args.model_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    snapshot_download(MODEL, revision=REVISION, local_dir=str(root), max_workers=2,
                      allow_patterns=["*.json", "*.py", "*.jinja", "*.safetensors"])
    hashes = {}
    for name in SOURCE_FILES:
        url = (f"https://raw.githubusercontent.com/Edge0-AI/Audio8-ASR-Infinite/{SOURCE_REVISION}/"
               f"audio8_asr_infinite/{name}")
        with urlopen(url, timeout=60) as response:
            data = response.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ValueError("Audio8 source file exceeds preparation limit")
        path = root / "source" / "audio8_asr_infinite" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        hashes[name] = hashlib.sha256(data).hexdigest()
    manifest = {"model": MODEL, "revision": REVISION, "sourceRevision": SOURCE_REVISION,
                "sourceHashes": hashes, "backend": "torch-sdpa-simulated-streaming", "languages": ["en", "zh"]}
    (root / "hidock-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    validate_checkpoint(root)
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
