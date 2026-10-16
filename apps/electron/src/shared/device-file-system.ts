export interface DeviceFileSystemStatus {
  running: boolean
  port: number | null
  /** Private local capability. Never include it in diagnostics or persistent configuration. */
  mountUrl: string | null
  files: number
  cachedBytes: number
  readOnly: true
}
