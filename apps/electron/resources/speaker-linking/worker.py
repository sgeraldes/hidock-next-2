"""Local acoustic diarization + per-speaker embedding worker.

Stdout is a single JSON document. Diagnostics go to stderr so Electron can
parse the result without log scraping. The model is downloaded/cached by
Hugging Face once and can then run offline.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def as_list(value: Any) -> list[float]:
    if hasattr(value, "detach"):
        value = value.detach().cpu().numpy()
    if hasattr(value, "tolist"):
        value = value.tolist()
    return [float(item) for item in value]


def get_hf_token() -> str | None:
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")
    if token:
        return token
    config_path = Path(os.environ.get("APPDATA", "")) / "hidock-universal-knowledge-hub" / "config.json"
    try:
        return json.loads(config_path.read_text(encoding="utf-8")).get("transcription", {}).get("localAsrHfToken")
    except (OSError, ValueError, AttributeError):
        # Missing/unreadable config, malformed JSON, or a section that is not an
        # object. Any of those means "no token here"; anything else should surface.
        return None


def resolve_ffmpeg_path() -> str | None:
    """Resolve ffmpeg-static in both development and packaged Electron layouts."""

    configured = os.environ.get("FFMPEG_PATH")
    candidates = [configured, shutil.which("ffmpeg")]
    if configured:
        candidates.insert(
            1,
            configured.replace("app.asar\\", "app.asar.unpacked\\").replace(
                "app.asar/", "app.asar.unpacked/"
            ),
        )
    return next((candidate for candidate in candidates if candidate and Path(candidate).is_file()), None)


def decode_audio(audio_path: str, torch: Any) -> dict[str, Any]:
    """Decode any app-supported audio without torchcodec.

    pyannote.audio 4 delegates path decoding to torchcodec. Its native DLLs are
    fragile on Windows and are unnecessary here because Electron already ships
    FFmpeg. Feeding an in-memory 16 kHz mono waveform also makes the worker's
    input contract identical in development and packaged builds.
    """

    ffmpeg = resolve_ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("FFmpeg is required for local speaker linking but was not found")
    process = subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            audio_path,
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-ac",
            "1",
            "-ar",
            "16000",
            "pipe:1",
        ],
        capture_output=True,
        check=False,
    )
    if process.returncode != 0:
        detail = process.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"FFmpeg could not decode recording: {detail or process.returncode}")
    if len(process.stdout) < 4:
        raise RuntimeError("FFmpeg decoded an empty recording")
    # Avoid numpy/torchaudio decoding dependencies. frombuffer reads FFmpeg's
    # little-endian float32 stream, and clone owns the immutable bytes safely.
    waveform = torch.frombuffer(bytearray(process.stdout), dtype=torch.float32).clone().unsqueeze(0)
    return {"waveform": waveform, "sample_rate": 16000, "uri": Path(audio_path).stem}


EMBEDDER_ONNX = "wespeaker-resnet34-lm-masked.onnx"
SEGMENTATION_ONNX = "segmentation-3.0.onnx"


def use_onnx_models(pipeline: Any, onnx_dir: str, provider: str, torch: Any) -> str:
    """Run the pipeline's two neural models through ONNX Runtime.

    Everything else stays pyannote: chunking, binarization, clustering and the
    output. The ONNX files are exports of the same weights (export_voice_onnx.py,
    embeddings cosine 1.000000 against PyTorch), so the voices land in the same
    space as the library's and no transfer is needed. The embedder runs on
    DirectML when asked (0.6 ms per second of audio on an RX 6600 XT against 5.7
    on the CPU); segmentation stays on the CPU, where it measured faster (1.6 ms
    against 3 to 4 on DirectML).

    Returns the device label that goes into the result.
    """
    import numpy as np
    import onnxruntime as ort

    options = ort.SessionOptions()
    threads_env = os.environ.get("HIDOCK_DIARIZATION_THREADS")
    if threads_env and threads_env.isdigit() and int(threads_env) > 0:
        options.intra_op_num_threads = int(threads_env)
    wanted = ["DmlExecutionProvider", "CPUExecutionProvider"] if provider == "dml" else ["CPUExecutionProvider"]
    available = ort.get_available_providers()
    if provider == "dml" and "DmlExecutionProvider" not in available:
        raise RuntimeError(
            "DirectML is not available in this Python environment "
            f"(onnxruntime providers: {', '.join(available)}). Install onnxruntime-directml."
        )
    embedder = ort.InferenceSession(os.path.join(onnx_dir, EMBEDDER_ONNX), options, providers=wanted)
    segmenter = ort.InferenceSession(
        os.path.join(onnx_dir, SEGMENTATION_ONNX), options, providers=["CPUExecutionProvider"]
    )

    def embed(waveforms: Any, weights: Any = None) -> Any:
        x = waveforms.detach().cpu().numpy().astype(np.float32)
        if x.ndim == 3:
            x = x[:, 0, :]  # (batch, channel, samples) -> (batch, samples)
        if weights is None:
            w = np.ones((x.shape[0], 1), dtype=np.float32)
        else:
            w = weights.detach().cpu().numpy().astype(np.float32)
        return torch.from_numpy(embedder.run(None, {"waveforms": x, "weights": w})[0])

    def segment(waveforms: Any, *_: Any, **__: Any) -> Any:
        x = waveforms.detach().cpu().numpy().astype(np.float32)
        return torch.from_numpy(segmenter.run(None, {"waveforms": x})[0])

    pipeline._embedding.model_.forward = embed
    pipeline._segmentation.model.forward = segment
    return "onnx-dml" if provider == "dml" else "onnx-cpu"


def main() -> int:
    parser = argparse.ArgumentParser(description="HiDock persistent acoustic speaker-linking worker")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", default="pyannote/speaker-diarization-community-1")
    parser.add_argument("--fallback-model", default="pyannote/speaker-diarization-3.1")
    parser.add_argument("--min-speech-seconds", type=float, default=4.0)
    parser.add_argument("--min-speakers", type=int)
    parser.add_argument("--max-speakers", type=int)
    parser.add_argument("--engine", choices=["pyannote", "onnx"], default="pyannote")
    parser.add_argument("--onnx-dir", help="folder with the exported ONNX voice models")
    parser.add_argument("--onnx-provider", choices=["dml", "cpu"], default="cpu")
    args = parser.parse_args()

    # Some native/model dependencies print diagnostics such as "Could not ..."
    # to stdout while importing or loading. Electron's worker contract reserves
    # stdout for exactly one JSON document, so redirect all third-party stdout to
    # stderr and retain the original stream only for the final result.
    result_stdout = sys.stdout
    sys.stdout = sys.stderr

    # Heavy imports stay inside main so --help and packaging checks do not need
    # the CUDA runtime or model dependencies installed.
    import torch
    from pyannote.audio import Pipeline

    # The host passes the thread budget (see diarizationThreadEnv in
    # speaker-linking.ts). OMP/MKL read their own variables at import time;
    # torch's intra-op pool has to be told explicitly, and on a CPU-only box
    # this is the difference between one recording pinning half the machine
    # for its whole run and it fitting in the share the user configured.
    threads_env = os.environ.get("HIDOCK_DIARIZATION_THREADS")
    if threads_env and threads_env.isdigit() and int(threads_env) > 0:
        torch.set_num_threads(int(threads_env))
        log(f"torch intra-op threads capped at {threads_env}")

    token = get_hf_token()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    log(f"loading {args.model} on {device} (torch threads {torch.get_num_threads()})")
    actual_model = args.model
    try:
        try:
            pipeline = Pipeline.from_pretrained(actual_model, token=token)
        except TypeError:
            pipeline = Pipeline.from_pretrained(actual_model, use_auth_token=token)  # type: ignore[call-arg]  # pyannote < 3.3 kwarg
    except Exception as primary_error:
        if not args.fallback_model or args.fallback_model == actual_model:
            raise
        actual_model = args.fallback_model
        log(f"primary model unavailable ({primary_error}); falling back to {actual_model}")
        try:
            pipeline = Pipeline.from_pretrained(actual_model, token=token)
        except TypeError:
            pipeline = Pipeline.from_pretrained(actual_model, use_auth_token=token)  # type: ignore[call-arg]  # pyannote < 3.3 kwarg
    if pipeline is None:
        raise RuntimeError(f"pyannote returned no pipeline for {actual_model}")
    pipeline.to(torch.device(device))
    if args.engine == "onnx":
        if not args.onnx_dir:
            raise RuntimeError("--engine onnx needs --onnx-dir")
        device = use_onnx_models(pipeline, args.onnx_dir, args.onnx_provider, torch)
        log(f"voice models through ONNX Runtime ({device})")
    audio_input = decode_audio(args.audio, torch)

    kwargs: dict[str, int] = {}
    if args.min_speakers is not None:
        kwargs["min_speakers"] = args.min_speakers
    if args.max_speakers is not None:
        kwargs["max_speakers"] = args.max_speakers
    output = pipeline(audio_input, **kwargs)  # type: ignore[arg-type]  # stubs type min/max_speakers as bool

    diarization = getattr(output, "speaker_diarization", output)
    embeddings = getattr(output, "speaker_embeddings", None)
    if embeddings is None:
        raise RuntimeError(
            "The selected pyannote pipeline did not return speaker_embeddings. "
            "Use speaker-diarization-community-1 with a current pyannote.audio release."
        )

    labels = list(diarization.labels())  # type: ignore[attr-defined]  # Annotation, untyped in stubs
    embedding_rows = [as_list(row) for row in embeddings]
    if len(labels) != len(embedding_rows):
        raise RuntimeError(
            f"speaker label/embedding count mismatch: {len(labels)} labels, {len(embedding_rows)} embeddings"
        )

    segments: list[dict[str, Any]] = []
    speech_seconds = {label: 0.0 for label in labels}
    for segment, _, label in diarization.itertracks(yield_label=True):  # type: ignore[attr-defined]
        start = round(float(segment.start), 3)
        end = round(float(segment.end), 3)
        if end <= start:
            continue
        segments.append({"start": start, "end": end, "speaker": str(label)})
        speech_seconds[str(label)] = speech_seconds.get(str(label), 0.0) + (end - start)

    speakers = []
    for label, embedding in zip(labels, embedding_rows):
        duration = round(speech_seconds.get(str(label), 0.0), 3)
        if duration < args.min_speech_seconds:
            continue
        speakers.append(
            {
                "label": str(label),
                "embedding": embedding,
                "speechSeconds": duration,
            }
        )

    result = {
        "model": actual_model,
        "modelVersion": importlib.metadata.version("pyannote.audio"),
        "device": device,
        "segments": segments,
        "speakers": speakers,
    }
    json.dump(result, result_stdout, ensure_ascii=False, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # Electron surfaces stderr in processing provenance.
        log(f"speaker-linking failed: {exc}")
        raise
