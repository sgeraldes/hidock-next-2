/**
 * A voice that disagrees with a speaker already named (spec 2026-10-03, 2d and Phase 4):
 * "In 'Weekly sync' (12 Sep), Speaker 2's voice sounds like Ana Ruiz, but it is named Bea Paz
 * (named by you)". Two answers: keep the name, or name the speaker after the voice. Both go
 * through identity:resolveVoiceConflict; the generic accept and reject refuse these rows.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Mic } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { BusyIcon } from '@/components/ui/working'
import { toast } from '@/components/ui/toaster'
import type { VoiceConflictChoice, VoiceConflictView } from '@/shared/identity-review'
import { shortDate } from './decisionSentence'

/** Who named the speaker, in words. */
export function boundSourceWords(source: string | null): string {
  switch (source) {
    case 'manual':
      return 'named by you'
    case 'self-identification':
      return 'the speaker gave that name'
    case 'jev':
    case 'speaker-inference':
      return 'named by Jev'
    case 'live-channel':
      return 'named from your microphone'
    default:
      return 'named earlier'
  }
}

export function voiceConflictSentence(c: VoiceConflictView): string {
  const title = c.meetingSubject || c.recordingTitle
  const where = title ? `In '${title}'${c.recordingDate ? ` (${shortDate(c.recordingDate)})` : ''}, ` : ''
  const voice = c.voiceContactName ?? 'someone no longer in People'
  const bound = c.boundContactName ?? 'someone no longer in People'
  return `${where}${c.speakerLabel}'s voice sounds like ${voice}, but it is named ${bound} (${boundSourceWords(c.boundSource)})`
}

/** The open voice conflicts, and the answer to one. A missing preload method reads as none. */
export function useVoiceConflicts(enabled = true) {
  const [conflicts, setConflicts] = useState<VoiceConflictView[]>([])
  const [loading, setLoading] = useState(enabled)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async () => {
    if (!enabled) {
      setConflicts([])
      setLoading(false)
      return
    }
    try {
      const res = await window.electronAPI.identity.listVoiceConflicts?.()
      if (mounted.current) setConflicts(res?.success ? res.data : [])
    } catch (err) {
      console.error('Failed to load voice conflicts:', err)
      if (mounted.current) setConflicts([])
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void load()
  }, [load])

  /** Resolves to null on success (the card leaves), or the message to show on the card. */
  const answer = useCallback(async (id: string, choice: VoiceConflictChoice): Promise<string | null> => {
    try {
      const res = await window.electronAPI.identity.resolveVoiceConflict(id, choice)
      if (!res.success) {
        if (res.error.code !== 'RECORDING_INELIGIBLE') return res.error.message
        // The recording left the library and the app closed the question: the card goes, the
        // reason stays on screen for a while.
        toast.info('Question closed', res.error.message)
      }
      if (mounted.current) setConflicts((prev) => prev.filter((c) => c.id !== id))
      return null
    } catch {
      return 'The answer could not be saved. Try again; if it keeps failing, restart HiDock.'
    }
  }, [])

  return { conflicts, loading, reload: load, answer }
}

export function VoiceConflictCard({
  conflict,
  onAnswer
}: {
  conflict: VoiceConflictView
  onAnswer: (id: string, choice: VoiceConflictChoice) => Promise<string | null>
}) {
  const [busy, setBusy] = useState<VoiceConflictChoice | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const voice = conflict.voiceContactName ?? 'the voice'
  const bound = conflict.boundContactName ?? 'the name'

  const choose = async (choice: VoiceConflictChoice) => {
    setBusy(choice)
    setMessage(null)
    const failure = await onAnswer(conflict.id, choice)
    setBusy(null)
    if (failure) setMessage(failure)
  }

  return (
    <Card data-testid="voice-conflict">
      <CardContent className="space-y-2.5 p-4">
        <div className="flex items-start gap-2">
          <Mic className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-sm leading-snug">{voiceConflictSentence(conflict)}</p>
        </div>
        {message && (
          <p role="alert" className="text-xs text-amber-800 dark:text-amber-300">
            {message}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={busy !== null}
            aria-busy={busy === 'keep' || undefined}
            onClick={() => void choose('keep')}
          >
            {busy === 'keep' && <BusyIcon className="mr-1 h-3.5 w-3.5" />}
            Keep {bound}
          </Button>
          <Button
            size="sm"
            className="h-7"
            disabled={busy !== null}
            aria-busy={busy === 'voice' || undefined}
            onClick={() => void choose('voice')}
          >
            {busy === 'voice' ? <BusyIcon className="mr-1 h-3.5 w-3.5" /> : <Check className="mr-1 h-3.5 w-3.5" />}
            It is {voice}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
