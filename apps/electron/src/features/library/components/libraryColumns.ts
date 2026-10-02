/**
 * Widths of the columns of a wide Library row. The row (SourceRow) and the
 * column header above the list (LibraryColumnHeader) read the same values, so a
 * header sits over the column it names.
 */
export const COLUMN_WIDTH = {
  date: 'w-28',
  time: 'w-16',
  duration: 'w-14',
  chips: 'w-40'
} as const

/**
 * Widths of the three icon places at the right of a row, shared with the header
 * cells above them. The file and transcript places are wide enough for "100%",
 * so a download or a transcription shows its percentage in its own place and no
 * row grows wider than the others (owner, 2-oct-2026).
 */
export const PLACE_WIDTH = {
  meeting: 'w-4',
  status: 'w-7',
  transcription: 'w-7'
} as const

export type PlaceName = keyof typeof PLACE_WIDTH

/** Height of the sticky header row, in px. The list scrolls a row clear of it. */
export const COLUMN_HEADER_HEIGHT_PX = 28
