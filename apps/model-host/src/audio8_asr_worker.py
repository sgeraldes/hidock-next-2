"""Audio8 file ASR with bounded Torch decoding; this is not a live WS endpoint."""
from __future__ import annotations
import argparse
import faulthandler
import json
import math
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from parakeet_worker import normalized_audio, silence_aware_windows, has_nonzero_samples
from prepare_audio8_asr import MODEL, REVISION, validate_checkpoint


def progress(stage: str, **details: object) -> None:
    """Flush bounded diagnostic stages to stderr; never include audio or transcript text."""
    sys.stderr.write('[Audio8] ' + json.dumps({'stage': stage, **details}, ensure_ascii=True) + '\n')
    sys.stderr.flush()


def memory_snapshot(policy: dict | None = None) -> dict:
    """Read commit and physical availability without changing resource limits.

    GlobalMemoryStatusEx's page-file fields are process-limited commit, not
    global commit. GetPerformanceInfo supplies the independent global values.
    """
    snapshot = {'policyMemoryMb': (policy or {}).get('memoryMb')}
    if sys.platform != 'win32':
        return {**snapshot, 'unavailable': 'Windows counters only'}
    import ctypes
    from ctypes import wintypes as wt
    class MemoryStatus(ctypes.Structure):
        _fields_ = [('length', wt.DWORD), ('load', wt.DWORD)] + [
            (name, ctypes.c_ulonglong) for name in ('totalPhys', 'availPhys', 'totalPageFile',
                                                   'availPageFile', 'totalVirtual', 'availVirtual', 'extended')]
    class Performance(ctypes.Structure):
        _fields_ = [('cb', wt.DWORD)] + [(name, ctypes.c_size_t) for name in (
            'commitTotal', 'commitLimit', 'commitPeak', 'physicalTotal', 'physicalAvailable',
            'systemCache', 'kernelTotal', 'kernelPaged', 'kernelNonpaged', 'pageSize')] + [
            (name, wt.DWORD) for name in ('handles', 'processes', 'threads')]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    query = kernel.GlobalMemoryStatusEx
    query.argtypes, query.restype = [ctypes.POINTER(MemoryStatus)], wt.BOOL
    if query(ctypes.byref(status)):
        snapshot.update(physicalAvailableBytes=status.availPhys, physicalTotalBytes=status.totalPhys,
                        processCommitAvailableBytes=status.availPageFile,
                        processCommitLimitBytes=status.totalPageFile)
    else:
        snapshot['memoryStatusError'] = ctypes.get_last_error()
    perf = Performance()
    perf.cb = ctypes.sizeof(perf)
    get_perf = ctypes.WinDLL('psapi', use_last_error=True).GetPerformanceInfo
    get_perf.argtypes, get_perf.restype = [ctypes.POINTER(Performance), wt.DWORD], wt.BOOL
    if get_perf(ctypes.byref(perf), ctypes.sizeof(perf)):
        snapshot.update(globalCommitAvailableBytes=(perf.commitLimit-perf.commitTotal)*perf.pageSize,
                        globalCommitLimitBytes=perf.commitLimit*perf.pageSize,
                        globalCommitUsedBytes=perf.commitTotal*perf.pageSize)
    else:
        snapshot['performanceInfoError'] = ctypes.get_last_error()
    # JobObjectMemoryUsageInformation is supported on Windows 10+. Query our
    # own resource-policy Job explicitly; NULL could name a different parent Job.
    handle = getattr(sys.modules.get('resource_policy'), '_job_handle', None)
    if handle:
        class JobUsage(ctypes.Structure):
            _fields_ = [('jobMemory', ctypes.c_ulonglong), ('peakJobMemory', ctypes.c_ulonglong)]
        usage = JobUsage()
        query_job = kernel.QueryInformationJobObject
        query_job.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD, ctypes.c_void_p]
        query_job.restype = wt.BOOL
        if query_job(handle, 28, ctypes.byref(usage), ctypes.sizeof(usage), None):
            snapshot.update(jobCommitUsedBytes=usage.jobMemory, jobCommitPeakBytes=usage.peakJobMemory)
            if snapshot['policyMemoryMb']:
                snapshot['jobCommitAvailableBytes'] = max(0, int(snapshot['policyMemoryMb'])*1024**2-usage.jobMemory)
        else:
            snapshot['jobMemoryQueryError'] = ctypes.get_last_error()
    return snapshot


