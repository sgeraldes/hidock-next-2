import { describe, it, expect, afterEach } from 'vitest'
import { recordingAliases, resolveDeviceRecording } from '../recording-identity'

const stem = '2026Jun05-223227-Rec89'
const row = (id: string, ext: string, recorded: string, onLocal: number) => ({
  id, filename: `${stem}.${ext}`, original_filename: `${stem}.${ext}`, source: 'hidock', is_imported: 0,
  date_recorded: recorded, on_local: onLocal, deleted_at: null
})

describe('resolveDeviceRecording wall-clock match', () => {
  const savedTz = process.env.TZ
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ
    else process.env.TZ = savedTz
  })

  it.each([
    ['UTC-3, next UTC day', '2026-06-06T01:32:27.000Z'],
    ['UTC', '2026-06-05T22:32:27.000Z'],
    ['UTC+5:30', '2026-06-05T17:02:27.000Z'],
    ['UTC+14', '2026-06-05T08:32:27.000Z'],
    ['UTC-12', '2026-06-06T10:32:27.000Z']
  ])('maps the phantom .hda to the local .wav when the device clock was %s, in any host zone', (_zone, recorded) => {
    const rows = [row('wav', 'wav', recorded, 1), row('hda', 'hda', recorded, 0)]
    for (const tz of ['UTC', 'America/Argentina/Buenos_Aires', 'Asia/Tokyo']) {
      process.env.TZ = tz
      expect(resolveDeviceRecording(`${stem}.hda`, rows)?.id, tz).toBe('wav')
      expect(recordingAliases(rows).get('hda')?.id, tz).toBe('wav')
    }
  })

  it.each([
    ['7 minutes off', '2026-06-05T22:39:27.000Z'],
    ['20 hours off', '2026-06-06T18:32:27.000Z'],
    ['unparseable', 'not a date']
  ])('keeps the explicit .hda identity when the instant is %s', (_case, recorded) => {
    const rows = [row('wav', 'wav', recorded, 1), row('hda', 'hda', recorded, 0)]
    expect(resolveDeviceRecording(`${stem}.hda`, rows)?.id).toBe('hda')
    expect(recordingAliases(rows).has('hda')).toBe(false)
  })
})
