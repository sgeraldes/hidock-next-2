"""Bounded native Windows/CPU Parakeet and Qwen ASR through sherpa-onnx.

This offline adapter deliberately does not advertise streaming or speaker identity.
Input windows are streamed from disk, not decoded into one hour-sized tensor.
Model downloads belong to preparation, never to an inference request.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sys
import time
import shutil
import subprocess
import tempfile
from contextlib import contextmanager

MODEL = "nvidia/parakeet-tdt-0.6b-v3"
ARTIFACT = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
MODEL_FILES = ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")
QWEN_MODEL = "Qwen/Qwen3-ASR-0.6B"
QWEN_ARTIFACT = "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25"
MAX_AUDIO_SECONDS = 6 * 60 * 60


def has_nonzero_samples(samples):
    """Exact digital silence only; even one minimum-amplitude sample is retained."""
    return bool(samples.any()) if hasattr(samples, "any") else any(samples)
QWEN_FILES = ("conv_frontend.onnx", "encoder.int8.onnx", "decoder.int8.onnx",
              "tokenizer/vocab.json", "tokenizer/merges.txt", "tokenizer/tokenizer_config.json")
LANGUAGES = {"auto", "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu",
             "it", "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk"}


def model_files(directory: Path, model: str = MODEL) -> dict[str, str]:
    """Resolve only an explicitly prepared model directory; never fetch weights."""
    if model not in (MODEL, QWEN_MODEL):
        raise ValueError("Unsupported sherpa ASR model: " + model)
    files = {name: directory / name for name in (MODEL_FILES if model == MODEL else QWEN_FILES)}
    missing = [name for name, path in files.items() if not path.is_file() or path.stat().st_size == 0]
    if missing:
        raise FileNotFoundError("ASR preparation required; missing: " + ", ".join(missing))
    return {name: str(path.resolve()) for name, path in files.items()}


def frame_windows(frames: int, rate: int, max_seconds: float = 30.0) -> list[tuple[int, int]]:
    """Even partitions bound inference memory without an almost-empty last window."""
    if frames <= 0 or rate <= 0 or not math.isfinite(max_seconds) or max_seconds <= 0:
        raise ValueError("Audio must have a positive duration and sample rate")
    if frames > rate * MAX_AUDIO_SECONDS:
        raise ValueError("Remote ASR accepts at most six hours per job")
    count = max(1, math.ceil(frames / (rate * max_seconds)))
    return [(frames * i // count, frames * (i + 1) // count) for i in range(count)]


def result_segment(text: str, start: float, end: float) -> dict | None:
    """Use actual input-window bounds, not fabricated word timings or speakers."""
    text = text.strip()
    if not text:
        return None
    return {"start": start, "end": end, "text": text, "speaker": "Speaker unresolved",
            "speakerAttribution": "unresolved", "speakerConfidence": 0,
            "speakerAssignment": "unresolved-no-diarization", "timestampSource": "audio-window"}


def silence_aware_windows(audio, rate: int, max_seconds: float = 30.0):
    """Prefer quiet 20 ms boundaries; read at most two seconds when choosing a cut.

    All frames are emitted exactly once. Continuous speech still requires a hard
    bounded cut, so these window bounds are not claimed to be word alignment.
    """
    total = len(audio)
    frame_windows(total, rate, max_seconds)  # Validate duration before reading.
    limit = max(1, int(rate * max_seconds))
    left = 0
    while left < total:
        remaining = total - left
        count = math.ceil(remaining / limit)
        right = left + math.ceil(remaining / count)
        if count > 1:
            search = min(2 * rate, (right - left) // 4)
            begin = right - search
            audio.seek(begin)
            samples = audio.read(search, dtype="float32", always_2d=False)
            if len(samples) != search:
                raise ValueError("Normalized audio is truncated")
            width = max(1, rate // 50)
            energies = [(offset, float(sum(float(x) ** 2 for x in samples[offset:offset + width])) / width)
                        for offset in range(0, search - width + 1, width)]
            if energies:
                peak = max(energy for _, energy in energies)
                quiet = [(offset, energy) for offset, energy in energies
                         if energy <= max(1e-7, peak * 0.0225)]
                if quiet:
                    offset, _ = quiet[-1]
                    right = begin + offset + width // 2
        yield left, right
        left = right


def make_recognizer(runtime, model: str, files: dict, threads: int):
    """Construct only the selected family with a bounded CPU execution provider."""
    if model == MODEL:
        return runtime.OfflineRecognizer.from_transducer(
            encoder=files[MODEL_FILES[0]], decoder=files[MODEL_FILES[1]], joiner=files[MODEL_FILES[2]],
            tokens=files[MODEL_FILES[3]], num_threads=threads, sample_rate=16000,
            model_type="nemo_transducer", decoding_method="greedy_search", provider="cpu")
    if model == QWEN_MODEL:
        factory = getattr(runtime.OfflineRecognizer, "from_qwen3_asr", None)
        if factory is None:
            raise RuntimeError("Installed sherpa-onnx lacks Qwen3-ASR; prepare a supported runtime")
        return factory(conv_frontend=files[QWEN_FILES[0]], encoder=files[QWEN_FILES[1]],
                       decoder=files[QWEN_FILES[2]], tokenizer=str(Path(files[QWEN_FILES[3]]).parent),
                       num_threads=threads, sample_rate=16000, provider="cpu",
                       max_total_len=1024, max_new_tokens=512, temperature=1e-6, seed=42)
    raise ValueError("Unsupported sherpa ASR model: " + model)


@contextmanager
def normalized_audio(source: str):
    """Decode to a bounded disk file; ffmpeg remains in the resource-limited job."""
    executable = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
    if not executable:
        raise RuntimeError("FFMPEG_PATH or ffmpeg on PATH is required for ASR normalization")
    with tempfile.TemporaryDirectory(prefix="hidock-asr-") as directory:
        target = Path(directory) / "audio.wav"
        log = Path(directory) / "decode.log"
        # One extra second detects overlong uploads rather than accepting silent truncation.
        command = [executable, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                   "-threads", "1", "-i", str(Path(source).resolve()), "-map", "0:a:0", "-vn",
                   "-filter_threads", "1", "-threads", "1", "-t", str(MAX_AUDIO_SECONDS + 1), "-ac", "1", "-ar", "16000",
                   "-c:a", "pcm_s16le", str(target)]
        with log.open("wb") as errors:
            completed = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=errors, timeout=900, check=False,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if completed.returncode != 0:
            with log.open("rb") as errors:
                detail = errors.read(4096).decode("utf-8", errors="replace")
            raise RuntimeError(f"ASR normalization failed ({completed.returncode}): {detail}")
        yield target


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", choices=[MODEL, QWEN_MODEL], required=True)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--worker-dir", required=True)
    parser.add_argument("--model-dir")
    parser.add_argument("--site-dir")
    parser.add_argument("--provider", choices=["cpu"], default="cpu")
    args = parser.parse_args()
    if args.model == MODEL and args.language not in LANGUAGES:
        raise ValueError("Parakeet TDT v3 does not support requested language: " + args.language)
    # Sherpa's CPU wheel must never be labelled CUDA simply because NVIDIA is present.
    provider = os.environ.get("HIDOCK_PARAKEET_PROVIDER", args.provider)
    if provider != "cpu":
        raise ValueError("This Parakeet adapter currently validates CPU execution only; CUDA is not enabled")
    directory = args.model_dir or os.environ.get("HIDOCK_PARAKEET_MODEL_DIR")
    if not directory:
        raise ValueError("--model-dir must point to the prepared ONNX model")
    files = model_files(Path(directory), args.model)
    output = sys.stdout
    sys.stdout = sys.stderr
    sys.path.insert(0, args.worker_dir)
    from resource_policy import apply_resource_policy
    policy = apply_resource_policy()
    threads = max(1, int(policy.get("threads", 1)))
    if args.site_dir:
        site_dir = Path(args.site_dir).resolve(strict=True)
        if not site_dir.is_dir():
            raise ValueError("--site-dir must be the prepared ONNX runtime directory")
        sys.path.insert(0, str(site_dir))
    # Import native libraries only after the OS budget is enforced.
    import numpy as np
    import sherpa_onnx
    import soundfile as sf
    started = time.monotonic()
    segments = []
    with normalized_audio(args.audio) as normalized, sf.SoundFile(normalized) as audio:
        rate = audio.samplerate
        # HiDock's upload/preparation boundary supplies normalized 16 kHz audio.
        # Reject other rates rather than silently claim resampling or run an unbounded decoder.
        if rate != 16000:
            raise ValueError("Sherpa ASR requires normalized 16000 Hz audio")
        if audio.channels < 1 or audio.channels > 8:
            raise ValueError("Parakeet accepts 1 to 8 audio channels")
        windows = silence_aware_windows(audio, rate, 10.0 if args.model == QWEN_MODEL else 30.0)
        recognizer = make_recognizer(sherpa_onnx, args.model, files, threads)
        for left, right in windows:
            audio.seek(left)
            samples = audio.read(right - left, dtype="float32", always_2d=True)
            if len(samples) != right - left or not np.isfinite(samples).all():
                raise ValueError("Audio decoding returned truncated or non-finite samples")
            if not has_nonzero_samples(samples):
                continue
            stream = recognizer.create_stream()
            stream.accept_waveform(rate, samples.mean(axis=1))
            recognizer.decode_stream(stream)
            if args.model == QWEN_MODEL and len(getattr(stream.result, "tokens", [])) >= 512:
                raise RuntimeError("Qwen ASR reached the generation limit; truncated text rejected")
            segment = result_segment(stream.result.text, left / rate, right / rate)
            if segment:
                segments.append(segment)
            del stream, samples
    artifact = ARTIFACT if args.model == MODEL else QWEN_ARTIFACT
    result = {"model": args.model, "modelVersion": artifact + "/sherpa-onnx-" + sherpa_onnx.__version__,
              "device": "cpu", "deviceName": "CPU", "resourcePolicy": policy, "runtimeThreads": threads,
              "language": "auto", "requestedLanguage": args.language, "languageMode": "automatic-detection",
              "segments": segments, "text": " ".join(row["text"] for row in segments),
              "timestampSource": "audio-window", "streaming": False,
              "wallSeconds": time.monotonic() - started}
    output.write(json.dumps(result, ensure_ascii=True, allow_nan=False) + "\n")
    output.flush()


if __name__ == "__main__":
    main()
