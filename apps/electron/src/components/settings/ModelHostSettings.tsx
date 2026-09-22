/**
 * The machine with the GPU.
 *
 * This computer has an AMD card, so diarization runs on its CPU and a backlog
 * takes hours. The Model Host runs the same worker on the gamestation's RTX
 * card and hands the result back. Pairing is the only thing this panel does;
 * whether a recording actually goes there is decided per recording in the main
 * process, and a host that is off changes nothing.
 */

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { toast } from '@/components/ui/toaster'

type Health = NonNullable<
  Awaited<ReturnType<NonNullable<typeof window.electronAPI>['modelHost']['check']>>['health']
>

export function ModelHostSettings(): React.ReactElement {
  const { config } = useConfigStore()
  const savedUrl = config?.transcription?.modelHostUrl ?? ''
  const paired = Boolean(config?.transcription?.modelHostToken)

  const [url, setUrl] = useState(savedUrl)
  const [code, setCode] = useState('')
  const [health, setHealth] = useState<Health | null>(null)
  const [busy, setBusy] = useState(false)

  const check = async () => {
    setBusy(true)
    setHealth(null)
    try {
      const result = await window.electronAPI.modelHost.check({ url })
      if (!result.success || !result.health) {
        toast.error('No host there', result.error)
        return
      }
      setHealth(result.health)
    } finally {
      setBusy(false)
    }
  }

  const pair = async () => {
    setBusy(true)
    try {
      const result = await window.electronAPI.modelHost.pair({ url, code })
      if (!result.success) {
        toast.error('Could not pair', result.error)
        return
      }
      setCode('')
      toast.success('Paired', 'Recordings will diarize on that machine when it is running.')
    } finally {
      setBusy(false)
    }
  }

  const forget = async () => {
    setBusy(true)
    try {
      await window.electronAPI.modelHost.forget()
      setUrl('')
      setHealth(null)
      toast.success('Forgotten', 'Diarization happens on this machine again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model host</CardTitle>
        <CardDescription>
          Another computer on your network that runs the speaker models. Diarization goes there when
          it is running, and happens here when it is not. Nothing fails because the host is off.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="model-host-url">
            Host address
          </label>
          <div className="flex gap-2">
            <Input
              id="model-host-url"
              value={url}
              placeholder="gamestation:8765"
              disabled={busy}
              onChange={(event) => setUrl(event.target.value)}
            />
            <Button variant="outline" onClick={check} disabled={busy || !url.trim()}>
              Check
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The name or address of the machine, and the port shown on its control page.
          </p>
        </div>

        {health && (
          <div className="rounded-md border border-border p-3 text-sm">
            <p>
              Host {health.version}, {health.state}
              {health.reason ? `. ${health.reason}` : ''}
            </p>
            <p className="text-muted-foreground">
              {health.gpu === undefined
                ? 'Pair with this host to see what hardware it has.'
                : health.gpu === null
                  ? 'No NVIDIA driver answered there; work would run on its CPU.'
                  : `${health.gpu.name}, driver ${health.gpu.driver}`}
            </p>
            {health.capabilities.length === 0 && (
              <p className="text-muted-foreground">
                Setup has not finished on that machine, so it cannot diarize yet.
              </p>
            )}
          </div>
        )}

        <div className="space-y-2 border-t border-border pt-4">
          <label className="text-sm font-medium" htmlFor="model-host-code">
            Pairing code
          </label>
          <div className="flex gap-2">
            <Input
              id="model-host-code"
              value={code}
              placeholder="12345678"
              inputMode="numeric"
              disabled={busy}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 12))}
            />
            <Button onClick={pair} disabled={busy || !url.trim() || code.length < 4}>
              Pair
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            On the host, open its control page and press &ldquo;Show a pairing code&rdquo;. The code
            lasts five minutes.
          </p>
        </div>

        {paired && (
          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-sm text-muted-foreground">
              This computer is paired with {savedUrl || 'a model host'}.
            </p>
            <Button variant="outline" onClick={forget} disabled={busy}>
              Forget this host
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
