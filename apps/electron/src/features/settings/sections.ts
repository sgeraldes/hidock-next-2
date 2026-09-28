/**
 * Settings sections: the menu on the left of Settings and the page each item
 * opens (owner, 28-sep-2026: menu-driven Settings in the Kiro Crew style).
 *
 * Order here is the order in the menu. `keywords` feed the search box, so a
 * search for "token" or "ollama" finds the page that holds it.
 */

import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard,
  ToggleRight,
  MessageSquare,
  CalendarDays,
  ShieldCheck,
  AudioLines,
  Users,
  Brain,
  Plug,
  Scale,
  HardDrive,
  Wrench,
  Code2,
  History,
  Info,
  PlayCircle,
  Monitor,
  Mic,
  KeyRound
} from 'lucide-react'

export type SettingsSectionId =
  | 'overview'
  | 'features'
  | 'display'
  | 'assistant'
  | 'calendar'
  | 'player'
  | 'recording'
  | 'privacy'
  | 'transcription'
  | 'speakers'
  | 'ai-providers'
  | 'connectors'
  | 'decisions'
  | 'storage'
  | 'secrets'
  | 'maintenance'
  | 'developer'
  | 'releases'
  | 'about'

export type SettingsGroupId = 'general' | 'preferences' | 'services' | 'system'

export interface SettingsSection {
  id: SettingsSectionId
  group: SettingsGroupId
  label: string
  /** One line under the page title. */
  description: string
  icon: LucideIcon
  keywords: string[]
}

export const SETTINGS_GROUP_LABELS: Record<SettingsGroupId, string | null> = {
  general: null,
  preferences: 'Preferences',
  services: 'Services',
  system: 'System'
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'overview',
    group: 'general',
    label: 'Overview',
    description: 'What is set up, what is running, and what needs attention.',
    icon: LayoutDashboard,
    keywords: ['status', 'health', 'summary']
  },
  {
    id: 'features',
    group: 'general',
    label: 'Features',
    description: 'Which parts of HiDock are turned on.',
    icon: ToggleRight,
    keywords: ['preset', 'library only', 'modules', 'enable', 'disable']
  },
  {
    id: 'display',
    group: 'preferences',
    label: 'Display',
    description: 'The theme and how dates, times and numbers look.',
    icon: Monitor,
    keywords: ['theme', 'dark', 'light', 'language', 'locale', 'date', 'time', 'format', 'region']
  },
  {
    id: 'assistant',
    group: 'preferences',
    label: 'Assistant',
    description: 'Where the assistant sits and how much of your library it reads per answer.',
    icon: MessageSquare,
    keywords: ['chat', 'rag', 'context', 'floating', 'docked', 'ollama']
  },
  {
    id: 'calendar',
    group: 'preferences',
    label: 'Calendar',
    description: 'Your calendar feed and how often it syncs.',
    icon: CalendarDays,
    keywords: ['ics', 'meetings', 'sync', 'outlook']
  },
  {
    id: 'player',
    group: 'preferences',
    label: 'Player & notifications',
    description: 'Skip length, speeds, the starting speed and how long notices stay.',
    icon: PlayCircle,
    keywords: ['audio', 'playback', 'speed', 'skip', 'toast', 'notice', 'seconds']
  },
  {
    id: 'recording',
    group: 'preferences',
    label: 'Recording',
    description: 'How recordings arrive from the HiDock, and where they go.',
    icon: Mic,
    keywords: ['auto-record', 'record', 'device', 'hidock', 'download', 'connect', 'microphone', 'mic']
  },
  {
    id: 'privacy',
    group: 'preferences',
    label: 'Privacy & capture',
    description: 'What HiDock collects on its own.',
    icon: ShieldCheck,
    keywords: ['clipboard', 'screenshots', 'capture']
  },
  {
    id: 'transcription',
    group: 'services',
    label: 'Transcription',
    description: 'The provider that turns recordings into transcripts, and its settings.',
    icon: AudioLines,
    keywords: ['gemini', 'local asr', 'vibevoice', 'api key', 'model', 'live', 'microphone']
  },
  {
    id: 'speakers',
    group: 'services',
    label: 'Speakers & voices',
    description: 'How speakers are told apart and recognized, and the model host.',
    icon: Users,
    keywords: ['hugging face', 'token', 'pyannote', 'diarization', 'voice', 'model host', 'gpu']
  },
  {
    id: 'ai-providers',
    group: 'services',
    label: 'AI providers',
    description: 'Which AI provider powers analysis, chat and outputs.',
    icon: Brain,
    keywords: ['brains', 'claude', 'codex', 'kiro', 'embeddings', 'cpu']
  },
  {
    id: 'connectors',
    group: 'services',
    label: 'Connectors',
    description: 'Microsoft 365, Slack and other systems that feed your library.',
    icon: Plug,
    keywords: ['microsoft 365', 'm365', 'slack', 'outlook', 'channels', 'contacts']
  },
  {
    id: 'decisions',
    group: 'services',
    label: 'Decisions (Jev)',
    description: 'Jev rates recordings and checks transcripts. What it sends and what it decides.',
    icon: Scale,
    keywords: ['jev', 'typesafe', 'value', 'low value', 'garbage', 'stars', 'classify', 'scan']
  },
  {
    id: 'storage',
    group: 'system',
    label: 'Storage',
    description: 'Where recordings, transcripts and data live on this computer.',
    icon: HardDrive,
    keywords: ['folders', 'disk', 'path', 'data']
  },
  {
    id: 'secrets',
    group: 'system',
    label: 'Secrets',
    description: 'Every stored key and token: set or not, replace or remove.',
    icon: KeyRound,
    keywords: ['api key', 'token', 'password', 'credential', 'encrypted']
  },
  {
    id: 'maintenance',
    group: 'system',
    label: 'Maintenance',
    description: 'Jobs that refresh or repair what the Library shows.',
    icon: Wrench,
    keywords: ['rescan', 'warnings', 'relink', 'waveforms', 'health', 'repair', 'integrity']
  },
  {
    id: 'developer',
    group: 'system',
    label: 'Developer',
    description: 'Logging and diagnostics.',
    icon: Code2,
    keywords: ['qa', 'logs', 'debug']
  },
  {
    id: 'releases',
    group: 'system',
    label: 'Releases',
    description: 'What changed in each build.',
    icon: History,
    keywords: ['changelog', 'release notes', 'what is new', 'version']
  },
  {
    id: 'about',
    group: 'system',
    label: 'About',
    description: 'Version and where HiDock keeps its data.',
    icon: Info,
    keywords: ['version']
  }
]

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'overview'

export function isSettingsSectionId(value: string | undefined | null): value is SettingsSectionId {
  return !!value && SETTINGS_SECTIONS.some((s) => s.id === value)
}

export function getSettingsSection(id: SettingsSectionId): SettingsSection {
  return SETTINGS_SECTIONS.find((s) => s.id === id) ?? SETTINGS_SECTIONS[0]
}

/** Sections whose label, description or keywords contain every word of the query. */
export function searchSettingsSections(query: string): SettingsSection[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return SETTINGS_SECTIONS
  return SETTINGS_SECTIONS.filter((s) => {
    const haystack = [s.label, s.description, ...s.keywords].join(' ').toLowerCase()
    return words.every((w) => haystack.includes(w))
  })
}

/**
 * Old deep links used hash anchors on the single long page (`/settings#features`).
 * Map them to a section so they keep working.
 */
export function sectionFromLegacyHash(hash: string): SettingsSectionId | null {
  const id = hash.replace(/^#/, '')
  return isSettingsSectionId(id) ? id : null
}
