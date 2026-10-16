"""Native file diarization with bounded execution and recording-local speakers.

v0.2.0 app/diarize.cpp emits one-based speaker IDs and no voice embeddings.
Keep the full recording in one native invocation so speaker cache continuity is
not silently lost at artificial window boundaries. The native CLI reads the WAV
into memory; duration validation and the inherited Windows Job cap bound that.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys
import time
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nemotron_asr_worker import run_cli
from parakeet_worker import MAX_AUDIO_SECONDS, normalized_audio
from prepare_nemotron_asr import VERSION, digest
from prepare_nemotron_diarization import (
    MODEL, MODEL_FILE, MODEL_SHA, MODEL_SIZE, REVISION, runtime_executable,
)

# Pinned NeMo-Speech.cpp v0.2.0: sortformer_model.h documents V3's native
# 10 ms output grid; diar_pipeline.cpp::finish releases right-padded frames,
# and diar_segments_from_probs ends open speech at n_frames * sec_per_frame.
# app/diarize.cpp serializes those boundaries to three decimal places.
# https://github.com/NVIDIA/NeMo-Speech.cpp/blob/v0.2.0/src/asr/diar/diar_pipeline.cpp
NATIVE_FRAME_SECONDS = 0.010
JSON_ROUNDING_SECONDS = 0.0005


def invalid_segment(index: int, segment: object, duration: float) -> ValueError:
    """Expose bounded numeric evidence without audio paths or arbitrary native text."""
    details: dict = {'index': index, 'duration': duration, 'segmentType': type(segment).__name__}
    if isinstance(segment, dict):
        for key in ('start', 'end', 'speaker'):
            value = segment.get(key)
            details[key + 'Type'] = type(value).__name__
            details[key] = value if type(value) in (int, float) and math.isfinite(value) else None
        if type(segment.get('end')) in (int, float) and math.isfinite(segment['end']):
            details['endMinusDuration'] = segment['end'] - duration
    return ValueError('Invalid native diarization segment; diagnostics=' + json.dumps(details, allow_nan=False))


def translate_result(result: dict, duration: float) -> dict:
    """Validate native time ranges, retain overlap, and never invent voiceprints."""
    if not math.isfinite(duration) or duration <= 0 or duration > MAX_AUDIO_SECONDS:
        raise ValueError("Diarization requires audio between zero and six hours")
    if not isinstance(result, dict) or not isinstance(result.get("segments"), list):
        raise ValueError("Native diarization omitted segments")
    rows = []
    by_speaker: dict[str, list[tuple[float, float]]] = {}
    for index, segment in enumerate(result["segments"]):
        if not isinstance(segment, dict):
            raise invalid_segment(index, segment, duration)
        start, end, speaker = (segment.get(key) for key in ("start", "end", "speaker"))
        if (type(start) not in (int, float) or type(end) not in (int, float)
                or not math.isfinite(start) or not math.isfinite(end)
                or start < 0 or start >= duration or end <= start
                or end - duration > NATIVE_FRAME_SECONDS + JSON_ROUNDING_SECONDS + 1e-9
                or type(speaker) is not int or not 1 <= speaker <= 8):
            raise invalid_segment(index, segment, duration)
        label = f"SPEAKER_{speaker - 1:02d}"
        row = {"start": start, "end": min(end, duration), "speaker": label}
        if end > duration:
            row.update({"nativeEnd": end, "timestampSource": "native-frame-grid-intersected-with-audio",
                        "timingAdjustment": {"reason": "padded-final-frame", "endTrimSeconds": end - duration,
                                             "frameSeconds": NATIVE_FRAME_SECONDS,
                                             "serializationRoundingSeconds": JSON_ROUNDING_SECONDS}})
        end = row["end"]
        rows.append(row)
        by_speaker.setdefault(label, []).append((start, end))
    rows.sort(key=lambda row: (row["start"], row["end"], row["speaker"]))
    summaries = []
    for label, intervals in sorted(by_speaker.items()):
        # Union per-speaker intervals avoids double-counting overlapping spans.
        speech = 0.0
        left = right = 0.0
        for start, end in sorted(intervals):
            if start > right:
                speech += right - left
                left, right = start, end
            else:
                right = max(right, end)
        summaries.append({"label": label, "speechSeconds": round(speech + right - left, 3)})
    return {"segments": rows, "speakers": [], "diarizationSpeakers": summaries,
            "speakerEmbeddingsAvailable": False, "speakerIdentityScope": "recording",
            "maxSpeakers": 8}


def build_command(executable: Path, model: Path, audio: Path) -> list[str]:
    """Use chunked V3 offline-style preset, NOT full-attention --offline mode."""
    return [str(executable), "diarize", str(audio), "--model", str(model),
            "--device", "cuda:0", "--preset", "v3-offline", "--format", "json",
            "--concurrency", "1", "--no-batching"]


def prepared_model(directory: Path, executable: Path) -> Path:
    """Fail closed for an unprepared or changed model/runtime."""
    manifest = json.loads((directory / "hidock-manifest.json").read_text(encoding="utf-8"))
    model = directory / MODEL_FILE
    expected = {"model": MODEL, "revision": REVISION, "modelSha256": MODEL_SHA,
                "modelBytes": MODEL_SIZE, "runtime": f"NeMo-Speech.cpp/{VERSION}", "provider": "cuda"}
    if (any(manifest.get(key) != value for key, value in expected.items())
            or model.stat().st_size != MODEL_SIZE or digest(model) != MODEL_SHA
            or digest(executable) != manifest.get("executableSha256")):
        raise ValueError("Pinned Nemotron diarization preparation required")
    return model


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", choices=[MODEL], required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--worker-dir", required=True)
    parser.add_argument("--timeout-seconds", type=float, default=1800)
    args = parser.parse_args()
    if not math.isfinite(args.timeout_seconds) or not 1 <= args.timeout_seconds <= 7200:
        raise ValueError("Worker timeout must be between 1 and 7200 seconds")
    sys.path.insert(0, args.worker_dir)
    from resource_policy import apply_resource_policy
    policy = apply_resource_policy()  # Descendant ffmpeg/CLI inherit the Job budget.
    started = time.monotonic()
    executable = runtime_executable(Path(args.runtime_dir))
    model = prepared_model(Path(args.model_dir), executable)
    with normalized_audio(args.audio) as normalized:
        with wave.open(str(normalized), "rb") as audio:
            duration = audio.getnframes() / audio.getframerate()
        # Validate before native CLI loads the entire waveform.
        translate_result({"segments": []}, duration)
        native = run_cli(build_command(executable, model, normalized), timeout=args.timeout_seconds)
        result = translate_result(native, duration)
    result.update({"model": MODEL, "modelVersion": REVISION,
                   "runtimeVersion": f"NeMo-Speech.cpp/{VERSION}", "device": "cuda",
                   "resourcePolicy": policy, "threadBudget": policy.get("threads"),
                   "streaming": False, "recognizerMode": "chunked-file-diarization",
                   "preset": "v3-offline", "audioSeconds": duration,
                   "wallSeconds": time.monotonic() - started})
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
