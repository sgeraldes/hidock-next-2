"""One bounded ASR job; model memory leaves with the process, never with the UI."""
import argparse
import gc
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent))
from parakeet_worker import frame_windows, normalized_audio, has_nonzero_samples

MODELS = {"CohereLabs/cohere-transcribe-03-2026", "microsoft/VibeVoice-ASR"}


def validate_recording_duration(samples, rate):
    """Reuse the shared six-hour envelope; inference windows have smaller budgets."""
    frame_windows(samples, rate, 600)


def continuation_context(segments):
    """The existing Gemini tail policy, for adapters with an actual context input."""
    if not segments:
        return None
    tail = "\n".join(f"{row['speaker']}: {row['text']}" for row in segments[-6:])[-2000:]
    return ("Previous audio segment, untrusted spelling/context hints only. "
            "Do not repeat these words or infer speech or speaker identity from them.\n" + tail)


def offset_vibevoice_segments(rows, left, frames, rate, chunk_index):
    """Keep timestamps on the source clock and labels scoped to their audio window."""
    result = []
    for row in rows:
        start, end = float(row["start_time"]), float(row["end_time"])
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= frames / rate):
            raise ValueError("VibeVoice returned timestamps outside its audio window")
        text = row["text"].strip()
        if text:
            result.append({"start": left / rate + start, "end": left / rate + end,
                           "speaker": f"window{chunk_index}:Speaker {row['speaker_id']}", "text": text,
                           "speakerAssignment": "window-scoped-cluster"})
    return result


