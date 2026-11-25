"""Bounded CPU-only semantic embedding worker, local assets only."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_semantic_embeddings import MODEL, SEMANTICS, load_manifest


def validate_request(request: object) -> dict:
    if not isinstance(request, dict) or request.get("purpose") not in ("query", "passage"):
        raise ValueError("Explicit query or passage purpose required")
    texts = request.get("texts")
    if (not isinstance(texts, list) or not 1 <= len(texts) <= 16
            or any(not isinstance(text, str) or not text.strip() or len(text) > 16000 for text in texts)
            or sum(len(text.encode("utf-8")) for text in texts) > 131072):
        raise ValueError("Embedding request exceeds text quotas")
    return request


def pool_normalize(hidden, mask, np):
    if hidden.ndim != 3 or hidden.shape[:2] != mask.shape or hidden.shape[2] != 2048:
        raise ValueError("Unexpected embedding tensor shape")
    vectors = (hidden * mask[:, :, None]).sum(axis=1) / np.maximum(mask.sum(axis=1)[:, None], 1)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    if not np.isfinite(vectors).all() or (norms <= 0).any():
        raise ValueError("Invalid embedding model output")
    return (vectors / norms).tolist()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--worker-dir", required=True)
    parser.add_argument("--site-dir", required=True)
    args = parser.parse_args()
    sys.path.insert(0, args.worker_dir)
    from resource_policy import apply_resource_policy
    policy = apply_resource_policy()
    sys.path.insert(0, args.site_dir)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import numpy as np
    import onnxruntime as ort
    from transformers import AutoTokenizer
    if args.request.stat().st_size > 262144:
        raise ValueError("Embedding request body too large")
    request = validate_request(json.loads(args.request.read_text(encoding="utf-8")))
    manifest = load_manifest(args.model_dir)
    started = time.monotonic()
    tokenizer = AutoTokenizer.from_pretrained(str(args.model_dir), local_files_only=True, trust_remote_code=False)
    tokens = tokenizer([SEMANTICS["prefixes"][request["purpose"]] + text for text in request["texts"]],
                       padding=True, truncation=True, max_length=512, return_tensors="np")
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, int(os.environ.get("OMP_NUM_THREADS", "1")))
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    session = ort.InferenceSession(str(args.model_dir / "onnx/model.onnx"), sess_options=options,
                                   providers=["CPUExecutionProvider"])
    feeds = {}
    for item in session.get_inputs():
        if item.name not in tokens:
            raise ValueError("Model requires an unsupported tokenizer input")
        feeds[item.name] = np.asarray(tokens[item.name], dtype=np.int64)
    outputs = session.run(["last_hidden_state"], feeds)
    vectors = pool_normalize(outputs[0], np.asarray(tokens["attention_mask"]), np)
    print(json.dumps({"model": MODEL, "modelVersion": manifest["spaceId"], "spaceId": manifest["spaceId"],
                      "dimensions": 2048, "purpose": request["purpose"], "vectors": vectors,
                      "device": "cpu", "resourcePolicy": policy, "runtimeVersion": ort.__version__,
                      "inputTokens": int(np.asarray(tokens["attention_mask"]).sum()),
                      "wallSeconds": time.monotonic() - started}, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": type(error).__name__ + ": semantic worker failed"}), file=sys.stderr)
        sys.exit(1)
