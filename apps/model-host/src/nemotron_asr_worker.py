"""Bounded file-ASR adapter for NVIDIA's native Windows NeMo-Speech.cpp CLI.

The recognizer streams internally; HiDock's job protocol still returns a file
result and does not expose microphone capture or live partial transcripts.
"""
from __future__ import annotations

import argparse
from array import array
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent))
from parakeet_worker import normalized_audio, silence_aware_windows, has_nonzero_samples
from prepare_nemotron_asr import MODEL, MODEL_FILE, MODEL_SIZE, REVISION, VERSION

LANGUAGES = {"en": "en-US", "es": "es-ES", "fr": "fr-FR", "de": "de-DE", "it": "it-IT",
             "pt": "pt-BR", "ja": "ja-JP", "ko": "ko-KR", "zh": "zh-CN", "ru": "ru-RU"}


class PcmReader:
    """Small stdlib bridge for silence detection over a normalized PCM16 WAV."""
    def __init__(self, source):
        self.source = source
    def __len__(self) -> int:
        return self.source.getnframes()
    def seek(self, position: int) -> None:
        self.source.setpos(position)
    def read(self, count: int, **_kwargs) -> list[float]:
        values = array("h", self.source.readframes(count))
        if sys.byteorder != "little":
            values.byteswap()
        return [value / 32768.0 for value in values]


def run_cli(command: list[str], timeout: float = 300) -> dict:
    """Bound both pipes while the child inherits the Windows Job resource policy."""
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    buffers = [bytearray(), bytearray()]
    overflow = threading.Event()
    def drain(index: int, stream) -> None:
        while chunk := stream.read(4096):
            if len(buffers[index]) + len(chunk) > 2 * 1024 * 1024:
                overflow.set()
                child.kill()
                break
            buffers[index].extend(chunk)
    readers = [threading.Thread(target=drain, args=(index, pipe), daemon=True)
               for index, pipe in enumerate((child.stdout, child.stderr))]
    for reader in readers:
        reader.start()
    try:
        child.wait(timeout=timeout)
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        for reader in readers:
            reader.join(timeout=5)
        child.stdout.close()
        child.stderr.close()
    if overflow.is_set():
        raise RuntimeError("NeMo CLI exceeded bounded output")
    if child.returncode:
        detail = buffers[1][-4096:].decode("utf-8", errors="replace")
        raise RuntimeError(f"NeMo CLI failed ({child.returncode}): {detail}")
    return json.loads(buffers[0].decode("utf-8"))


