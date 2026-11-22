// @vitest-environment node
import { describe, expect, it } from 'vitest'
// Both sides are the real modules. Nothing below restates a model id: a drift on either side fails here.
import { REMOTE_ASR_MODELS, REMOTE_ASR_LABELS } from '../../../../src/shared/asr-models'
import { ASR_MODELS as HOST_ASR_MODELS, ONNX_ASR, PHOTON_ASR, NATIVE_ASR, MOSS_ASR, AUDIO8_ASR }
  from '../../../../../model-host/src/asr-catalog.mjs'
import { ASR_MODELS as HOST_RUNTIME_ASR_MODELS } from '../../../../../model-host/src/asr.mjs'
import { AUDIO_MODELS } from '../audio-execution-route'

const client = [...REMOTE_ASR_MODELS] as string[]
const host = [...HOST_ASR_MODELS] as string[]
const groups = { ONNX_ASR, PHOTON_ASR, NATIVE_ASR, MOSS_ASR, AUDIO8_ASR } as Record<string, Record<string, unknown>>

describe('ASR catalog parity between the client selector and the model host', () => {
  it('offers the client exactly the engines the host can run', () => {
    expect(client.filter(id => !host.includes(id)), 'listed by the client, unknown to the host').toEqual([])
    expect(host.filter(id => !client.includes(id)), 'known to the host, missing from the client selector').toEqual([])
  })

  it('lists each engine once on both sides', () => {
    expect(new Set(client).size).toBe(client.length)
    expect(new Set(host).size).toBe(host.length)
    expect(client).toHaveLength(host.length)
  })

  it('uses the same catalog object the host server and workers validate against', () => {
    expect([...HOST_RUNTIME_ASR_MODELS].sort()).toEqual([...host].sort())
  })

  it('labels every selectable engine and nothing else', () => {
    expect(Object.keys(REMOTE_ASR_LABELS).sort()).toEqual([...client].sort())
    for (const id of client) {
      expect((REMOTE_ASR_LABELS as Record<string, string>)[id].trim(), id).not.toBe('')
    }
  })

  it('keeps labels distinguishable so two engines of one family are not mistaken for each other', () => {
    const labels = client.map(id => (REMOTE_ASR_LABELS as Record<string, string>)[id].toLowerCase())
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('places every host engine in exactly one runtime group, apart from the two transformers-based engines', () => {
    const grouped = Object.values(groups).flatMap(group => Object.keys(group))
    expect(new Set(grouped).size, 'an engine appears in two runtime groups').toBe(grouped.length)
    expect(grouped.filter(id => !host.includes(id)), 'runtime group entry missing from the catalog set').toEqual([])
    expect(host.filter(id => !grouped.includes(id)).sort(), 'catalog engines without a runtime group')
      .toEqual([AUDIO_MODELS['local-asr'], AUDIO_MODELS.vibevoice].sort())
  })

  it('knows the two models the client routes by provider', () => {
    for (const id of Object.values(AUDIO_MODELS)) {
      expect(client, `client selector lacks ${id}`).toContain(id)
      expect(host, `host catalog lacks ${id}`).toContain(id)
    }
  })

  it('has one Audio8 engine, the only one whose route guard restricts languages', () => {
    expect(Object.keys(AUDIO8_ASR)).toHaveLength(1)
    expect(client).toContain(Object.keys(AUDIO8_ASR)[0])
  })
})
