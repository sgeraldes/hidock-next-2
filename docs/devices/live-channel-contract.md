# Live PCM channel contract

The Jensen SDK exports `splitRealtimeChannelsTap(packet)`. It copies an existing mode-2 CMD34 packet into two independent mono PCM16LE buffers. Feed it the packet obtained by the application's existing USB owner; never add a competing CMD34 reader.

```typescript
import { splitRealtimeChannelsTap } from '@hidock/jensen-protocol'
const tap = splitRealtimeChannelsTap(packet)
if (tap) {
  const [firstLane, secondLane] = tap.channels
  // Consume firstLane.pcm and secondLane.pcm independently.
}
```

CMD34 has an eight-byte header: BE32 producer sequence minus one, then BE32 system microphone mute. Each following four-byte frame contains lane 0's int16LE sample and lane 1's int16LE sample. The helper reports incomplete trailing bytes, leaves the original packet untouched and returns null if no complete frame exists. Its 16 kHz rate is a host expectation, not a negotiated device capability. IDs remain `channel-0` and `channel-1`.

On the author's H1E with custom 393988 / 6.3.4 in normal USB mode 2, the development app received 42 packets / 67,200 frames and delivered 134,400 bytes per mono lane. Both buffers matched every corresponding source byte. An explicit 1 kHz HiDock USB playback tone was 69.35 times stronger in the second lane: system playback is lane 1; the microphone is lane 0 in the user's fixed setup and firmware mute-first route. This does not qualify Bluetooth modes or individual array microphones.

The four-second live check requested neither transcription nor file saving. Stop was acknowledged, native recording returned idle, settings (including auto-record enabled) remained unchanged, and the file count remained 587. No firmware or settings write was requested.

The ongoing development app also has an owning-renderer `onRealtimeChannels` subscription. This firmware-install branch publishes the reusable SDK helper; its Electron UI has not yet been wired to that subscription. Installing 6.3.4 does not install the newer development UI. Live streaming already exists in official firmware; the tap is a host access improvement, not a new firmware encoder feature.
