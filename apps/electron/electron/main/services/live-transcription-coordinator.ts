import { getConfig } from './config'
import { geminiLiveTranscription, type LiveTranscriptionSender } from './gemini-live-transcription'
import { RemoteNemotronLiveTranscription } from './remote-nemotron-live-transcription'
import type { RealtimeData } from '@hidock/jensen-protocol'

const remote = new RemoteNemotronLiveTranscription(() => getConfig().transcription)
let active: typeof remote | typeof geminiLiveTranscription = geminiLiveTranscription
export const liveTranscription = {
  async start(sender: LiveTranscriptionSender) {
    await active.stop()
    active = getConfig().transcription.liveTranscriptionProvider === 'remote-nemotron' ? remote : geminiLiveTranscription
    await active.start(sender)
  },
  pause: () => active.pause(),
  stop: () => active.stop(),
  acceptDevicePacket: (packet: RealtimeData) => active.acceptDevicePacket(packet)
}
