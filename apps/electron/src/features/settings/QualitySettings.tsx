/**
 * Settings > Quality checks: the Developer > Advanced panel over the
 * `quality` config section.
 */
import { AdvancedSettings } from './AdvancedSettings'
import { QUALITY_GROUPS, QUALITY_SETTINGS } from './quality-settings'

export function QualitySettings() {
  return (
    <AdvancedSettings
      settings={QUALITY_SETTINGS}
      groups={QUALITY_GROUPS}
      title="Quality checks"
      intro="The thresholds the app uses to judge recordings and transcripts. Each saves when you leave the field; Reset puts back the default."
      testId="settings-quality"
    />
  )
}
