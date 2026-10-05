// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { spawnStreaming } from '../worker-process'

describe('local transcription worker cancellation', () => {
  it('stops the real worker tree and rejects partial output', async () => {
    const controller = new AbortController()
    let pids: number[] = []
    const script = `
      const {spawn} = require('child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
      process.stdout.write('partial transcript');
      process.stderr.write(JSON.stringify([process.pid, child.pid])+'\\n');
      setInterval(()=>{},1000);
    `
    const work = spawnStreaming(process.execPath, ['-e', script], {
      signal: controller.signal,
      onStderrLine: line => { pids = JSON.parse(line); controller.abort(new Error('Stopped by you')) }
    })
    await expect(work).rejects.toThrow('Stopped by you')
    expect(pids).toHaveLength(2)
    await vi.waitFor(() => {
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
    })
  }, 10_000)
  it('does not start a worker when already stopped', async () => {
    const controller = new AbortController()
    controller.abort(new Error('Stopped by you'))
    await expect(spawnStreaming(process.execPath, ['-e', 'throw new Error("started")'], {signal:controller.signal})).rejects.toThrow('Stopped by you')
  })
})
