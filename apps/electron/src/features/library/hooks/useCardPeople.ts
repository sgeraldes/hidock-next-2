/**
 * The people on a Library card: who spoke (the names bound to the speakers of the transcript), then who
 * was invited and is not among them (the calendar attendees of the linked meeting).
 *
 * The invited come with the meeting the list already holds. The speakers cost one read per recording
 * (`transcripts:getSpeakerMap`), so the read is made only for a card that is mounted, at most four at a
 * time, remembered for a minute, and dropped when a speaker assignment changes (speakerBus). Without
 * `window.electronAPI` (tests, an older build) a card simply shows the invited.
 */

import { useEffect, useMemo, useState } from 'react'
import { parseAttendees, type Meeting, type Transcript } from '@/types'
import type { UnifiedRecording } from '@/types/unified-recording'
import { mergePeople, type CardPerson } from '../utils/cardInfo'
import { isRawSpeakerLabel } from '../utils/resolveParticipants'
import { onSpeakerChange } from '../utils/speakerBus'

const TTL_MS = 60_000
const MAX_PARALLEL = 4

const cache = new Map<string, { names: string[]; at: number }>()
let active = 0
const waiting: Array<() => void> = []

async function inSlot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve))
  active += 1
  try {
    return await run()
  } finally {
    active -= 1
    waiting.shift()?.()
  }
}

/** Forget what was read, for one recording or for all (tests). */
export function forgetCardPeople(recordingId?: string): void {
  if (recordingId) cache.delete(recordingId)
  else cache.clear()
}

async function loadSpokeNames(recordingId: string): Promise<string[]> {
  const hit = cache.get(recordingId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names
  const read = window.electronAPI?.transcripts?.getSpeakerMap
  if (!read) return []
  try {
    const res = await inSlot(() => read({ recordingId }))
    const names = res?.success
      ? [...new Set(res.data.map((entry) => entry.name?.trim()).filter((n): n is string => !!n && !isRawSpeakerLabel(n)))]
      : []
    cache.set(recordingId, { names, at: Date.now() })
    return names
  } catch {
    return []
  }
}

export function useCardPeople(recording: UnifiedRecording, transcript?: Transcript, meeting?: Meeting): CardPerson[] {
  const invited = useMemo(
    () =>
      parseAttendees(meeting?.attendees)
        .map((a) => (a.name || a.email || '').trim())
        .filter(Boolean),
    [meeting?.attendees]
  )
  const [spoke, setSpoke] = useState<string[]>(() => cache.get(recording.id)?.names ?? [])
  const hasTranscript = Boolean(transcript)

  useEffect(() => {
    if (!hasTranscript) {
      setSpoke([])
      return
    }
    let cancelled = false
    const load = () => {
      void loadSpokeNames(recording.id).then((names) => {
        if (!cancelled) setSpoke(names)
      })
    }
    load()
    const stop = onSpeakerChange((id) => {
      if (id === recording.id) {
        forgetCardPeople(id)
        load()
      }
    })
    return () => {
      cancelled = true
      stop()
    }
  }, [recording.id, hasTranscript])

  return useMemo(() => mergePeople(spoke, invited), [spoke, invited])
}
