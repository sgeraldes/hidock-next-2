/**
 * The people of a Library card: who spoke (one read per recording, cached, limited) then who was invited.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Meeting, Transcript } from '@/types'
import type { UnifiedRecording } from '@/types/unified-recording'
import { emitSpeakerChange } from '../../utils/speakerBus'
import { cardPeopleCacheSize, forgetCardPeople, useCardPeople } from '../useCardPeople'

const recording = (id: string): UnifiedRecording =>
  ({
    id,
    filename: `${id}.wav`,
    dateRecorded: new Date('2026-09-24T10:00:00'),
    duration: 60,
    size: 1,
    location: 'local-only',
    syncStatus: 'synced',
    localPath: '/tmp/x.wav',
    transcriptionStatus: 'complete'
  }) as UnifiedRecording

const transcript = { id: 't1' } as Transcript
const meeting = {
  id: 'm1',
  subject: 'Weekly',
  attendees: JSON.stringify([{ name: 'Marta Ríos' }, { email: 'luis.gomez@dfx5.com' }, { name: 'Ana Perez (DFX5)' }])
} as unknown as Meeting

function Probe({ id, t = transcript, m = meeting }: { id: string; t?: Transcript; m?: Meeting }) {
  const people = useCardPeople(recording(id), t, m)
  return <div data-testid={`people-${id}`}>{people.map((p) => `${p.spoke ? '+' : '-'}${p.name}`).join('|')}</div>
}

type Reader = (arg: { recordingId: string }) => Promise<{ success: boolean; data: Array<{ speaker_label: string; contact_id: string; name: string }> }>
const setApi = (getSpeakerMap?: Reader) => {
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = getSpeakerMap ? { transcripts: { getSpeakerMap } } : undefined
}

describe('useCardPeople', () => {
  beforeEach(() => forgetCardPeople())
  afterEach(() => setApi(undefined))

  it('lists who spoke first, then the invited who did not speak, without repeating anyone', async () => {
    setApi(async () => ({
      success: true,
      data: [
        { speaker_label: 'Speaker 1', contact_id: 'c1', name: 'Ana Pérez' },
        { speaker_label: 'Speaker 2', contact_id: '', name: 'Speaker 2' }
      ]
    }))
    render(<Probe id="r1" />)
    // The invited are there at once.
    expect(screen.getByTestId('people-r1').textContent).toContain('-Marta Ríos')
    await waitFor(() => expect(screen.getByTestId('people-r1').textContent).toBe('+Ana Pérez|-Marta Ríos|-luis.gomez@dfx5.com'))
  })

  it('reads a recording once and remembers it', async () => {
    const read = vi.fn<Reader>(async () => ({ success: true, data: [{ speaker_label: 'S', contact_id: 'c', name: 'Ana Pérez' }] }))
    setApi(read)
    const first = render(<Probe id="r2" />)
    await waitFor(() => expect(screen.getByTestId('people-r2').textContent).toContain('+Ana Pérez'))
    first.unmount()
    render(<Probe id="r2" />)
    expect(screen.getByTestId('people-r2').textContent).toContain('+Ana Pérez')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('reads again when a speaker assignment of that recording changes', async () => {
    let name = 'Ana Pérez'
    const read = vi.fn<Reader>(async () => ({ success: true, data: [{ speaker_label: 'S', contact_id: 'c', name }] }))
    setApi(read)
    render(<Probe id="r3" m={{ id: 'm', subject: 's', attendees: null } as unknown as Meeting} />)
    await waitFor(() => expect(screen.getByTestId('people-r3').textContent).toBe('+Ana Pérez'))
    name = 'Ana María Pérez'
    act(() => emitSpeakerChange('r3'))
    await waitFor(() => expect(screen.getByTestId('people-r3').textContent).toBe('+Ana María Pérez'))
    expect(read).toHaveBeenCalledTimes(2)
    // A change of another recording is not this card's business.
    act(() => emitSpeakerChange('other'))
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not read anything for a recording without a transcript', async () => {
    const read = vi.fn<Reader>(async () => ({ success: true, data: [] }))
    setApi(read)
    render(<Probe id="r4" t={null as unknown as Transcript} />)
    await Promise.resolve()
    expect(read).not.toHaveBeenCalled()
    expect(screen.getByTestId('people-r4').textContent).toContain('-Marta Ríos')
  })

  it('shows the invited alone when the read fails, answers badly, or there is no API', async () => {
    setApi(async () => {
      throw new Error('ipc down')
    })
    const failing = render(<Probe id="r5" />)
    await waitFor(() => expect(screen.getByTestId('people-r5').textContent).toContain('-Marta Ríos'))
    expect(screen.getByTestId('people-r5').textContent).not.toContain('+')
    failing.unmount()
    setApi(async () => ({ success: false, data: [] }))
    const refused = render(<Probe id="r6" />)
    await waitFor(() => expect(screen.getByTestId('people-r6').textContent).toContain('-Marta Ríos'))
    refused.unmount()
    setApi(undefined)
    render(<Probe id="r7" />)
    expect(screen.getByTestId('people-r7').textContent).toContain('-Marta Ríos')
  })

  it('keeps the newest names when an older read resolves last', async () => {
    const answers = [
      { delay: 40, name: 'Before The Change' },
      { delay: 1, name: 'After The Change' }
    ]
    let call = 0
    setApi(async () => {
      const mine = answers[Math.min(call++, answers.length - 1)]
      await new Promise((r) => setTimeout(r, mine.delay))
      return { success: true, data: [{ speaker_label: 'S', contact_id: 'c', name: mine.name }] }
    })
    const view = render(<Probe id="r8" m={{ id: 'm', subject: 's', attendees: null } as unknown as Meeting} />)
    // The first read is slow; a speaker change starts a second, fast one before the first ends.
    await new Promise((r) => setTimeout(r, 5))
    act(() => emitSpeakerChange('r8'))
    await waitFor(() => expect(screen.getByTestId('people-r8').textContent).toBe('+After The Change'))
    await new Promise((r) => setTimeout(r, 80))
    expect(screen.getByTestId('people-r8').textContent).toBe('+After The Change')
    // Nor did the slow read leave its old answer in the cache: a card mounted now starts from the new names.
    view.unmount()
    render(<Probe id="r8" m={{ id: 'm', subject: 's', attendees: null } as unknown as Meeting} />)
    expect(screen.getByTestId('people-r8').textContent).toBe('+After The Change')
    expect(call).toBe(2)
  })

  it('never has more than four reads in flight even when cards mount while others finish', async () => {
    let running = 0
    let peak = 0
    setApi(async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 6))
      running -= 1
      return { success: true, data: [] }
    })
    const view = render(<></>)
    for (let i = 0; i < 30; i++) {
      view.rerender(
        <>
          {Array.from({ length: i + 1 }, (_, k) => (
            <Probe key={`s${k}`} id={`s${k}`} />
          ))}
        </>
      )
      await new Promise((r) => setTimeout(r, 2))
    }
    await new Promise((r) => setTimeout(r, 150))
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('keeps the names of a bounded number of recordings', async () => {
    setApi(async ({ recordingId }) => ({ success: true, data: [{ speaker_label: 'S', contact_id: 'c', name: `Person ${recordingId}` }] }))
    const ids = Array.from({ length: 520 }, (_, i) => `e${i}`)
    const { rerender } = render(<></>)
    for (let start = 0; start < ids.length; start += 40) {
      rerender(
        <>
          {ids.slice(start, start + 40).map((id) => (
            <Probe key={id} id={id} />
          ))}
        </>
      )
      await waitFor(() => expect(screen.getByTestId(`people-${ids[Math.min(start + 39, ids.length - 1)]}`).textContent).toContain('+Person'))
    }
    expect(cardPeopleCacheSize()).toBeLessThanOrEqual(500)
  })

  it('makes at most four reads at a time, however many cards are mounted', async () => {
    let running = 0
    let peak = 0
    setApi(async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running -= 1
      return { success: true, data: [] }
    })
    const ids = Array.from({ length: 12 }, (_, i) => `q${i}`)
    render(
      <>
        {ids.map((id) => (
          <Probe key={id} id={id} />
        ))}
      </>
    )
    await waitFor(() => expect(running).toBe(0))
    await new Promise((r) => setTimeout(r, 80))
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })
})
