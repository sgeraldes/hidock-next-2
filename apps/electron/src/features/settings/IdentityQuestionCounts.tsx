/**
 * Settings > Speakers & voices: how many identity questions of each kind are still waiting, how
 * many the app decided by itself, and how many the owner decided (spec 2026-10-03, Phase 4).
 * One read (identity:getQuestionCounts) when the panel opens.
 */
import { useEffect, useState } from 'react'
import { Working } from '@/components/ui/working'
import { appLocale } from '@/lib/locale'
import type { QuestionCounts, QuestionKind } from '@/shared/identity-review'

const KIND_LABEL: Record<QuestionKind, string> = {
  'shared-first-names': 'Shared first names',
  'duplicate-people': 'Duplicate people',
  speakers: 'Speakers',
  voices: 'Voices',
  'voice-conflicts': 'Voice conflicts'
}

const count = (n: number) => n.toLocaleString(appLocale())

export function IdentityQuestionCounts() {
  const [counts, setCounts] = useState<QuestionCounts | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await window.electronAPI?.identity?.getQuestionCounts?.()
        if (!alive) return
        if (!res) setUnavailable(true)
        else if (res.success) setCounts(res.data)
        else setFailure(res.error.message)
      } catch {
        if (alive) setFailure('The question counts could not be read. Reopen Settings to try again.')
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  if (unavailable) return null

  return (
    <section aria-labelledby="identity-questions-heading" className="space-y-3 rounded-xl bg-muted/45 p-4 shadow-sm">
      <div>
        <h3 id="identity-questions-heading" className="text-sm font-semibold">
          Identity questions
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Who is who in your recordings: what is still waiting in People, what the app decided by itself, and what you
          decided.
        </p>
      </div>

      {failure ? (
        <p role="alert" className="text-xs text-amber-800 dark:text-amber-300">
          {failure}
        </p>
      ) : counts === null ? (
        <Working label="Counting identity questions" shape="lines" rows={4} />
      ) : (
        <table aria-labelledby="identity-questions-heading" className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th scope="col" className="py-1.5 pr-3 text-left font-medium">
                Question
              </th>
              <th scope="col" className="px-3 py-1.5 text-right font-medium">
                Pending
              </th>
              <th scope="col" className="px-3 py-1.5 text-right font-medium">
                Decided automatically
              </th>
              <th scope="col" className="py-1.5 pl-3 text-right font-medium">
                Decided by you
              </th>
            </tr>
          </thead>
          <tbody>
            {counts.rows.map((row) => (
              <tr key={row.kind} className="border-b last:border-0">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                  {KIND_LABEL[row.kind]}
                </th>
                <td className="px-3 py-1.5 text-right tabular-nums">{count(row.pending)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{count(row.automatic)}</td>
                <td className="py-1.5 pl-3 text-right tabular-nums">{count(row.owner)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
