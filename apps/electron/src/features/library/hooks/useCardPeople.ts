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
// Names of this many recordings are kept; the oldest read goes first. Scrolling a long library must not grow this without end.
const MAX_CACHED = 500

const cache = new Map<string, { names: string[]; at: number }>()
let active = 0
const waiting: Array<() => void> = []

/**
 * At most MAX_PARALLEL reads at once. A finished read hands its slot straight to the next waiter (active does not
 * change), so a card that mounts in between cannot take a slot the waiter is about to use.
 */
async function inSlot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve))
  else active += 1
  try {
    return await run()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else active -= 1
  }
}

function remember(recordingId: string, names: string[]): void {
  cache.delete(recordingId)
  cache.set(recordingId, { names, at: Date.now() })
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** How many recordings have their names remembered (tests). */
export function cardPeopleCacheSize(): number {
  return cache.size
}

// Bumped when what was read is forgotten, so a read already under way cannot store its old answer afterwards.
let epoch = 0
const generations = new Map<string, number>()
const generationOf = (recordingId: string): string => `${epoch}:${generations.get(recordingId) ?? 0}`

/** Forget what was read, for one recording or for all (tests). */
export function forgetCardPeople(recordingId?: string): void {
  if (recordingId) {
    cache.delete(recordingId)
    generations.set(recordingId, (generations.get(recordingId) ?? 0) + 1)
  } else {
    cache.clear()
    generations.clear()
    epoch += 1
  }
}

async function loadSpokeNames(recordingId: string): Promise<string[]> {
  const hit = cache.get(recordingId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names
  const read = window.electronAPI?.transcripts?.getSpeakerMap
  if (!read) return []
  const started = generationOf(recordingId)
  try {
    const res = await inSlot(() => read({ recordingId }))
    const names = res?.success
      ? [...new Set(res.data.map((entry) => entry.name?.trim()).filter((n): n is string => !!n && !isRawSpeakerLabel(n)))]
      : []
    if (generationOf(recordingId) === started) remember(recordingId, names)
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
    // A read started later wins: an older one that resolves last must not put the names from before a change back.
    let latest = 0
    const load = () => {
      const mine = (latest += 1)
      void loadSpokeNames(recording.id).then((names) => {
        if (!cancelled && mine === latest) setSpoke(names)
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
