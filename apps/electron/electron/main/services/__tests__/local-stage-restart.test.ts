// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import { once } from 'events'
import { cancelLocalStageRestart, mayRestartLocalStage, restartLocalStageAfterExit } from '../local-stage-restart'

it('offers restart only for owned local audio stages, never cloud or stale runs', () => {
  const run = { id: 'stage', stage: 'transcription', execution: 'local', status: 'running' }
  expect(mayRestartLocalStage([run], new Set(['stage']))).toBe(true)
  expect(mayRestartLocalStage([run], new Set())).toBe(false)
  expect(mayRestartLocalStage([{ ...run, execution: 'cloud' }], new Set(['stage']))).toBe(false)
  expect(mayRestartLocalStage([run, { ...run, id: 'other', execution: 'cloud' }], new Set(['stage', 'other']))).toBe(false)
  const companion = { ...run, id: 'voices', stage: 'diarization', execution: 'provider-managed', provider: 'local-asr' }
  expect(mayRestartLocalStage([run, companion], new Set(['stage', 'voices']))).toBe(true)
  expect(mayRestartLocalStage([run, { ...companion, provider: 'gemini' }], new Set(['stage', 'voices']))).toBe(false)
  expect(mayRestartLocalStage([{ ...run, stage: 'pipeline' }], new Set(['stage']))).toBe(false)
})

it('waits for actual ownership release before queueing and prevents a second restart', async () => {
  let owned = true
  let release!: () => void
  const enqueue = vi.fn()
  const cancel = vi.fn()
  const deps = { eligible: () => true, cancel, isOwned: () => owned, enqueue,
    wait: () => new Promise<void>(resolve => { release = () => { owned = false; resolve() } }) }
  const pending = restartLocalStageAfterExit('recording', deps)
  expect(cancel).toHaveBeenCalledOnce()
  expect(enqueue).not.toHaveBeenCalled()
  await expect(restartLocalStageAfterExit('recording', deps)).rejects.toThrow('already pending')
  release(); await pending
  expect(enqueue).toHaveBeenCalledOnce()
})

it('does not enqueue a replacement if the old owner remains alive', async () => {
  let clock = 0
  const enqueue = vi.fn()
  await expect(restartLocalStageAfterExit('stuck', { eligible: () => true, cancel: () => {}, isOwned: () => true,
    enqueue, now: () => clock, wait: async () => { clock += 30001 } })).rejects.toThrow('not exited')
  expect(enqueue).not.toHaveBeenCalled()
})

it('waits for a real child process to close before admitting replacement work', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true, stdio: 'ignore' })
  let owned = true
  const closed = once(child, 'close').then(() => { owned = false })
  await once(child, 'spawn')
  let admitted = false
  try {
    await restartLocalStageAfterExit('real-worker', { eligible: () => true, cancel: () => { child.kill() },
      isOwned: () => owned, wait: () => closed, enqueue: () => {
        expect(owned).toBe(false)
        admitted = true
      } })
    expect(admitted).toBe(true)
  } finally { child.kill(); await closed }
})


it.each([false, true])('honors later cancel (all=%s) while the previous worker is exiting', async all => {
  let owned = true
  let release!: () => void
  const enqueue = vi.fn()
  const pending = restartLocalStageAfterExit('changed-mind', { eligible: () => true, cancel: () => {},
    isOwned: () => owned, enqueue,
    wait: () => new Promise<void>(resolve => { release = () => { owned = false; resolve() } }) })
  cancelLocalStageRestart(all ? undefined : 'changed-mind')
  release()
  await expect(pending).rejects.toThrow('Restart cancelled')
  expect(enqueue).not.toHaveBeenCalled()
})
