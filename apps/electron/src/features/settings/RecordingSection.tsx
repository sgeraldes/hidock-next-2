/**
 * Settings > Recording: how recordings arrive. The HiDock switches here are
 * the same as on the Device page (one key or one device setting, two places;
 * owner rule 28-sep-2026). Auto-record lives on the device itself, so it can
 * only be read and changed while the HiDock is connected. Recording from the
 * computer's microphone arrives with the recorder from the standalone app.
 */
import { useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { useAppStore } from '@/store/useAppStore'
import { getHiDockDeviceService } from '@/services/hidock-device'

function Row({ id, label, detail, checked, disabled, onChange }: {
  id: string
  label: string
  detail: string
  checked: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </div>
  )
}

export function RecordingSection() {
  const config = useConfigStore((s) => s.config)
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const deviceState = useAppStore((s) => s.deviceState)
  const deviceService = getHiDockDeviceService()
  const [autoConnect, setAutoConnect] = useState(() => deviceService.getAutoConnectConfig().enabled)
  const [recordBusy, setRecordBusy] = useState(false)
  useEffect(() => setAutoConnect(deviceService.getAutoConnectConfig().enabled), [deviceService, config?.device?.autoConnect])

  const connected = !!deviceState?.connected && !!deviceState.settings
  const save = (section: 'device' | 'transcription', values: Record<string, unknown>, what: string) => {
    void updateConfig(section, values as never).catch((err: unknown) =>
      toast.error(`Could not change ${what}`, err instanceof Error ? err.message : undefined)
    )
  }

  return (
    <div className="space-y-4" data-testid="settings-recording">
      <section className="space-y-4 rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">HiDock device</h3>
        <Row
          id="deviceAutoRecord"
          label="Record meetings automatically"
          detail={
            connected
              ? 'Stored on the HiDock itself. Also on the Device page.'
              : 'Stored on the HiDock itself: connect it to see or change this.'
          }
          checked={!!deviceState?.settings?.autoRecord}
          disabled={!connected || recordBusy}
          onChange={async (on) => {
            setRecordBusy(true)
            try {
              const ok = await deviceService.setAutoRecord(on)
              if (!ok) toast.error('The HiDock did not accept the change', 'Try again with the device connected.')
            } finally {
              setRecordBusy(false)
            }
          }}
        />
        <Row
          id="deviceAutoConnect"
          label="Connect to the HiDock when HiDock Next starts"
          detail="Also on the Device page."
          checked={autoConnect}
          onChange={(on) => {
            deviceService.setAutoConnectConfig({ enabled: on, connectOnStartup: on })
            setAutoConnect(on)
          }}
        />
        <Row
          id="deviceAutoDownload"
          label="Download new recordings automatically"
          detail="Pauses when the recordings folder reaches its limit in Storage. Also on the Device page."
          checked={config?.device?.autoDownload !== false}
          onChange={(on) => save('device', { autoDownload: on }, 'automatic download')}
        />
        <Row
          id="recordingAutoTranscribe"
          label="Transcribe new recordings automatically"
          detail="Also on Transcription > Pipeline and the Device page."
          checked={config?.transcription?.autoTranscribe !== false}
          onChange={(on) => save('transcription', { autoTranscribe: on }, 'automatic transcription')}
        />
        <Row
          id="liveSaveRecording"
          label="Save live streams as recordings"
          detail="Realtime streaming on the Device page writes both channels to the recordings folder. When it stops, the recording is in the Library and transcribes like any other."
          checked={config?.transcription?.liveSaveRecording !== false}
          onChange={(on) => save('transcription', { liveSaveRecording: on }, 'saving live streams')}
        />
      </section>

      <section className="space-y-2 rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Where recordings go</h3>
        <p className="font-mono text-xs">{config?.storage?.recordingsPath || 'The recordings folder inside the data folder'}</p>
        <p className="text-xs text-muted-foreground">Change it, or move the files, in Storage.</p>
      </section>

      <section className="space-y-1 rounded-lg border border-dashed border-border p-4">
        <h3 className="text-sm font-semibold">Recording from this computer</h3>
        <p className="text-xs text-muted-foreground">
          Arrives with the recorder from the standalone app: record the microphone and the meeting audio, start
          automatically with calendar meetings, and stop after a silence.
        </p>
      </section>
    </div>
  )
}
