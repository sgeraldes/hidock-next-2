import { useCallback, useEffect, useRef, useState } from 'react'
import { registerElementMedia, type ElementMediaMeta } from '@/store/useMediaSessionStore'

/**
 * Joins a page-owned <audio> or <video> to the app-wide media session: it pauses
 * whatever else plays when it starts, and the header shows and drives it.
 *
 * Returns a callback ref for the element.
 */
export function useExclusiveMedia(meta: ElementMediaMeta): (element: HTMLMediaElement | null) => void {
  const [element, setElement] = useState<HTMLMediaElement | null>(null)
  const metaRef = useRef(meta)
  metaRef.current = meta
  useEffect(() => (element ? registerElementMedia(element, () => metaRef.current) : undefined), [element])
  return useCallback((node: HTMLMediaElement | null) => setElement(node), [])
}
