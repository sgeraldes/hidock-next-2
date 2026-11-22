export interface PasteSnapshot {
  files?: string[]
  png?: Uint8Array
  text?: string
}

export interface PasteResult {
  id?: string
  title: string
  error?: string
  warning?: string
  destination?: 'note'
  connectorFallback?: string
  textUnreadable?: boolean
}

export interface PasteLibraryAPI {
  paste: (snapshot?: PasteSnapshot) => Promise<PasteResult[]>
  pickFiles: () => Promise<PasteResult[]>
  newNote: () => Promise<PasteResult>
}