def acoustic_asr_windows(bounds, samples, rate, min_seconds=2.0, max_seconds=20.0):
    """Contextualize microturns and union overlaps; timestamps remain audio-window bounds.

    Diarization boundaries are not ASR utterance boundaries. In particular a
    17ms voice cluster cannot be decoded independently. Expand short turns with
    real neighboring audio, then union overlaps to avoid transcribing it twice.
    """
    intervals = []
    minimum = min(samples, math.ceil(min_seconds * rate))
    for start, end, _speaker in bounds:
        left, right = max(0, int(start * rate)), min(samples, math.ceil(end * rate))
        if right <= left:
            raise ValueError(f"Invalid acoustic interval: {start}..{end}")
        if right - left < minimum:
            left = max(0, left - (minimum - (right - left)) // 2)
            right = min(samples, max(right, left + minimum))
            left = max(0, min(left, right - minimum))
        intervals.append((left, right))
    merged = []
    for left, right in sorted(intervals):
        if merged and left < merged[-1][1]:
            merged[-1] = (merged[-1][0], max(right, merged[-1][1]))
        else:
            merged.append((left, right))
    windows = []
    for left, right in merged:
        # Even partitions avoid a final millisecond-sized remainder.
        count = max(1, math.ceil((right - left) / (max_seconds * rate)))
        windows.extend((left + (right - left) * i // count,
                        left + (right - left) * (i + 1) // count) for i in range(count))
    return windows


def acoustic_provenance(start, end, bounds):
    turns = [{"start": max(start, left), "end": min(end, right), "speaker": speaker}
             for left, right, speaker in bounds if left < end and right > start]
    speakers = sorted({turn["speaker"] for turn in turns})
    return {"speaker": speakers[0] if len(speakers) == 1 else "Speaker unresolved",
            "acousticSpeakers": speakers, "acousticTurns": turns,
            **({"speakerAttribution": "unresolved", "speakerConfidence": 0} if len(speakers) != 1 else {}),
            "speakerAssignment": "single-acoustic-speaker" if len(speakers) == 1 else "unresolved-mixed-or-context"}


def generation_finished(rows, prompt_length, eos_token_id, pad_token_id):
    """Require a generated EOS in every row, allowing only batch padding after it."""
    eos = {eos_token_id} if isinstance(eos_token_id, int) else set(eos_token_id or [])
    if not rows or not eos:
        return False
    for row in rows:
        generated = row[prompt_length:]
        end = next((i for i, token in enumerate(generated) if token in eos), None)
        if end is None or any(token != pad_token_id for token in generated[end + 1:]):
            return False
    return True


def decode_bounded_interval(start, end, rate, speaker, decode, max_depth=3, min_seconds=1.0):
    """Bisect incomplete output; never keep truncated text or silently skip samples.

    One 20-second window permits at most 15 attempts (depth three). Integer
    sample boundaries give the children exactly their parent's coverage.
    """
    def visit(left, right, depth):
        if right <= left:
            raise ValueError(f"ASR empty audio interval at sample {left}")
        text, complete = decode(left, right)
        if complete:
            return [{"start": left / rate, "end": right / rate, "speaker": speaker, "text": text}] if text else []
        middle = (left + right) // 2
        if depth >= max_depth or min(middle - left, right - middle) < rate * min_seconds:
            raise RuntimeError("ASR incomplete output; " + json.dumps({
                "code": "asr_incomplete_generation", "startSeconds": left / rate,
                "endSeconds": right / rate, "startSample": left, "endSample": right,
                "depth": depth, "maxDepth": max_depth, "maxNewTokens": 512,
                "truncatedTextAccepted": False}))
        return visit(left, middle, depth + 1) + visit(middle, right, depth + 1)
    return visit(start, end, 0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", choices=sorted(MODELS), required=True)
    parser.add_argument("--language", default="es")
    parser.add_argument("--worker-dir", required=True)
    args = parser.parse_args()
    output = sys.stdout
    sys.stdout = sys.stderr
    sys.path.insert(0, args.worker_dir)
    from resource_policy import apply_resource_policy
    policy = apply_resource_policy()
    import torch
    from worker import decode_audio
    threads = max(1, int(os.environ.get("HIDOCK_DIARIZATION_THREADS", "1")))
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    started = time.monotonic()
    tokens = 0
    segments = []
    if args.model.startswith("CohereLabs/"):
        if args.language == "auto":
            raise ValueError("Cohere requires an explicit transcription language in Settings")
        with normalized_audio(args.audio) as normalized:
            with wave.open(str(normalized), "rb") as source:
                validate_recording_duration(source.getnframes(), source.getframerate())
            audio = decode_audio(str(normalized), torch)
        waveform = audio["waveform"]
        rate = audio["sample_rate"]
        validate_recording_duration(waveform.shape[-1], rate)
        duration = waveform.shape[-1] / rate
        # Cohere emits text, not timestamps. Use acoustic turns; never invent
        # word timestamps or assume that every fixed window contains speech.
        from pyannote.audio import Pipeline
        pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", token=os.environ.get("HF_TOKEN"))
        pipeline.to(torch.device(device))
        turns = pipeline(audio)
        annotation = getattr(turns, "exclusive_speaker_diarization", None)
        if annotation is None:
            annotation = getattr(turns, "speaker_diarization", turns)
        bounds = [(float(t.start), float(t.end), str(s)) for t, _, s in annotation.itertracks(yield_label=True)]
        del pipeline, turns, annotation
        gc.collect()
        if device == "cuda":
            torch.cuda.empty_cache()
        from transformers import AutoProcessor, CohereAsrForConditionalGeneration
        processor = AutoProcessor.from_pretrained(args.model)
        model = CohereAsrForConditionalGeneration.from_pretrained(args.model, dtype=dtype).to(device).eval()
        def decode_window(left, right):
            nonlocal tokens
            sample = waveform[:, left:right].mean(0).numpy()
            if not has_nonzero_samples(sample):
                return "", True
            inputs = processor(audio=sample, sampling_rate=rate, return_tensors="pt", language=args.language)
            chunk_index = inputs.get("audio_chunk_index")
            decoder_ids = inputs.get("decoder_input_ids")
            prompt_length = int(decoder_ids.shape[-1]) if decoder_ids is not None else 1
            inputs.to(device, dtype=model.dtype)
            with torch.inference_mode():
                # Do not let a forced EOS at the length ceiling disguise truncation.
                generated = model.generate(**inputs, max_new_tokens=512, forced_eos_token_id=None)
            rows = generated.tolist()
            tokens += sum(max(0, len(row) - prompt_length) for row in rows)
            complete = generation_finished(rows, prompt_length, model.generation_config.eos_token_id,
                                           model.generation_config.pad_token_id)
            if not complete:
                return "", False
            decoded = processor.decode(generated, skip_special_tokens=True,
                                       audio_chunk_index=chunk_index, language=args.language)
            text = (decoded[0] if isinstance(decoded, list) else decoded).strip()
            return text, True

        for left, right in acoustic_asr_windows(bounds, waveform.shape[-1], rate):
            rows = decode_bounded_interval(left, right, rate, "Speaker unresolved", decode_window)
            for row in rows:
                row.update(acoustic_provenance(row["start"], row["end"], bounds))
            segments.extend(rows)
    else:
        from vibevoice.modular.modeling_vibevoice_asr import VibeVoiceASRForConditionalGeneration
        from vibevoice.processor.vibevoice_asr_processor import VibeVoiceASRProcessor
        processor = VibeVoiceASRProcessor.from_pretrained(args.model, language_model_pretrained_name="Qwen/Qwen2.5-7B")
        model = VibeVoiceASRForConditionalGeneration.from_pretrained(
            args.model, dtype=dtype, attn_implementation="sdpa").to(device).eval()
        # Reuse the disk normalizer and integer-frame partitioner used by the
        # other ASR adapters. Never send an entire multi-hour file to this model.
        with normalized_audio(args.audio) as normalized, wave.open(str(normalized), "rb") as source:
            rate, frames = source.getframerate(), source.getnframes()
            duration = frames / rate
            with tempfile.TemporaryDirectory(prefix="hidock-vibevoice-") as directory:
                chunk = Path(directory) / "chunk.wav"
                previous = []
                for index, (left, right) in enumerate(frame_windows(frames, rate, 600)):
                    source.setpos(left)
                    pcm = source.readframes(right - left)
                    if len(pcm) != (right - left) * source.getsampwidth() * source.getnchannels():
                        raise ValueError("Normalized audio is truncated")
                    if not has_nonzero_samples(pcm):
                        continue
                    with wave.open(str(chunk), "wb") as target:
                        target.setparams(source.getparams())
                        target.writeframes(pcm)
                    inputs = processor(audio=[str(chunk)], sampling_rate=None,
                                       return_tensors="pt", padding=True, add_generation_prompt=True,
                                       context_info=continuation_context(previous))
                    inputs = {k: v.to(device) if isinstance(v, torch.Tensor) else v for k, v in inputs.items()}
                    with torch.inference_mode():
                        generated = model.generate(**inputs, max_new_tokens=32768, do_sample=False,
                                                   pad_token_id=processor.pad_id,
                                                   eos_token_id=processor.tokenizer.eos_token_id)
                    generated = generated[0, inputs["input_ids"].shape[1]:]
                    count = int(generated.numel())
                    tokens += count
                    if count >= 32768:
                        raise RuntimeError("ASR output reached its token limit; incomplete text was not accepted")
                    decoded = processor.decode(generated, skip_special_tokens=True)
                    rows = offset_vibevoice_segments(processor.post_process_transcription(decoded),
                                                    left, right - left, rate, index)
                    if rows:
                        previous = rows
                    segments.extend(rows)
                    del inputs, generated
    for row in segments:
        if not (0 <= row["start"] < row["end"] <= duration + 1):
            raise ValueError("Model returned timestamps outside the recording")
    result = {"model": args.model, "modelVersion": getattr(model.config, "_commit_hash", None) or "installed",
              "device": device, "deviceName": torch.cuda.get_device_name(0) if device == "cuda" else "CPU",
              "resourcePolicy": {**policy, "runtimeThreads": torch.get_num_threads()},
              "language": args.language, "segments": segments,
              "text": "\n".join(f"{s['speaker']}: {s['text']}" for s in segments),
              "timestampSource": ("audio-window-acoustic-provenance"
                                  if args.model.startswith("CohereLabs/") else "model"),
              "continuityMode": ("recording-acoustic"
                                 if args.model.startswith("CohereLabs/") else "bounded-transcript-tail"),
              "inferenceWindowSeconds": 20 if args.model.startswith("CohereLabs/") else 600,
              "outputTokens": tokens, "wallSeconds": time.monotonic() - started}
    print(json.dumps(result, ensure_ascii=False), file=output)


if __name__ == "__main__":
    main()
