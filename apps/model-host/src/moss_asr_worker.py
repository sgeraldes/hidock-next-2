"""Bounded, offline MOSS CUDA inference with window-scoped speaker evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from asr_worker import generation_finished
from parakeet_worker import normalized_audio, silence_aware_windows, has_nonzero_samples
from prepare_moss_asr import MODEL, REVISION, validate_checkpoint

# Official default prompt from the pinned upstream inference_utils.py.
PROMPT = ("请将音频转写为文本，每一段需以起始时间戳和说话人编号"
          "（[S01]、[S02]、[S03]…）开头，正文为对应的语音内容，"
          "并在段末标注结束时间戳，以清晰标明该段语音范围。")
SEGMENT = re.compile(r"\[(\d+(?:\.\d+)?)\]\s*\[(S\d+)\](.*?)\[(\d+(?:\.\d+)?)\]", re.DOTALL)
UNLABELED_SEGMENT = re.compile(r"\[(\d+(?:\.\d+)?)\](.*?)\[(\d+(?:\.\d+)?)\]", re.DOTALL)


def grammar_error(reason: str, text: str, cursor: int, parsed: int) -> ValueError:
    """Describe structural failure without logging private speech or repairing output."""
    tail = text[cursor:]
    # Only bounded timestamp/speaker grammar markers, never arbitrary bracketed speech.
    markers = re.findall(r'\[(?:S\d{1,4}|\d{1,6}(?:\.\d{1,6})?)\]', tail)
    details = {'characters': len(text), 'parsedSegments': parsed, 'unparsedCharacters': len(tail),
               'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
               'tailGrammarMarkers': markers[-12:], 'tailOpenBrackets': tail.count('['),
               'tailCloseBrackets': tail.count(']')}
    return ValueError(reason + '; structure=' + json.dumps(details, ensure_ascii=True))


def parse_result(text: str, offset: float, duration: float, scope: str) -> list[dict]:
    """Reject unparsed/truncated output rather than silently dropping its tail."""
    rows, cursor = [], 0
    labeled = re.search(r'\[S\d+\]', text) is not None
    pattern = SEGMENT if labeled else UNLABELED_SEGMENT
    for match in pattern.finditer(text):
        if text[cursor:match.start()].strip():
            raise grammar_error("MOSS returned text outside its timestamped segment grammar", text, cursor, len(rows))
        start, end = float(match[1]), float(match[4] if labeled else match[3])
        body = (match[3] if labeled else match[2]).strip()
        if re.search(r'\[S[^\]]*\]|\[\d', body):
            raise grammar_error("MOSS returned mixed or malformed segment grammar", text, cursor, len(rows))
        if not body or not math.isfinite(end) or start < 0 or end <= start or end > duration:
            raise grammar_error("MOSS returned invalid or out-of-audio segment timestamps", text, cursor, len(rows))
        row = {"start": offset + start, "end": offset + end, "text": body,
                     "speaker": "Speaker unresolved", "speakerAttribution": "unresolved",
                     "speakerAssignment": "unresolved-window-scoped-cluster" if labeled else "unresolved-no-model-speaker-label",
                     "speakerConfidence": 0, "timestampSource": "model"}
        if labeled:
            row.update({"modelSpeakerLabel": match[2], "speakerScope": scope})
        else:
            row['diarizationStatus'] = 'unavailable'
        rows.append(row)
        cursor = match.end()
    if text[cursor:].strip():
        raise grammar_error("MOSS returned an incomplete or malformed transcript", text, cursor, len(rows))
    return rows


def diarization_metadata(rows: list[dict]) -> dict:
    missing = sum('modelSpeakerLabel' not in row for row in rows)
    return {'diarizationStatus': 'degraded' if missing else 'window-scoped-clusters',
            'diarizationUnavailableSegments': missing,
            'speakerEmbeddingsAvailable': False}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", choices=[MODEL], required=True)
    parser.add_argument("--worker-dir", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--site-dir", required=True)
    parser.add_argument("--torch-site-dir")
    parser.add_argument("--language", default="auto")
    args = parser.parse_args()
    root = Path(args.model_dir).resolve(strict=True)
    validate_checkpoint(root)
    output, sys.stdout = sys.stdout, sys.stderr
    sys.path.insert(0, args.worker_dir)
    from resource_policy import apply_resource_policy
    policy = apply_resource_policy()
    if args.torch_site_dir:
        sys.path.insert(0, str(Path(args.torch_site_dir).resolve(strict=True)))
    sys.path.insert(0, str(Path(args.site_dir).resolve(strict=True)))
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    import torch
    import soundfile as sf
    import transformers
    from transformers import AutoModelForCausalLM, AutoProcessor
    threads = max(1, int(policy.get("threads", 1)))
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    if not torch.cuda.is_available():
        raise RuntimeError("MOSS requires CUDA; CPU fallback is disabled")
    started = time.monotonic()
    model = AutoModelForCausalLM.from_pretrained(str(root), trust_remote_code=True, local_files_only=True,
                                               dtype=torch.bfloat16, attn_implementation="sdpa")
    model = model.to("cuda").eval()
    processor = AutoProcessor.from_pretrained(str(root), trust_remote_code=True, local_files_only=True)
    messages = [{"role": "user", "content": [{"type": "audio", "audio": "window.wav"},
                                               {"type": "text", "text": PROMPT}]}]
    prompt = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    rows, tokens = [], 0
    with normalized_audio(args.audio) as normalized, sf.SoundFile(normalized) as audio:
        rate = audio.samplerate
        if rate != 16000 or not 0 < len(audio) <= rate * 21600:
            raise ValueError("MOSS requires nonempty normalized audio of at most six hours")
        for index, (left, right) in enumerate(silence_aware_windows(audio, rate, 30.0)):
            audio.seek(left)
            sample = audio.read(right - left, dtype="float32", always_2d=False)
            if len(sample) != right - left:
                raise ValueError("Normalized audio is truncated")
            if not has_nonzero_samples(sample):
                continue
            with torch.inference_mode(), torch.amp.autocast("cuda", dtype=torch.bfloat16):
                inputs = processor(text=prompt, audio=[sample], max_length=8192,
                                   audio_kwargs={"device": "cuda"}, return_tensors="pt").to("cuda")
                prompt_length = inputs["input_ids"].shape[-1]
                generated = model.generate(**{key: inputs[key] for key in (
                    "input_ids", "attention_mask", "input_features", "audio_feature_lengths", "audio_chunk_mapping")},
                    do_sample=False, max_new_tokens=2048)
            ids = generated.tolist()
            if not generation_finished(ids, prompt_length, model.generation_config.eos_token_id,
                                       model.generation_config.pad_token_id):
                raise RuntimeError("MOSS reached its generation bound without EOS; truncated text rejected")
            text = processor.tokenizer.decode(ids[0][prompt_length:], skip_special_tokens=True).strip()
            tokens += len(ids[0]) - prompt_length
            rows.extend(parse_result(text, left / rate, (right - left) / rate, f"window-{index}"))
            del inputs, generated, sample
    result = {"model": MODEL, "modelVersion": REVISION, "device": "cuda",
              "deviceName": torch.cuda.get_device_name(0), "runtimeVersion": transformers.__version__,
              "resourcePolicy": policy, "runtimeThreads": threads, "segments": rows,
              "text": " ".join(row["text"] for row in rows), "timestampSource": "model",
              "speakerAttribution": "unresolved", "streaming": False, "language": "auto",
              "requestedLanguage": args.language, "languageHintApplied": False,
              "outputTokens": tokens, "wallSeconds": time.monotonic() - started}
    result.update(diarization_metadata(rows))
    output.write(json.dumps(result, ensure_ascii=True) + "\n")


if __name__ == "__main__":
    main()
