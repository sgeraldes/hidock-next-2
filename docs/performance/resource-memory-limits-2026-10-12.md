# Observed memory limits — 12 October 2026

These are per-worker-tree Windows Job **committed system-memory** ceilings. They are not
preallocated RAM, whole-machine limits, or CUDA VRAM quotas. Worker CPU and thread policies
are separate. A machine with 64 GB RAM does not automatically receive a 64 GB worker budget.

| Location and role | Current maximum | Additional admission constraint |
| --- | --- | --- |
| Client local ASR/speaker worker | 8 GiB | Minimum of ceiling, 25% of total RAM, 50% of free RAM; refuse below 1 GiB |
| GAMESTATION ordinary ASR/diarization worker | 16 GiB | Minimum of ceiling, 25% of total RAM, 50% of free RAM; refuse below 1 GiB (applied in host 0.5.2) |
| GAMESTATION Audio8 worker | 24 GiB | Minimum of ceiling, 37.5% of total RAM, 50% of free RAM; requires at least 20 GiB |
| GAMESTATION native realtime worker | 8 GiB | Minimum of ceiling, 25% of total RAM, 50% of free RAM; requires at least 4 GiB |
| GAMESTATION managed generation worker | 16 GiB | Minimum of ceiling, 25% of total RAM, 50% of free RAM; requires at least 8 GiB |

Source boundaries: `apps/electron/electron/main/services/speaker-linking.ts` (`localModelEnvironment`),
`apps/model-host/src/diarize.mjs` (`workerMemoryMb`),
`apps/model-host/src/realtime-native-runtime.mjs`, and `apps/model-host/src/generation.mjs`.
The Job implementation is `apps/electron/resources/speaker-linking/resource_policy.py`.
At the earlier 12 October audit, the three host policy modules' SHA256 values matched GAMESTATION's
installed copies. A later ordinary-worker admission fix rejects budgets below 1 GiB rather than inflating
a too-small allowance to a minimum. That guard is now **applied in installed host 0.5.2**; its module hash
matched source. Executing the installed policy locally with synthetic counters rejected zero/tiny budgets
and accepted exactly 1,024 MiB. This does not simulate physical host memory exhaustion. The update retained
eight ASR engines plus semantic/text-generation/realtime readiness, and an actual older-source Parakeet job
completed in 10.117 s with identical text and host idle. The full suite passed 244 tests in 30 files.
[Applied-host report, installer hash and limits](../../.diagnostics/host-052-verification.json).

The 8 GiB client ceiling protected the workstation during isolated CPU execution; the observed
five-minute Cohere run peaked at approximately 5.88 GiB summed process-tree working set.
Working set and committed Job memory are different metrics, and shared pages can be counted twice
in a summed working set. That observation is not proof that every longer recording fits.

The remote realtime 8 GiB ceiling is a conservative validated configuration for the installed
0.6B streaming engine, not a measured optimal limit for the 4090 host. Increasing it without a
workload that requires more memory would not itself accelerate GPU inference. Larger models
need their own load/inference peak, CUDA allocation and teardown measurements, rather than a
single blanket budget inherited from the client.

The host currently serializes admitted heavy workloads. These limits do not establish a configurable
VRAM quota or guarantee sufficient CUDA memory when a game or another program owns the GPU.
A future dedicated-host resource preset must expose separate RAM/CPU and GPU admission policies,
show their effective limits, preserve system headroom, and reject insufficient budgets before work.
Such a preset is not implemented by this documentation change.

Earlier health evidence: `.diagnostics/host-resource-health-20261012.json` returned HTTP 200,
host 0.5.1 ready, RTX 4090 detected, 32 logical processors, no active jobs, approximately
14.5 GiB system RAM used, and service RSS approximately 70.7 MiB. This idle sample is not
a full-load performance or exhaustion test. No resource setting was changed for this audit.


