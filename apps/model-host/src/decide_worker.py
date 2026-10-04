"""Decision worker for the Model Host: Clef or Clef-Flash, kept loaded on the GPU.

Loading a model takes tens of seconds and a decision tens of milliseconds, so the host
starts this once and talks to it line by line on stdin and stdout, one JSON object per
line, each answer carrying the id of its question:

  {"id": 1, "op": "load", "path": "<model dir>", "quantize": "none" | "nf4", "device": "cuda"}
  {"id": 2, "op": "decide", "request": <a Jev/SystemOne /v1/systemone body>}

The model's own code (joint_schema_model.py, at the revision the host pinned) does the
encoding and the forward pass. When the host closes stdin this exits, and the model's
memory goes with the process.

With --download it fetches one model repository at a pinned revision and exits.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import importlib.util
import json
import sys
import time
from pathlib import Path


def emit(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(text: str) -> None:
    sys.stderr.write(f"[decide] {text}\n")
    sys.stderr.flush()


def vram_mib() -> float | None:
    # Only when the model already brought torch in: importing it here costs seconds.
    torch = sys.modules.get("torch")
    if torch is None or not torch.cuda.is_available():
        return None
    return round(torch.cuda.memory_allocated() / 2**20)


class Holder:
    def __init__(self) -> None:
        self.module = None
        self.model = None
        self.processor = None
        self.path: str | None = None

    def unload(self) -> None:
        self.model = None
        self.processor = None
        self.module = None
        self.path = None
        gc.collect()
        torch = sys.modules.get("torch")
        if torch is not None and torch.cuda.is_available():
            torch.cuda.empty_cache()

    def load(self, path: str, quantize: str, device: str) -> dict:
        self.unload()
        source = Path(path) / "joint_schema_model.py"
        # A name per directory: both repos ship a module with the same file name.
        name = "joint_schema_model_" + hashlib.sha1(str(source).encode()).hexdigest()[:12]
        spec = importlib.util.spec_from_file_location(name, source)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"cannot import {source}")
        module = importlib.util.module_from_spec(spec)
        # Registered before it runs: its dataclasses look their module up in sys.modules to
        # resolve the postponed annotations, and find None otherwise.
        sys.modules[name] = module
        spec.loader.exec_module(module)

        kwargs = {}
        if quantize == "nf4":
            import torch
            from transformers import BitsAndBytesConfig

            # The schema head reads lm_head's weight rows by token id, so lm_head stays BF16;
            # the vision tower is small and stays BF16 too.
            kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.bfloat16,
                llm_int8_skip_modules=["lm_head", "visual"],
            )
        elif quantize != "none":
            raise ValueError(f"unknown quantization {quantize}")

        started = time.perf_counter()
        model, processor = module.load_release_model(path, device=device, **kwargs)
        self.module, self.model, self.processor, self.path = module, model, processor, path
        return {"seconds": round(time.perf_counter() - started, 2), "vramMiB": vram_mib()}

    def decide(self, request: dict, max_length: int) -> dict:
        if self.model is None:
            raise RuntimeError("no model is loaded")
        started = time.perf_counter()
        response = self.module.systemone(self.model, self.processor, request, max_length=max_length)
        return {"response": response, "ms": round((time.perf_counter() - started) * 1000, 1)}


def serve() -> int:
    holder = Holder()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        message_id = None
        try:
            message = json.loads(line)
            message_id = message.get("id")
            op = message.get("op")
            if op == "load":
                result = holder.load(
                    str(message["path"]),
                    str(message.get("quantize", "none")),
                    str(message.get("device", "cuda")),
                )
                log(f"loaded {message['path']} in {result['seconds']} s, {result['vramMiB']} MiB")
            elif op == "decide":
                result = holder.decide(message["request"], int(message.get("maxLength", 16384)))
            else:
                raise RuntimeError(f"unknown op {op}")
            emit({"id": message_id, "ok": True, **result})
        except ValueError as error:
            # The model code raises ValueError for a request it cannot encode: the caller's fault.
            emit({"id": message_id, "ok": False, "invalid": True, "error": str(error)})
        except Exception as error:  # noqa: BLE001 - every failure goes back to the host
            log(f"{type(error).__name__}: {error}")
            emit({"id": message_id, "ok": False, "error": f"{type(error).__name__}: {error}"})
    holder.unload()
    return 0


def download(repo: str, revision: str, directory: str) -> int:
    from huggingface_hub import snapshot_download

    snapshot_download(repo_id=repo, revision=revision, local_dir=directory)
    log(f"downloaded {repo}@{revision} to {directory}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--download")
    parser.add_argument("--revision")
    parser.add_argument("--dir")
    args = parser.parse_args()
    if args.download:
        return download(args.download, args.revision, args.dir)
    return serve()


if __name__ == "__main__":
    sys.exit(main())
