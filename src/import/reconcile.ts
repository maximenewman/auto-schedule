/**
 * Cascading delete for a subject removal. Wipes every Google Calendar event
 * tied to the subject, drops the local `calendar_items` + `synced_events`
 * rows, then removes the subject row itself. The Google-side deletion is
 * best-effort — a 404/410 (already gone) counts as success; any other
 * failure is logged but doesn't halt the cascade.
 *
 * The previous "push missing local events back to Google" reconcile pass
 * lived here too. It's gone now: cancelled-event revival happens inline
 * inside `upsertEvent` (see `existing.status === 'cancelled'`), so the
 * iCal sync loop catches everything the reconcile pass used to.
 */

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import {
  deleteSubject,
  findSubject,
} from '../config/subjectsStore.js';
import type { StateStore } from '../state/store.js';
import { logger } from '../logger.js';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? 'primary';

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