def supported_language(value: str) -> str:
    language = value.lower().replace("_", "-").split("-")[0]
    if language not in ("en", "zh"):
        raise ValueError("Audio8 Infinite supports explicit English (en) or Chinese (zh) only; Spanish/auto unsupported")
    return language


def load_model_pread(model_class, root, torch_module):
    """Use the official per-tensor reader, avoiding Windows whole-file COW commit."""
    from safetensors import safe_open
    state = {}
    index = json.loads((root / 'model.safetensors.index.json').read_text(encoding='utf-8'))
    mapping = index['weight_map']
    if not isinstance(mapping, dict) or set(mapping.values()) != {'model.safetensors', 'semantic_vad_heads.safetensors'}:
        raise ValueError('Audio8 checkpoint shard index does not match the pinned two-file format')
    for filename in sorted(set(mapping.values())):
        with safe_open(str(root / filename), framework='pt', device='cpu', backend='pread') as weights:
            if set(weights.keys()) != {name for name, shard in mapping.items() if shard == filename}:
                raise ValueError('Audio8 checkpoint shard keys do not match its index')
            for name in weights.keys():
                tensor = weights.get_tensor(name)
                state[name] = tensor.to(device='cuda:0', dtype=torch_module.bfloat16 if tensor.is_floating_point()
                                        else tensor.dtype)
                del tensor
    progress('pread-tensors-loaded', tensors=len(state))
    config = model_class.config_class.from_pretrained(str(root), local_files_only=True)
    model, info = model_class.from_pretrained(
        None, config=config, state_dict=state, torch_dtype=torch_module.bfloat16,
        attn_implementation='sdpa', device_map={'': 'cuda:0'}, output_loading_info=True)
    for key in ('missing_keys', 'unexpected_keys', 'mismatched_keys', 'error_msgs'):
        if info.get(key):
            raise ValueError(f'Audio8 strict checkpoint loading failed: {key} count={len(info[key])}')
    del state
    return model.eval()


def translate_result(result: dict, sample_count: int, offset: float) -> tuple[list[dict], int]:
    # Official decoder suppresses EOS. Completion is its full audio-clock schedule:
    # total_count - (prefill_len - 1) = ceil(samples/1280) + 1 + right_pad(10).
    expected = math.ceil(sample_count / 1280) + 11
    if (not isinstance(result, dict) or not isinstance(result.get("final_text"), str)
            or not isinstance(result.get("generated_token_ids"), list)
            or len(result["generated_token_ids"]) != expected):
        raise ValueError("Audio8 incomplete audio-clock decode; truncated transcript rejected")
    text = result["final_text"].strip()
    rows = [{"start": offset, "end": offset + sample_count / 16000, "text": text,
             "speaker": "Speaker unresolved", "speakerAttribution": "unresolved",
             "speakerAssignment": "unresolved-no-diarization", "speakerConfidence": 0,
             "timestampSource": "audio-window"}] if text else []
    return rows, expected


