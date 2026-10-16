"""One resource-limited CUDA ASR job using a pre-prepared Photon checkpoint.

The native Windows wheel exists; availability on a particular GPU must still be
established by the host readiness probe. This worker never falls back to CPU.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time

# Embedded Windows Python deliberately omits the script directory from sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from parakeet_worker import silence_aware_windows, normalized_audio, frame_windows, has_nonzero_samples

ULTRA = "moondream/parakeet-ultra"
QWEN = "Qwen/Qwen3-ASR-1.7B"
MODELS = (ULTRA, QWEN)


def validate_checkpoint(directory: Path, model: str) -> Path:
    """Require a prepared local snapshot; do not permit an implicit Hub fetch."""
    if model not in MODELS:
        raise ValueError("Unsupported Photon ASR model")
    root = directory.resolve(strict=True)
    required = ("config.json", "tokenizer.json", "model.safetensors") if model == ULTRA else (
        "config.json", "generation_config.json", "tokenizer_config.json", "vocab.json", "merges.txt")
    if not root.is_dir() or any(not (root / name).is_file() or (root / name).stat().st_size == 0
                                 for name in required):
        raise ValueError("Incomplete Photon ASR checkpoint; run model preparation")
    if model == QWEN and not any(path.stat().st_size > 0 for path in root.glob("model*.safetensors")):
        raise ValueError("Qwen ASR checkpoint has no model weights")
    return root


def translate_segments(result: dict, offset: float, duration: float) -> list[dict]:
    """Preserve provider timings, validate bounds, and never invent speaker identity."""
    if not isinstance(result, dict) or not isinstance(result.get("text"), str):
        raise ValueError("Photon returned an invalid ASR result")
    source = result.get("segments")
    if not isinstance(source, list):
        raise ValueError("Photon returned no segment timestamps")
    if result["text"].strip() and not source:
        raise ValueError("Photon returned text without timestamped segments")
    rows = []
    previous = 0.0
    for segment in source:
        if not isinstance(segment, dict):
            raise ValueError("Photon returned an invalid timestamped segment")
        start, end = segment.get("start"), segment.get("end")
        if (not isinstance(start, (int, float)) or isinstance(start, bool)
                or not isinstance(end, (int, float)) or isinstance(end, bool)
                or not math.isfinite(start) or not math.isfinite(end)
                or start < previous or start < 0 or end <= start or end > duration):
            raise ValueError("Photon returned invalid or out-of-window segment timestamps")
        text = segment.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Photon returned an empty timestamped segment")
        row = {"start": offset + start, "end": offset + end, "text": text.strip(),
               "speaker": "Speaker unresolved", "speakerAttribution": "unresolved",
               "speakerAssignment": "unresolved-no-diarization", "speakerConfidence": 0,
               "timestampSource": "model"}
        words = segment.get("words")
        if words is not None:
            # Word alignment is optional. A bad token boundary must not discard
            # valid segment text/timing, nor be clamped into invented alignment.
            valid_words = isinstance(words, list) and bool(words)
            validated = []
            word_previous = start
            for word in words if valid_words else []:
                if not isinstance(word, dict):
                    valid_words = False
                    break
                left, right = word.get("start"), word.get("end")
                if (not isinstance(left, (int, float)) or isinstance(left, bool)
                        or not isinstance(right, (int, float)) or isinstance(right, bool)
                        or not math.isfinite(left) or not math.isfinite(right)
                        or left < word_previous or left < start or right <= left or right > end
                        or not isinstance(word.get("word"), str) or not word["word"].strip()):
                    valid_words = False
                    break
                validated.append({"start": offset + left, "end": offset + right, "word": word["word"]})
                word_previous = left
            if valid_words:
                row["words"] = validated
            else:
                row["wordTimestampStatus"] = "unavailable-invalid-model-output"
        rows.append(row)
        previous = start
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", choices=MODELS, required=True)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--worker-dir", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--site-dir")
    parser.add_argument("--model-version")
    args = parser.parse_args()
    root = validate_checkpoint(Path(args.model_dir), args.model)
    output = sys.stdout
    sys.stdout = sys.stderr
    sys.path.insert(0, args.worker_dir)
    from resource_policy import apply_resource_policy
    policy = apply_resource_policy()
    if args.site_dir:
        site = Path(args.site_dir).resolve(strict=True)
        if not site.is_dir():
            raise ValueError("--site-dir must identify the prepared Photon runtime")
        sys.path.insert(0, str(site))
    # Set before any HF-dependent imports, including imports made by Photon.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    import torch
    threads = max(1, int(policy.get("threads", 1)))
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    if not torch.cuda.is_available():
        raise RuntimeError("Photon ASR requires a working CUDA GPU; CPU fallback is disabled")
    import moondream as md
    import soundfile as sf
    if args.model not in md.photon_models():
        raise RuntimeError("Installed Photon runtime does not register selected ASR model")
    started = time.monotonic()
    rows = []
    languages = set()
    with normalized_audio(args.audio) as normalized, sf.SoundFile(normalized) as audio:
        rate = audio.samplerate
        frame_count = len(audio)
        frame_windows(frame_count, rate, 30.0)  # Shared duration envelope; bounded inference below.
        windows = silence_aware_windows(audio, rate, 30.0)
        with md.photon(args.model, device="cuda", model_path=str(root), max_batch_size=1,
                       # Qwen reserves page zero and admits up to 4096 output tokens
                       # plus its prompt. Keep a bounded cache with that headroom.
                       single_pass_batch_capacity=1, kv_cache_pages=8192, cpu_threads=threads) as speech:
            if not speech.supports("transcribe"):
                raise RuntimeError("Photon model does not advertise transcription")
            with tempfile.TemporaryDirectory(prefix="hidock-photon-") as directory:
                chunk = Path(directory) / "chunk.wav"
                for left, right in windows:
                    audio.seek(left)
                    sample = audio.read(right - left, dtype="float32", always_2d=False)
                    if len(sample) != right - left:
                        raise ValueError("Normalized audio is truncated")
                    if not has_nonzero_samples(sample):
                        continue
                    sf.write(chunk, sample, rate, subtype="PCM_16")
                    options = {"audio": chunk, "timestamps": "word" if args.model == ULTRA else "segment"}
                    if args.model == QWEN and args.language != "auto":
                        options["language"] = args.language
                    result = speech.transcribe(**options)
                    translated = translate_segments(result, left / rate, (right - left) / rate)
                    if args.model == QWEN:
                        # Qwen's segment mode reports the input window, not forced alignment.
                        for row in translated:
                            row["timestampSource"] = "audio-window"
                    rows.extend(translated)
                    language = result.get("language")
                    if isinstance(language, str) and language:
                        languages.add(language)
    manifest = json.loads((root / "hidock-manifest.json").read_text(encoding="utf-8"))
    result = {"model": args.model, "modelVersion": args.model_version or manifest["revision"],
              "runtimeVersion": md.__version__, "device": "cuda", "deviceName": torch.cuda.get_device_name(0),
              "resourcePolicy": policy, "runtimeThreads": threads,
              "language": next(iter(languages)) if len(languages) == 1 else "auto",
              "requestedLanguage": args.language, "segments": rows,
              "text": " ".join(row["text"] for row in rows),
              "timestampSource": "model" if args.model == ULTRA else "audio-window",
              "streaming": False, "wallSeconds": time.monotonic() - started}
    output.write(json.dumps(result, ensure_ascii=True, allow_nan=False) + "\n")
    output.flush()


if __name__ == "__main__":
    main()
