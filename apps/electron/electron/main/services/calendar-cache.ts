import { queryAll, run, type Meeting } from './database'
import { calendarWindow } from './calendar-window'

// Retain historical rows/FKs, but stop drawing source-confirmed deletions.
export const CONNECTOR_ACTIVE_TOKEN = 'connector:active'
export const CONNECTOR_DELETED_TOKEN = 'connector:deleted'
export const ICS_DELETED_TOKEN = 'ics:deleted'

export function getCachedCalendarMeetings(startDate?: string, endDate?: string): Meeting[] {
  const conditions = ['(calendar_sync_token IS NULL OR calendar_sync_token NOT IN (?, ?))']
  const params = [CONNECTOR_DELETED_TOKEN, ICS_DELETED_TOKEN]
  // Include events crossing midnight or the start of the visible range.
  if (endDate) { conditions.push('start_time <= ?'); params.push(new Date(endDate).toISOString()) }
  if (startDate) { conditions.push('end_time >= ?'); params.push(new Date(startDate).toISOString()) }
  return queryAll<Meeting>(`SELECT * FROM meetings WHERE ${conditions.join(' AND ')} ORDER BY start_time ASC`, params)
}

export function markConnectorMeetingDeleted(connectorId: string, externalId: string): void {
  if (!externalId) throw new Error('Missing deleted event id')
  run('UPDATE meetings SET calendar_sync_token = ? WHERE id = ?', [CONNECTOR_DELETED_TOKEN, `${connectorId}:${externalId}`])
}

/** Only after a full successful ICS pass; failed fetch/parse leaves the cache. */
export function retireMissingIcsMeetings(token: string, now = Date.now()): void {
  const { pastDays, futureDays } = calendarWindow()
  const start = new Date(now - pastDays * 86400000).toISOString()
  const end = new Date(now + futureDays * 86400000).toISOString()
  run(`UPDATE meetings SET calendar_sync_token = ?
    WHERE calendar_sync_token IS NOT NULL AND calendar_sync_token NOT IN (?, ?, ?, ?)
      AND id NOT LIKE 'm365:%' AND start_time >= ? AND start_time <= ?`,
  [ICS_DELETED_TOKEN, token, CONNECTOR_ACTIVE_TOKEN, CONNECTOR_DELETED_TOKEN, ICS_DELETED_TOKEN, start, end])
}
