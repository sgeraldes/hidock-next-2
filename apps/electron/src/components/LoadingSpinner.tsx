import { Working } from '@/components/ui/working'

interface LoadingSpinnerProps {
  /** What is loading, for the tooltip and screen readers ("Loading library..."). Never shown as text. */
  message?: string
  /** Additional CSS classes for the container */
  className?: string
}

/**
 * The fallback a page shows while it loads: the shape of a page with a moving
 * shimmer and a spinner. The message goes to the tooltip and screen readers;
 * a sentence on screen does not look like work (owner, 2-oct-2026).
 *
 * @example
 * <Suspense fallback={<LoadingSpinner message="Loading page..." />}>
 *   <LazyComponent />
 * </Suspense>
 */
export function LoadingSpinner({
  message = 'Loading',
  className = ''
}: LoadingSpinnerProps): React.ReactElement {
  const label = message.replace(/(\.\.\.|…)\s*$/, '').trim() || 'Loading'
  return <Working label={label} shape="page" rows={6} className={`min-h-[200px] p-6 ${className}`} />
}
