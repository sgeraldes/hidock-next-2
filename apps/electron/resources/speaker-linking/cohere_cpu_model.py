"""Isolated Cohere CPU loader retaining checkpoint BF16 within the worker budget.

This adapter is intentionally separate from the shared plugin and CUDA loader.
Import it only after resource policy and the private dependency overlay are set.
"""
from pathlib import Path

MODEL_ID = "CohereLabs/cohere-transcribe-03-2026"
MODEL_REVISION = "b1eacc2686a3d08ceaae5f24a88b1d519620bc09"


def load_cpu_checkpoint(model_class, root, torch_module):
    """Read tensors through official pread API; reject incomplete checkpoint loads."""
    from safetensors import safe_open
    state = {}
    with safe_open(str(Path(root) / "model.safetensors"), framework="pt", device="cpu", backend="pread") as weights:
        for name in weights.keys():
            tensor = weights.get_tensor(name)
            if tensor.is_floating_point() and tensor.dtype != torch_module.bfloat16:
                raise ValueError("Pinned Cohere checkpoint has an unexpected floating dtype")
            state[name] = tensor
    config = model_class.config_class.from_pretrained(str(root), local_files_only=True, trust_remote_code=False)
    model, info = model_class.from_pretrained(
        None, config=config, state_dict=state, dtype=torch_module.bfloat16,
        trust_remote_code=False, output_loading_info=True, ignore_mismatched_sizes=False,
    )
    for key in ("missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs"):
        if info.get(key):
            raise ValueError(f"Cohere strict checkpoint loading failed: {key} count={len(info[key])}")
    return model.eval()


def create_cpu_model():
    """Return a plugin-compatible model without modifying shared classes."""
    import torch
    from asr_mcp.model import TranscriptionModel
    from transformers import AutoProcessor, CohereAsrForConditionalGeneration
    from huggingface_hub import snapshot_download

    class CohereCpuModel(TranscriptionModel):
        def load(self) -> None:
            self._device = "cpu"
            self._processor = AutoProcessor.from_pretrained(
                MODEL_ID, revision=MODEL_REVISION, local_files_only=True, trust_remote_code=False,
            )
            root = snapshot_download(MODEL_ID, revision=MODEL_REVISION, local_files_only=True)
            self._model = load_cpu_checkpoint(CohereAsrForConditionalGeneration, root, torch)
            if self._model.device.type != "cpu" or self._model.dtype != torch.bfloat16:
                raise RuntimeError("Cohere CPU loader did not retain CPU BF16; no fallback allowed")

        def transcribe(self, file_path: Path, language: str, **kwargs):
            with torch.autocast(device_type="cpu", dtype=torch.bfloat16):
                return super().transcribe(file_path, language, **kwargs)

    return CohereCpuModel()
