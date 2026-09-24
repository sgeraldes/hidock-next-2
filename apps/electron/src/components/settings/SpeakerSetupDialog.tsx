/**
 * Opens the Speaker setup once when the GPUs differ from the last confirmed
 * setup (a GPU added or removed), or on the first launch that has this
 * feature. Ordinary launches with the same hardware never show it.
 *
 * Spec: docs/superpowers/specs/2026-09-24-speaker-engines-design.md
 */

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { SpeakerSetup } from '@/types/speakers'
import { SpeakerSetupPanel } from './SpeakerSetupPanel'

export function SpeakerSetupDialog(): React.ReactElement | null {
  const [setup, setSetup] = useState<SpeakerSetup | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // The speakers: channel is gated with transcription; with it off this
        // rejects or fails, and there is nothing to set up.
        const result = await window.electronAPI?.speakers?.getSetup()
        if (cancelled || !result?.success) return
        if (result.data.needsConfirmation) {
          setSetup(result.data)
          setOpen(true)
        }
      } catch {
        // Nothing to ask about.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!setup) return null

  const firstTime = !setup.lastConfirmedAt
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto" data-testid="speaker-setup-dialog">
        <DialogHeader>
          <DialogTitle>{firstTime ? 'Set up voice recognition' : 'Your hardware changed'}</DialogTitle>
          <DialogDescription>
            {firstTime
              ? 'Choose how HiDock learns and recognizes voices on this computer. The recommended option fits the hardware found.'
              : 'A GPU was added or removed. Check how HiDock should recognize voices on this hardware.'}
          </DialogDescription>
        </DialogHeader>
        <SpeakerSetupPanel initial={setup} onSaved={() => setOpen(false)} />
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Decide later
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
