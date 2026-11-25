"""Fingerprint an explicitly imported local ONNX model; never downloads assets."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path

MODEL = "local/nemotron-3-embed-1b"
SEMANTICS = {"version": 1, "dimensions": 2048, "maxTokens": 512,
             "prefixes": {"query": "query: ", "passage": "passage: "},
             "pooling": "attention-masked-mean", "normalization": "l2"}
FILES = ("config.json", "tokenizer_config.json", "tokenizer.json", "onnx/model.onnx", "onnx/model.onnx.data")


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def create_manifest(directory: Path) -> dict:
    """Record exact bytes, without claiming a remote revision or redistribution license."""
    files = {}
    for name in FILES:
        path = directory / name
        if not path.is_file() or path.is_symlink():
            raise ValueError("Required imported model asset missing or linked")
        stat = path.stat()
        files[name] = {"sha256": digest(path), "bytes": stat.st_size, "mtimeNs": str(stat.st_mtime_ns)}
    identity = {"model": MODEL, "semantics": SEMANTICS,
                "assets": {name: item["sha256"] for name, item in files.items()}}
    fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {**identity, "spaceId": "nemotron-import-sha256:" + fingerprint, "files": files,
            "provenance": "explicit local asset import; upstream revision and redistribution rights not asserted"}


def load_manifest(directory: Path) -> dict:
    manifest = json.loads((directory / "hidock-semantic-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("semantics") != SEMANTICS or manifest.get("model") != MODEL:
        raise ValueError("Unsupported semantic manifest")
    for name in FILES:
        stat = (directory / name).stat()
        item = manifest["files"][name]
        if stat.st_size != item["bytes"] or str(stat.st_mtime_ns) != item["mtimeNs"]:
            raise ValueError("Imported model changed; explicit verification required")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    args = parser.parse_args()
    manifest = create_manifest(args.model_dir)
    target = args.model_dir / "hidock-semantic-manifest.json"
    temporary = target.with_suffix(".partial")
    temporary.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    temporary.replace(target)
    print(json.dumps({"spaceId": manifest["spaceId"], "prepared": True, "validated": False}))
