# Audio8 Windows loading diagnosis

Observed on GAMESTATION, 2026-10-11; Python 3.11, Torch 2.13.0+cu126, Transformers 5.13.0, safetensors 0.8.0, RTX 4090.

The default Transformers loading path failed with Windows access violation `0xc0000005` while materializing tensors. Disabling asynchronous loading did not remove it. Direct CUDA placement exposed error 1455 while opening the safetensors file. Global commit and physical-memory availability remained large, while the worker Job constrained commit. Raising only Audio8's bounded admission from 16 GiB to at most 24 GiB did not fix mmap loading. `disable_mmap=True` then failed in `safe_load_bytes` with a PyO3 null-PyObject panic; that path reads the whole file rather than one tensor at a time.

This matches the mechanism discussed in [Transformers issue 48285](https://github.com/huggingface/transformers/issues/48285): Windows copy-on-write mappings can reserve substantial commit, and whole-file byte loading can duplicate it. That issue is corroborating evidence, not proof that every local crash has an identical root cause. The actual diagnosis rests on the observed stack traces, Job/global-memory counters, and the successful alternative loader.

The replacement uses the official [`safe_open(..., backend="pread")` API](https://github.com/safetensors/safetensors/blob/v0.8.0/bindings/python/py_src/safetensors/__init__.pyi). It reads one tensor at a time and transfers it to CUDA. It uses the pinned checkpoint's official `model.safetensors.index.json` to load **both** `model.safetensors` and `semantic_vad_heads.safetensors`, checking each file's keys against the index. The first trial omitted the second shard and correctly failed the upstream strict missing-key check; it did not initialize substitute VAD weights or suppress the check.

The complete state passes through the official model's `from_pretrained(None, config=..., state_dict=..., output_loading_info=True)` entry point. Missing, unexpected, mismatched, or otherwise erroneous checkpoint keys remain fatal. The upstream loader's own strict validation also remains enabled. No manual safetensors binary parsing, monkey-patching, silent CPU fallback, or unchecked tensor assignment is used.

**Observed boundary:** the complete indexed pread loader passed the host's real spoken-audio preparation test on RTX 4090 at 23:18:13 local. An English 30-clip accuracy batch was then started separately in namespace `audio8-final`; its final results belong to that batch's reports, not this loading smoke test.

Bounds remain Audio8-only: `min(24 GiB, total RAM × 0.375, free RAM × 0.5)`, rejecting below 20 GiB before spawning. Other models retain their original budgets. The first pread trial reported Job peak 19,319,001,088 bytes, configured allowance 24,313 MiB, and global commit available 40,306,335,744 bytes. Those values were sampled during the strict missing-shard failure, not claimed as a maximum for every successful inference.

Original evidence is preserved under `.diagnostics/asr-accuracy/audio8*.txt`, including `audio8-no-mmap-original.txt` and `audio8-pread-single-shard-original.txt`. Tests cover per-shard loading, all strict-error categories, memory-counter consistency, stdout/ASCII safety, language rejection, bounded completion, and checkpoint integrity. These tests support—but do not replace—the observed hardware preparation test.

## Completed English pilot

All 30 FLEURS `en_us` test clips completed successfully through the actual client service boundary, with no replacement characters. Reference IDs and audio hashes match the existing Gemini English baseline; the local audio hashes were independently rechecked. Both use the frozen scorer's NFC/case-fold/punctuation-to-space normalization. CER includes canonical spaces.

| Metric | Audio8 delivered output | Existing Gemini delivered output |
|---|---:|---:|
| Completed / failures | 30 / 0 | 30 / 0 |
| Normalized word errors / reference words | 101 / 642 | 27 / 642 |
| Normalized WER | 15.7321% | 4.2056% |
| Normalized character errors / reference characters | 264 / 3600 | 62 / 3600 |
| Normalized CER | 7.3333% | 1.7222% |

Audio8 client elapsed time summed to 446.440 seconds (median 14.159 seconds per clip); worker time summed to 272.282 seconds. Jobs load the model afresh, so these are not warm streaming latency measurements. Actual reports confirm RTX 4090 CUDA, 24,313 MiB worker allowance and 50% CPU/16-thread policy. This is an English read-speech pilot, not meeting accuracy or Spanish support. It does not justify replacing Gemini with Audio8.

Results: `.diagnostics/asr-client-boundary/accuracy-d6d27b64e0bd-audio8-final/summary-rescored.json`; raw and rescored per-model artifacts are in its `Edge0--Audio8-ASR-Infinite` subdirectory. Baseline: `.diagnostics/asr-gemini-boundary/fleurs-enus/scores.json`. Final health recorded ready, no active jobs, GPU utilization 0%, and 325 MiB GPU memory; host ownership was then released for the next coordinated task.
