# VAD physical observation summary

This is a read-only summary of the saved observations. No device access or additional experiment was performed for this analysis. The counters below are samples of `lastSuccessfulCallerWord` from the H1E native getter; they do not represent decoded speech.

## Receipts

| Receipt | Samples | SHA-256 |
| --- | ---: | --- |
| `.diagnostics/vad-physical-20261016/vad-idle-baseline.json` | 2 | `36b65464060087034a73a3e693847e032bde53d33f9550c1682fb9ac051992a1` |
| `.diagnostics/vad-physical-20261016/vad-controlled-h1e-speech.json` | 24 | `d7dbe13b5eae9d2ebcb79c3c8107e38417b856346b16dcb64a97fe91d658d383` |
| `.diagnostics/vad-physical-20261016/vad-controlled-h1e-speech-repeat.json` | 140 | `309a2b72910bec3948d4a2de61d9beb9993a1ddfb6e863e4026a8ef3c10b240c` |

## Counts and timing

- Idle baseline: 2/2 samples were raw `0`, 0/2 were raw `1`.
- First controlled playback: 17 samples while playback was not ended gave 16 raw `0` and one raw `1`; the raw `1` was sampled at playback +4.885 s and returned to `0` at +5.431 s. The following 7 samples had `ended=true`, all raw `0`.
- Repeat quiet-before: 20/20 samples were raw `0` over 2.657 s.
- Repeat playback while not ended: 65 samples gave 50 raw `0` and 15 raw `1`. The observations toggled 22 times (11 sampled runs of `1`); the runs occurred at playback offsets +0.564, +0.982..+1.136, +1.414, +1.711..+1.990, +3.391, +4.930, +6.048, +6.330, +7.302..+7.441, +7.719, and +7.999 s. Sample spacing was 137–188 ms, so these are sample times, not exact signal-edge times.
- Repeat playback-ended: playback duration was 9.01356 s. The first `ended=true` observation was 9.138 s after the first playback sample; all 55 ended samples through +16.747 s were raw `0`.

All recorded observations reported `status=ok`, `nativeState=5`, `lastCompletedNativeStatus=0`, and equal attempted/successful read counts. The records also say `imageAttested=false`, `clockBinding=unclocked`, and `dspFreshness`/`voice=unknown`; those fields limit what can be inferred.

## Bounded conclusion

The saved samples show raw-word `1` observations during the selected H1E speech-playback windows, with none in the captured idle baseline, the repeat’s quiet-before window, or either playback-ended interval. This supports a temporal association for these specific trials only. It does not establish ASR or transcript correctness, microphone capture or endpoint routing, an exact threshold/latency, or a universal meaning or polarity for raw `0` and `1`.
