import { cn } from '@/lib/utils'
import './brand.css'
export type BrandDividerMode = 'titlebar' | 'sidebar' | 'both'
export const BRAND_DIVIDER_MODE: BrandDividerMode = 'titlebar'
export const showBrandVerticalDivider = (mode: BrandDividerMode = BRAND_DIVIDER_MODE): boolean => mode !== 'titlebar'
export const showBrandHorizontalDivider = (mode: BrandDividerMode = BRAND_DIVIDER_MODE): boolean => mode !== 'sidebar'
interface BrandProps {
  placement?: 'titlebar' | 'sidebar'
  collapsed?: boolean
  onHome?: () => void
  className?: string
}
/** Approved joined symbol + ext lockup. Keep the navigation rail's 32px icon axis. */
export function Brand({ placement = 'titlebar', collapsed = false, onHome, className }: BrandProps) {
  const content = <><AppMark />{!collapsed && <span className="next-wordmark">ext</span>}</>
  const classes = cn('next-brand', onHome && 'titlebar-no-drag focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400', className)
  return onHome
    ? <button type="button" className={classes} onClick={onHome} aria-label="Go to home" title="Next — go to home" data-testid="app-brand" data-placement={placement}>{content}</button>
    : <div className={classes} role="img" aria-label="Next" data-testid="app-brand" data-placement={placement}>{content}</div>
}
export function AppMark() {
  return <svg className="next-symbol" viewBox="-21 -12 616 640" aria-hidden="true"><path fill="#31B8E8" d="M28 0 H175 Q200 0 200 25 V225 Q200 243 185 254 L151 281 Q143 288 143 301 V337 Q143 351 157 342 L359 201 Q374 191 374 174 V25 Q374 0 399 0 H549 Q574 0 574 25 V591 Q574 616 549 616 H399 Q374 616 374 591 V391 Q374 374 389 363 L421 338 Q429 331 429 318 V295 Q429 279 415 288 L215 428 Q200 438 200 455 V591 Q200 616 175 616 H28 Q0 616 0 588 V28 Q0 0 28 0 Z" /></svg>
}
