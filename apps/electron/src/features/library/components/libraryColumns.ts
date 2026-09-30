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

/** Height of the sticky header row, in px. The list scrolls a row clear of it. */
export const COLUMN_HEADER_HEIGHT_PX = 28
