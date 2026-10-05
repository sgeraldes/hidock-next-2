/** Reserved names belong to the PC recorder's idempotent import/recovery path. */
export function isPcRecordingFilename(filename: string): boolean {
  return /^Recording \d{4}-\d{2}-\d{2} \d{2}-\d{2} [0-9a-f-]{36}\.webm(?:\.partial)?$/.test(filename)
}