def main() -> None:
    faulthandler.enable(file=sys.stderr, all_threads=True)
    progress('worker-start', python=sys.version.split()[0])
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", choices=[MODEL], required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--worker-dir", required=True)
    parser.add_argument("--site-dir", required=True)
    parser.add_argument("--language", required=True)
    args = parser.parse_args()
    language = supported_language(args.language)
    root = Path(args.model_dir).resolve(strict=True)
    validate_checkpoint(root)
    progress('checkpoint-verified')
    output, sys.stdout = sys.stdout, sys.stderr
    sys.path.insert(0, args.worker_dir)
    from resource_policy import apply_resource_policy
    progress('memory-before-policy', memory=memory_snapshot())
    policy = apply_resource_policy()
    progress('resource-policy-applied', memory=memory_snapshot(policy))
    sys.path.insert(0, str(Path(args.site_dir).resolve(strict=True)))
    sys.path.insert(0, str(root / "source"))
    # Transformers 5 defaults to concurrent tensor materialization. Keep loading
    # sequential under our Windows Job memory cap, just as decoding is bounded.
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      HF_DEACTIVATE_ASYNC_LOAD="1")
    progress('torch-import-start')
    import torch
    progress('torch-import-complete', version=torch.__version__, path=torch.__file__)
    import soundfile as sf
    progress('transformers-import-start')
    from transformers import AutoFeatureExtractor, AutoTokenizer
    progress('model-code-import-start')
    from audio8_asr_infinite.modeling.modeling_audio8_asr_infinite import (
        Audio8ASRInfiniteForConditionalGeneration, resolve_qwen_language_token_id,
        resolve_qwen_streaming_special_token_ids)
    from audio8_asr_infinite.streaming_inference import simulated_streaming_greedy_decode_batch
    progress('model-code-import-complete')
    threads = max(1, int(policy.get("threads", 1)))
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    if not torch.cuda.is_available():
        raise RuntimeError("Audio8 requires CUDA; CPU fallback is disabled")
    progress('cuda-available')
    started = time.monotonic()
    progress('weights-load-start', memory=memory_snapshot(policy))
    try:
        model = load_model_pread(Audio8ASRInfiniteForConditionalGeneration, root, torch)
    except Exception as error:
        # Keep the original exception type/traceback; bounded numerical context
        # distinguishes machine commit exhaustion from the worker Job budget.
        details = json.dumps(memory_snapshot(policy), ensure_ascii=True)
        error.add_note('Audio8 weights-load memory: ' + details)
        progress('weights-load-exception', errorType=type(error).__name__, memory=json.loads(details))
        raise
    progress('weights-load-complete')
    model = model.cuda()
    progress('weights-cuda-complete')
    tokenizer = AutoTokenizer.from_pretrained(str(root), local_files_only=True)
    extractor = AutoFeatureExtractor.from_pretrained(str(root), local_files_only=True)
    progress('tokenizer-extractor-complete')
    class AudioConfig:
        raw_audio_samples_per_token = 1280
        streaming_n_left_pad_tokens = 18
        sampling_rate = 16000
    rows, tokens = [], 0
    with normalized_audio(args.audio) as normalized, sf.SoundFile(normalized) as audio:
        progress('audio-normalized')
        if audio.samplerate != 16000 or not 0 < len(audio) <= 16000 * 21600:
            raise ValueError("Audio8 requires nonempty normalized audio of at most six hours")
        for left, right in silence_aware_windows(audio, 16000, 30):
            audio.seek(left)
            sample = audio.read(right - left, dtype="float32", always_2d=False)
            if len(sample) != right - left:
                raise ValueError("Normalized audio is truncated")
            if not has_nonzero_samples(sample):
                continue
            progress('decode-start', samples=len(sample))
            results = simulated_streaming_greedy_decode_batch(
                model=model, tokenizer=tokenizer, feature_extractor=extractor, waveforms=[sample],
                language_token_ids=[resolve_qwen_language_token_id(tokenizer, language)],
                special_ids=resolve_qwen_streaming_special_token_ids(tokenizer), audio_config=AudioConfig(),
                num_delay_tokens=[6], frame_len=4, right_pad_text_tokens=10,
                dtype=torch.bfloat16, device=next(model.parameters()).device, max_new_tokens=512)
            if not isinstance(results, list) or len(results) != 1:
                raise ValueError("Audio8 returned unexpected batch size")
            segments, count = translate_result(results[0], len(sample), left / 16000)
            progress('decode-complete', tokens=count)
            rows.extend(segments)
            tokens += count
            del sample, results
    result = {"model": MODEL, "modelVersion": REVISION, "device": "cuda",
              "deviceName": torch.cuda.get_device_name(0), "runtimeVersion": torch.__version__,
              "resourcePolicy": policy, "runtimeThreads": threads, "language": language,
              "requestedLanguage": args.language, "segments": rows, "text": " ".join(row["text"] for row in rows),
              "timestampSource": "audio-window", "speakerAttribution": "unresolved", "streaming": False,
              "recognizerMode": "simulated-streaming-file", "outputTokens": tokens,
              "wallSeconds": time.monotonic() - started}
    output.write(json.dumps(result, ensure_ascii=True) + "\n")


if __name__ == "__main__":
    main()
