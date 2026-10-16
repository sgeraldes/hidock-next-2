/** Public diagnostic counts only; source paths and execution bindings stay in main. */
export interface DeviceRecordingBackupPreflightSummary {
  compatibility: 'compatible' | 'incompatible'
  executionReadiness: 'ready-on-empty-destination' | 'blocked-destination-collision' | 'not-ready'
  incompatibilities: readonly string[]
  destinationCollisions: number
  summary: { entryCount: number; reservedBytes: number; rehashPerformed: boolean; checkedSourceCount: number }
  baselineEvidence: 'host-download-v1-receipts'
  deviceMutationAuthorized: false
  diagnostics: {
    catalogFileCount: number; eligibleLocalRowCount: number; provenFileCount: number
    filesWithoutLocalRow: number; filesWithoutReceipt: number; filesWithMismatchedReceipt: number
    filesWithAmbiguousCandidates: number
  }
}
