"""Fetch the audited MOSS snapshot; no floating remote Python code is executed."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

MODEL = "OpenMOSS-Team/MOSS-Transcribe-Diarize"
REVISION = "704aa4a9c304e8520be88901e0d1960158ef5b15"
SOURCE_REVISION = "e3bdd93f8ad58418e04659818efd5fd87a0bc486"
REQUIRED = (
    "config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json",
    "preprocessor_config.json", "processor_config.json", "chat_template.jinja",
    "configuration_moss_transcribe_diarize.py", "modeling_moss_transcribe_diarize.py",
    "processing_moss_transcribe_diarize.py", "model-00000-of-00001.safetensors",
)


def validate_checkpoint(root: Path) -> dict:
    """Require all snapshot parts and the pinned preparation manifest."""
    if any(not (root / name).is_file() or (root / name).stat().st_size == 0 for name in REQUIRED):
        raise ValueError("Incomplete MOSS checkpoint; run model preparation")
    manifest = json.loads((root / "hidock-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("model") != MODEL or manifest.get("revision") != REVISION:
        raise ValueError("MOSS checkpoint revision does not match the audited code")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()
    from huggingface_hub import snapshot_download
    root = Path(args.model_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    snapshot_download(MODEL, revision=REVISION, local_dir=str(root), max_workers=2,
                      allow_patterns=["*.json", "*.py", "*.jinja", "*.txt", "*.safetensors"])
    manifest = {"model": MODEL, "revision": REVISION, "sourceRevision": SOURCE_REVISION,
                "backend": "transformers-sdpa", "trustRemoteCode": "pinned-local-snapshot"}
    (root / "hidock-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    validate_checkpoint(root)
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
