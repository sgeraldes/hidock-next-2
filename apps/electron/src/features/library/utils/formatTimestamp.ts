/**
 * Format a timestamp in seconds to a display string.
 *
 * @param seconds - Time in seconds
 * @returns Formatted string (MM:SS or HH:MM:SS for times >= 1 hour)
 */
export function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00'
  }

  const totalSeconds = Math.floor(seconds)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const secs = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

/**
 * Read a time a person typed: "75", "1:15", "1:15.5" or "1:02:03". Returns
 * seconds, or null when it is not a time (minutes and seconds past 59 are
 * refused so a typo does not silently move a line an hour).
 */
export function parseTypedTime(text: string): number | null {
  const parts = text.trim().split(':')
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null
  const nums = parts.map(Number)
  if (nums.slice(0, -1).some((n) => !Number.isInteger(n))) return null
  if (nums.length > 1 && nums[nums.length - 1] >= 60) return null
  if (nums.length === 3 && nums[1] >= 60) return null
  return nums.reduce((total, n) => total * 60 + n, 0)
}
