import type { BackupWorkerProcess } from './sqlite-backup-executor'

export interface UtilityProcessChild {
  pid?: number
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (type: string, location: string, report: string) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  on(event: 'spawn', listener: () => void): unknown
  once(event: 'message', listener: (message: unknown) => void): unknown
  once(event: 'error', listener: (type: string, location: string, report: string) => void): unknown
  once(event: 'exit', listener: (code: number) => void): unknown
  once(event: 'spawn', listener: () => void): unknown
  postMessage(message: unknown): void
  kill(): boolean
}

function toUtilityProcessError(type: string, location: string, report: string): Error {
  return new Error(`Utility process ${type} at ${location}: ${report}`)
}

/** Adapts Electron's direct message payload and multi-argument error event. */
export function adaptUtilityProcess(child: UtilityProcessChild): BackupWorkerProcess {
  const adapter: BackupWorkerProcess = {
    get pid() { return child.pid },
    on(event, listener) {
      if (event === 'message') child.on('message', message => listener(message))
      else if (event === 'error') child.on('error', (type, location, report) => {
        listener(toUtilityProcessError(type, location, report))
      })
      else if (event === 'exit') child.on('exit', code => listener(code))
      else if (event === 'spawn') child.on('spawn', () => listener())
      else throw new Error(`Unsupported utility process event: ${event}`)
      return adapter
    },
    once(event, listener) {
      if (event === 'message') child.once('message', message => listener(message))
      else if (event === 'error') child.once('error', (type, location, report) => {
        listener(toUtilityProcessError(type, location, report))
      })
      else if (event === 'exit') child.once('exit', code => listener(code))
      else if (event === 'spawn') child.once('spawn', () => listener())
      else throw new Error(`Unsupported utility process event: ${event}`)
      return adapter
    },
    postMessage(message) { child.postMessage(message) },
    kill() { child.kill() },
  }
  return adapter
}
