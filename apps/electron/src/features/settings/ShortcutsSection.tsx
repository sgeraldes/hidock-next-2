/**
 * Settings > Shortcuts: the keys the app answers to (settings spec, phase 5).
 * Each row names where its handler lives, so a change there is a change here.
 */
// The title bar's check, so both show the same key.
const isMac =
  typeof navigator !== 'undefined' &&
  /mac/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
      navigator.platform ||
      ''
  )
const mod = isMac ? '⌘' : 'Ctrl'

export interface Shortcut {
  keys: string[]
  action: string
  where: string
  /** The file that handles it, for whoever changes it. */
  source: string
}

export const SHORTCUTS: Shortcut[] = [
  { keys: [mod, 'K'], action: 'Search knowledge, people and projects', where: 'Anywhere', source: 'components/layout/TitleBar.tsx' },
  { keys: [mod, 'V'], action: 'Add a copied screenshot as an image capture', where: 'Anywhere, when the clipboard holds an image', source: 'hooks/useClipboardCapture.ts' },
  { keys: [mod, 'N'], action: 'New note', where: 'Notes', source: 'pages/Notes.tsx' },
  { keys: [mod, 'Enter'], action: 'Save the transcript line you are editing', where: 'A transcript, while editing a line', source: 'features/library/components/TranscriptViewer.tsx' },
  { keys: ['Esc'], action: 'Cancel the edit, or close the assistant, a panel or the activity log', where: 'Anywhere', source: 'TranscriptViewer, FloatingAssistant, OperationsPanel, ActivityLogButton' },
  { keys: ['Enter'], action: 'Open the first page that matches', where: 'The Settings search box', source: 'features/settings/SettingsNav.tsx' }
]

export function ShortcutsSection() {
  return (
    <section className="rounded-lg border border-border bg-card p-4" data-testid="settings-shortcuts">
      <h3 className="text-sm font-semibold">Keyboard shortcuts</h3>
      <p className="text-xs text-muted-foreground">The keys HiDock answers to. They cannot be changed yet.</p>
      <table className="mt-3 w-full text-sm">
        <thead className="sr-only">
          <tr>
            <th>Keys</th>
            <th>What it does</th>
            <th>Where</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={`${s.keys.join('+')}-${s.where}`} className="border-b border-border align-top last:border-b-0">
              <td className="whitespace-nowrap py-2 pr-4">
                {s.keys.map((k, i) => (
                  <span key={k}>
                    {i > 0 && <span className="px-0.5 text-muted-foreground">+</span>}
                    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">{k}</kbd>
                  </span>
                ))}
              </td>
              <td className="py-2 pr-4">{s.action}</td>
              <td className="py-2 text-xs text-muted-foreground">{s.where}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