def translate_result(result: dict, offset: float, duration: float) -> dict | None:
    """Keep native word timestamps; never infer speaker identities."""
    text = result.get("text")
    words = result.get("words")
    if not isinstance(text, str) or not isinstance(words, list):
        raise ValueError("NeMo CLI returned an incomplete transcript")
    if not text.strip():
        return None
    if not words:
        raise ValueError("NeMo CLI omitted requested word timestamps")
    converted = []
    previous = -1.0
    tail_overrun = 0.0
    for index, word in enumerate(words):
        start, end = word.get("start"), word.get("end")
        if (not isinstance(word.get("word"), str) or not isinstance(start, (float, int))
                or not isinstance(end, (float, int)) or not math.isfinite(start) or not math.isfinite(end)
                or start < 0 or end < start or end > duration + 0.5 or start < previous):
            # Numeric-only evidence survives the supervisor's stderr cap without
            # disclosing meeting text. Do not relax validation without this data.
            numeric = lambda value: value if isinstance(value, (float, int)) else type(value).__name__
            raise ValueError("NeMo CLI returned invalid word timestamps: " + json.dumps({
                "index": index, "start": numeric(start), "end": numeric(end),
                "previousStart": previous, "windowDuration": duration,
                "wordCount": len(words), "reportedDuration": numeric(result.get("duration")),
            }))
        previous = start
        tail_overrun = max(tail_overrun, end - duration)
        converted.append({"word": word["word"], "start": offset + start, "end": offset + end})
    if tail_overrun > 0:
        # Observed v0.2.0 streaming output placed its final word 330 ms past
        # a 44.79 s WAV. Preserve recognition text but discard unreliable word
        # alignment for this window. Never clamp invented word times or publish
        # timestamps beyond the actual source audio. Larger errors remain fatal.
        return {"text": text.strip(), "start": offset, "end": offset + duration,
                "speaker": "Speaker unresolved", "speakerAttribution": "unresolved",
                "speakerConfidence": 0, "speakerAssignment": "unresolved-no-diarization",
                "timestampSource": "audio-window", "timingWarning": {
                    "code": "native-word-tail-outside-audio", "tailOverrunSeconds": tail_overrun,
                    "discardedWordTimings": len(converted),
                }}
    segment_end = max(word["end"] for word in converted)
    if segment_end <= converted[0]["start"]:
        raise ValueError("NeMo CLI returned an empty timed segment")
    return {"text": text.strip(), "start": converted[0]["start"], "end": segment_end,
            "words": converted, "speaker": "Speaker unresolved", "speakerAttribution": "unresolved",
            "speakerConfidence": 0, "speakerAssignment": "unresolved-no-diarization",
            "timestampSource": "model-word-timestamps"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", choices=[MODEL], required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--worker-dir", required=True)
    parser.add_argument("--language", default="auto")
    args = parser.parse_args()
    sys.path.insert(0, args.worker_dir)
    from resource_policy import apply_resource_policy
    policy = apply_resource_policy()  # Before ffmpeg/native CLI, descendants inherit the Job.
    directory = Path(args.model_dir)
    manifest = json.loads((directory / "hidock-manifest.json").read_text(encoding="utf-8"))
    model = directory / MODEL_FILE
    if manifest.get("revision") != REVISION or model.stat().st_size != MODEL_SIZE:
        raise ValueError("Pinned Nemotron model preparation required")
    executable = Path(args.runtime_dir) / "nemo-speech-0.2.0-windows-x86_64-cuda" / "bin" / "nemo-speech.exe"
    if not executable.is_file():
        raise ValueError("Prepared NeMo native CUDA executable is missing")
    started = time.monotonic()
    rows = []
    language = LANGUAGES.get(args.language, args.language)
    with normalized_audio(args.audio) as normalized, wave.open(str(normalized), "rb") as audio:
        rate = audio.getframerate()
        with tempfile.TemporaryDirectory(prefix="hidock-nemotron-") as temporary:
            chunk = Path(temporary) / "chunk.wav"
            for left, right in silence_aware_windows(PcmReader(audio), rate, 60):
                audio.setpos(left)
                pcm = audio.readframes(right - left)
                if len(pcm) != (right - left) * 2:
                    raise ValueError("Normalized audio is truncated")
                if not has_nonzero_samples(pcm):
                    continue
                with wave.open(str(chunk), "wb") as destination:
                    destination.setparams((1, 2, rate, 0, "NONE", "not compressed"))
                    destination.writeframes(pcm)
                command = [str(executable), "transcribe", str(chunk), "--model", str(model),
                           "--stream", "--json", "--device", "cuda:0", "--no-batching"]
                if language != "auto":
                    command += ["--language", language]
                result = run_cli(command)
                row = translate_result(result, left / rate, (right - left) / rate)
                if row:
                    rows.append(row)
    print(json.dumps({"model": MODEL, "modelVersion": REVISION, "runtimeVersion": f"NeMo-Speech.cpp/{VERSION}",
                      "device": "cuda", "resourcePolicy": policy, "threadBudget": policy.get("threads"),
                      "streaming": False, "recognizerMode": "streaming-file", "language": args.language,
                      "timingWarningCount": sum("timingWarning" in row for row in rows),
                      "segments": rows, "text": " ".join(row["text"] for row in rows),
                      "wallSeconds": time.monotonic() - started}, ensure_ascii=True))


if __name__ == "__main__":
    main()
