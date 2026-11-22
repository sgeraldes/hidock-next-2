"""Prepare a pinned local snapshot; inference never downloads model files."""
import argparse
import json
from pathlib import Path
from huggingface_hub import HfApi, snapshot_download

MODELS = {"moondream/parakeet-ultra": "photon-parakeet-ultra", "Qwen/Qwen3-ASR-1.7B": "photon-qwen3-asr-1.7b"}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--model", choices=MODELS, required=True)
    args = parser.parse_args()
    revision = HfApi().model_info(args.model).sha
    destination = Path(args.root) / "models" / MODELS[args.model]
    snapshot_download(args.model, revision=revision, local_dir=destination, max_workers=2,
                      allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model"])
    (destination / "hidock-manifest.json").write_text(json.dumps({
        "model": args.model, "revision": revision, "runtime": "moondream==2.6.1", "provider": "cuda",
    }), encoding="utf-8")
