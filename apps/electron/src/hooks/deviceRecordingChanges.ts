// Each connected polling session establishes its own device filename baseline.
export function createDeviceRecordingChangeTracker() {
  let knownNames = new Set<string>()
  let initialized = false
  let awaitingBaseline = false

  return (filenames: readonly string[]): { changed: boolean; newCount: number } => {
    const currentNames = new Set(filenames)
    if (!initialized) {
      initialized = true
      awaitingBaseline = currentNames.size === 0
      knownNames = currentNames
      return { changed: false, newCount: 0 }
    }

    const addedNames = [...currentNames].filter((name) => !knownNames.has(name))
    const changed = currentNames.size !== knownNames.size || addedNames.length > 0
    const newCount = awaitingBaseline || currentNames.size < knownNames.size ? 0 : addedNames.length
    if (currentNames.size > 0) awaitingBaseline = false
    knownNames = currentNames
    return { changed, newCount }
  }
}
