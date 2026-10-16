"""Apply model controls inside the ASR shim's selected virtual environment."""
import os
import runpy
import sys

if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("A target module is required")
    import torch
    threads = max(1, int(os.environ.get("HIDOCK_DIARIZATION_THREADS", "1")))
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    requested = os.environ.get("ASR_DEVICE", "auto")
    if requested == "auto" or requested.startswith("cuda"):
        os.environ["ASR_DEVICE"] = "cuda:0" if torch.cuda.is_available() else "cpu"
    # Cohere has a private transformers overlay; never upgrade the shared ASR plugin.
    if os.environ.get("HIDOCK_ASR_BACKEND") == "cohere" and os.environ.get("ASR_DEVICE") == "cpu":
        from pathlib import Path
        overlay = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "HiDock" / "Runtime" / "cohere" / "site"
        if (overlay / "transformers" / "models" / "cohere_asr").is_dir():
            import json
            manifest_path = overlay.parent / "runtime.json"
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                manifest = {}
            if (manifest.get("inferenceVerified") is not True or manifest.get("validatedDevice") != "cpu"
                    or manifest.get("algorithm") != "cohere-bf16-pread-v1"
                    or manifest.get("modelRevision") != "b1eacc2686a3d08ceaae5f24a88b1d519620bc09") :
                raise SystemExit("Isolated Cohere runtime is installed but CPU inference has not passed bounded validation; no model started.")
            sys.path.insert(0, str(overlay))
            import importlib.metadata
            import platform
            expected_runtime = {
                "pythonVersion": platform.python_version(),
                "torchVersion": torch.__version__,
                "transformersVersion": importlib.metadata.version("transformers"),
                "safetensorsVersion": importlib.metadata.version("safetensors"),
            }
            if any(manifest.get(key) != value for key, value in expected_runtime.items()):
                raise SystemExit("Cohere CPU runtime changed since bounded validation; preparation required.")
        import importlib.util
        transformers_spec = importlib.util.find_spec("transformers")
        locations = list(transformers_spec.submodule_search_locations or []) if transformers_spec else []
        if not any((Path(location) / "models" / "cohere_asr").is_dir() for location in locations):
            raise SystemExit("Cohere runtime unavailable: prepare the isolated transformers 5.10.2 overlay. Shared ASR environment was not modified.")
    print(f"[ResourcePolicy] ASR device: {os.environ.get('ASR_DEVICE', 'cpu')}; threads: {threads}", file=sys.stderr, flush=True)
    module = sys.argv[1]
    sys.argv = sys.argv[1:]
    if module == "asr_mcp.cli" and os.environ.get("HIDOCK_ASR_BACKEND") == "cohere" and os.environ.get("ASR_DEVICE") == "cpu":
        from cohere_cpu_cli import main
        raise SystemExit(main(sys.argv[1:]))
    runpy.run_module(module, run_name="__main__", alter_sys=True)
