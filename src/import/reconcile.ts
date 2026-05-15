/**
 * Two helpers that live on the same Google-Calendar boundary:
 *
 *   - `pushMissingLocalEvents` — local `calendar_items` is the source of
 *     truth for what *should* exist. If the user deleted an event on
 *     Google directly, we recreate it on the next sync. Symmetric to the
 *     upsert phase, which already does the same for fresh iCal entries.
 *
 *   - `deleteSubjectAndCalendar` — full cascade when a subject is removed
 *     in the UI: delete every Google Calendar event tied to that subject,
 *     drop the local `calendar_items` + `synced_events` rows, then remove
 *     the subject row itself. The Google-side deletion is best-effort —
 *     a 404/410 (already gone) counts as a success; any other failure is
 *     logged but doesn't stop the cascade.
 */

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import {
  deleteSubject,
  findSubject,
} from '../config/subjectsStore.js';
import type { CalendarEvent } from '../agent/schema.js';
import type { CalendarItemRow, StateStore } from '../state/store.js';
import { upsertEvent } from '../sync/calendar.js';
import { logger } from '../logger.js';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? 'primary';

export interface PushResult {
  googleCount: number;
  localChecked: number;
  /** Local rows whose `event_id` was missing from Google → upsertEvent
   *  called. Note this is just the *attempt* count; the next three break
   *  it down by what actually happened on Google. */
  pushed: number;
  inserted: number;
  updated: number;
  noop: number;
  failures: number;
}

export interface PushProgress {
  pushed: number;
  total: number;
  subjectId: string;
}

/** Re-create any local event that Google is missing. Called after the
 *  upsert phase so it catches events the user deleted on Google between
 *  syncs. The local DB stays untouched — it's our record of what should
 *  exist. */
export async function pushMissingLocalEvents(
  auth: OAuth2Client,
  store: StateStore,
  userId?: number,
  onProgress?: (e: PushProgress) => void,
): Promise<PushResult> {
  const calendar = google.calendar({ version: 'v3', auth });
  const now = Date.now();
  const fromISO = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const toISO = new Date(now + 180 * 24 * 60 * 60 * 1000).toISOString();

  // Paginate through every event Google currently has. `singleEvents`
  // turns RRULE masters into occurrences; we collect both the occurrence
  // id and the master `recurringEventId` so a recurring event we wrote
  // earlier matches whichever shape Google returns.
  const googleIds = new Set<string>();
  let pageToken: string | undefined;
  let googleCount = 0;
  do {
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: fromISO,
      timeMax: toISO,
      singleEvents: true,
      maxResults: 2500,
      pageToken,
      showDeleted: false,
    });
    for (const ev of res.data.items ?? []) {
      if (ev.id) googleIds.add(ev.id);
      if (ev.recurringEventId) googleIds.add(ev.recurringEventId);
      googleCount++;
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const localRows = await store.listCalendarItems({ fromISO, toISO }, userId);
  const missing = localRows.filter((r) => !googleIds.has(r.eventId));

  let pushed = 0;
  let inserted = 0;
  let updated = 0;
  let noop = 0;
  let failures = 0;
  for (const row of missing) {
    try {
      const event = reconstructCalendarEvent(row);
      const r = await upsertEvent(
        auth,
        row.subjectId,
        event,
        store,
        row.sourceLabel ?? 'reconcile:push',
        userId,
      );
      pushed++;
      if (r.action === 'inserted') inserted++;
      else if (r.action === 'updated') updated++;
      else noop++;
      onProgress?.({ pushed, total: missing.length, subjectId: row.subjectId });
    } catch (err) {
      failures++;
      logger.warn(
        { err: (err as Error).message, eventId: row.eventId, subjectId: row.subjectId },
        'reconcile: push failed',
      );
    }
  }

  const result: PushResult = {
    googleCount,
    localChecked: localRows.length,
    pushed,
    inserted,
    updated,
    noop,
    failures,
  };
  logger.info(result, 'reconcile: pushed missing local events back to Google');
  return result;
}

/** Build a fresh CalendarEvent from the stored row so upsertEvent can
 *  recreate the Google entry exactly as it was originally written. */
function reconstructCalendarEvent(row: CalendarItemRow): CalendarEvent {
  const event: CalendarEvent = {
    itemId: row.itemId,
    kind: row.kind,
    summary: row.summary,
    description: row.description,
    room: row.room,
    startDateTime: row.startISO,
    endDateTime: row.endISO,
    attachments: row.attachments,
  };
  if (row.recurrence && row.recurrence.length > 0) {
    event.recurrence = row.recurrence;
  }
  if (row.sectionCode) {
    event.sectionCode = row.sectionCode;
  }
  return event;
}

export interface DeleteSubjectResult {
  subjectId: string;
  googleEventsDeleted: number;
  googleDeleteFailures: number;
  localItemsDeleted: number;
  localSyncedEventsDeleted: number;
}

/** Cascading delete: wipe a subject's Google Calendar events first, then
 *  the local rows, then the subject row. Used by the dashboard's
 *  Delete-subject action. */
export async function deleteSubjectAndCalendar(
  subjectId: string,
  store: StateStore,
  googleAuth: OAuth2Client | null,
  userId?: number,
): Promise<DeleteSubjectResult> {
  const result: DeleteSubjectResult = {
    subjectId,
    googleEventsDeleted: 0,
    googleDeleteFailures: 0,
    localItemsDeleted: 0,
    localSyncedEventsDeleted: 0,
  };

  const existing = await findSubject(store, subjectId, userId);
  if (!existing) {
    // Nothing to do — let the caller decide whether 404 is an error.
    return result;
  }

  // 1. Delete Google events first. If auth is unavailable we still want
  //    the local cascade to run so the dashboard reflects the deletion.
  if (googleAuth) {
    const calendar = google.calendar({ version: 'v3', auth: googleAuth });
    const rows = await store.listCalendarItems({ subjectId }, userId);
    for (const r of rows) {
      try {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: r.eventId });
        result.googleEventsDeleted++;
      } catch (err) {
        const status =
          (err as { code?: number; status?: number }).code ??
          (err as { status?: number }).status;
        if (status === 404 || status === 410) {
          result.googleEventsDeleted++;
        } else {
          result.googleDeleteFailures++;
          logger.warn(
            { err, eventId: r.eventId, subjectId },
            'deleteSubject: failed to delete google event',
          );
        }
      }
    }
  }

  // 2. Local cascade. Calendar items first so a subject row removal can't
  //    leave orphaned references behind.
  result.localItemsDeleted = await store.deleteCalendarItemsForSubject(subjectId, userId);
  result.localSyncedEventsDeleted = await store.deleteSyncedEventsForSubject(subjectId, userId);
  await deleteSubject(store, subjectId, userId);

  logger.info(result, 'deleteSubject: cascade complete');
  return result;
}
