"""Word timestamps from Parakeet TDT for a short section of a recording.

HiDock's "Fix times" sends only the audio of the lines it wants to place and
matches the words itself. This worker reuses the Parakeet adapter's bounded
decoding, silence-aware windows and model loading (parakeet_worker.py is not
changed: its contents are part of every ASR readiness fingerprint) and returns
each word with the time its first token starts and its last token ends.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time

from parakeet_worker import (ARTIFACT, MODEL, has_nonzero_samples, make_recognizer, model_files,
                             normalized_audio, silence_aware_windows)

BOUNDARY = "\u2581"
# A section is at most 15 minutes plus padding in HiDock; anything longer is not a section.
MAX_ALIGN_SECONDS = 20 * 60
# A token with no duration (no TDT durations from this sherpa build) is given this long.
LAST_TOKEN_SECONDS = 0.08


def check_duration(frames: int, rate: int) -> None:
    if frames <= 0 or rate <= 0:
        raise ValueError("Audio must have a positive duration and sample rate")
    if frames > rate * (MAX_ALIGN_SECONDS + 1):
        raise ValueError("Alignment accepts at most twenty minutes of audio per job")


def _has_letters(text: str) -> bool:
    return any(ch.isalnum() for ch in text)


def words_from_tokens(tokens, timestamps, durations, offset: float, limit: float) -> list[dict]:
    """Join sentencepiece tokens into words. Times move by offset and stay at or under limit."""
    if len(tokens) != len(timestamps):
        raise ValueError("Recognizer returned tokens and timestamps of different lengths")
    has_durations = len(durations) == len(tokens) and any(d > 0 for d in durations)
    words: list[dict] = []
    current = None
    for i, token in enumerate(tokens):
        start = offset + float(timestamps[i])
        if has_durations:
            end = start + max(0.0, float(durations[i]))
        elif i + 1 < len(tokens):
            end = offset + float(timestamps[i + 1])
        else:
            end = start + LAST_TOKEN_SECONDS
        text = token.replace(BOUNDARY, "")
        if current is None or token.startswith(BOUNDARY):
            if current is not None:
                words.append(current)
            current = {"word": text, "start": start, "end": end}
        else:
            current["word"] += text
            current["end"] = max(current["end"], end)
    if current is not None:
        words.append(current)
    result = []
    for word in words:
        if not _has_letters(word["word"]):
            continue
        start = min(word["start"], limit)
        end = min(max(word["end"], start + 0.01), limit)
        result.append({"word": word["word"].strip(), "start": round(start, 3), "end": round(max(end, start), 3)})
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--worker-dir", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--site-dir")
    args = parser.parse_args()
    files = model_files(Path(args.model_dir), MODEL)
    output = sys.stdout
    sys.stdout = sys.stderr
    sys.path.insert(0, args.worker_dir)
    from resource_policy import apply_resource_policy
    policy = apply_resource_policy()
    threads = max(1, int(policy.get("threads", 1)))
    if args.site_dir:
        site_dir = Path(args.site_dir).resolve(strict=True)
        sys.path.insert(0, str(site_dir))
    import numpy as np
    import sherpa_onnx
    import soundfile as sf
    started = time.monotonic()
    words: list[dict] = []
    with normalized_audio(args.audio) as normalized, sf.SoundFile(normalized) as audio:
        rate = audio.samplerate
        if rate != 16000:
            raise ValueError("Alignment requires normalized 16000 Hz audio")
        total = len(audio)
        check_duration(total, rate)
        recognizer = make_recognizer(sherpa_onnx, MODEL, files, threads)
        for left, right in silence_aware_windows(audio, rate, 30.0):
            audio.seek(left)
            samples = audio.read(right - left, dtype="float32", always_2d=True)
            if len(samples) != right - left or not np.isfinite(samples).all():
                raise ValueError("Audio decoding returned truncated or non-finite samples")
            if not has_nonzero_samples(samples):
                continue
            stream = recognizer.create_stream()
            stream.accept_waveform(rate, samples.mean(axis=1))
            recognizer.decode_stream(stream)
            res = stream.result
            words.extend(words_from_tokens(list(getattr(res, "tokens", []) or []), list(getattr(res, "timestamps", []) or []),
                                           list(getattr(res, "durations", []) or []), left / rate, right / rate))
            del stream, samples
    result = {"model": MODEL, "modelVersion": ARTIFACT + "/sherpa-onnx-" + sherpa_onnx.__version__,
              "device": "cpu", "deviceName": "CPU", "resourcePolicy": policy, "runtimeThreads": threads,
              "audioSeconds": total / rate, "timestampSource": "parakeet-tdt-token",
              "words": words, "wallSeconds": time.monotonic() - started}
    output.write(json.dumps(result, ensure_ascii=True, allow_nan=False) + "\n")
    output.flush()


if __name__ == "__main__":
    main()
