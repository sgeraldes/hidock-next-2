# H1E native sample activity correlation — 2026-10-17

**Scope:** offline comparison of the retained 109 CMD29 status responses against the independent channel-level summary from one microphone recording. No device access, new DSP query, app/code change, or firmware change was made for this analysis. This note contains aggregates only; it omits file names, device identity, and audio.

## Observed correlation in this trial

The response field `native.samples` was present and nonempty in all 109 replies. Its shape varied from 1 to 8 integer entries per reply (700 entries total); values ranged from 0 to 29 with 26 distinct values. Across the run, 422 entries were zero and 278 were nonzero.

| Approximate interval by duration value | Captured channel-level context | CMD29 responses | `native.samples` entries |
| --- | --- | ---: | ---: |
| Duration values 1–21, covering the user-reported speech interval | Channel 0 showed activity; maximum one-second-window RMS was −22.69 dB | 56/64 responses had at least one nonzero entry; 8/64 were all-zero | 278/416 nonzero (66.8%); values 0–29 |
| Duration values 22–35, with channel 0 quiet | Channel 0 one-second-window RMS ranged −67.3 to −61.6 dB | 0/42 responses had a nonzero entry | 0/270 nonzero; all entries zero |

The channel-level summary places voice activity on channel 0 in seconds 1–21 and quiet in seconds 22–35. Channel 1 stayed low across the analyzed windows (RMS −67.1 to −64.7 dB). In this one trial, nonzero `native.samples` values occurred during the interval with independently observed channel-0 activity and disappeared in the subsequent quiet interval. However, 8 polls within the activity interval returned only zeros, and the field's units and semantics are unknown. This is a temporal correlation with this recording, not a qualified voice detector, microphone-route contract, threshold, or guarantee of activity coverage.

## Timing and stability limits

The existing `native-recording.ts` contract defines `native.duration` as BE16 elapsed seconds, with vendor/dispatcher support. In this capture it took every integer value from 0 through 35 and was nondecreasing in `elapsedMs` order. `elapsedMs` ran from 154 to 35,078; consecutive queries were 292–371 ms apart (median 324 ms). As an alignment check only, `elapsedMs - 1000 × native.duration` ranged from −112 to +890 ms. The unit is defined, but this comparison does not calibrate clock synchronization or phase against the channel-level windows. The nonzero/zero response pattern changed eight times over the run, so individual polls were intermittent even while channel 0 was active.

The earlier 55-second passive and UAC sessions contained no user speech; their zero readings are excluded as voice-negative trials. No conclusion about VAD accuracy, general microphone routing, or the meaning of the numeric entries follows from this single sample.

## Narrow next step

`native.samples` is a candidate existing read-only activity observation for experimental controls, because its values changed during the known channel-0 activity window without adding a getter. Before using it to gate behavior, repeat paired quiet and known-speech intervals with the same existing status path and independent channel-level capture, then report missed/extra activity and timing limits. Do not label the values as voice, assign units or route, or claim speech detection from this result.

## Input pins

- Retained native-status receipt SHA-256: `841dc013f8ee46ea782cd2631bb19d7fd70c78910464ed8059e4cdd3d7962e52`.
- Retained channel-level aggregate SHA-256: `e4e03d1853702fd83e403e1ed2087aff8f8aa0fbdc847f6d0b74459da0d12c18`.
