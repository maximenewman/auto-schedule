import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import {
  deleteSubject,
  loadSubjects,
} from '../config/subjectsStore.js';
import type { StateStore } from '../state/store.js';
import { logger } from '../logger.js';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? 'primary';

export interface MergeOptions {
  fromId: string;
  intoId: string;
  store: StateStore;
  googleAuth?: OAuth2Client;
  /** If true, delete the orphan Google events under the duplicate's old IDs
   *  so the next sync recreates them cleanly under the canonical subject's
   *  event-id prefix. Without this you'll see duplicates on Google until
   *  manually deleted. */
  deleteGoogleEvents?: boolean;
}

export interface MergeResult {
  fromId: string;
  intoId: string;
  googleEventsDeleted: number;
  googleDeleteFailures: number;
  localItemsDeleted: number;
  localSyncedEventsDeleted: number;
}

/**
 * Merge one subject into another. Steps, in order:
 *   1. (optional) Delete every Google Calendar event whose id was derived
 *      from the duplicate subject  -  otherwise the next sync would create
 *      a fresh event under the canonical id alongside the orphan.
 *   2. Drop the local DB rows tied to the duplicate (calendar_items +
 *      synced_events). The next sync will recreate them under canonical
 *      ids via the existing upsertEvent path.
 *   3. Remove the duplicate subject row.
 */
export async function mergeSubject(opts: MergeOptions): Promise<MergeResult> {
  const { fromId, intoId, store, googleAuth, deleteGoogleEvents } = opts;
  if (fromId === intoId) {
    throw new Error('mergeSubject: from and into are the same');
  }
  const subjects = loadSubjects();
  const from = subjects.find((s) => s.id === fromId);
  const into = subjects.find((s) => s.id === intoId);
  if (!from) throw new Error(`subject "${fromId}" not found`);
  if (!into) throw new Error(`subject "${intoId}" not found`);

  const result: MergeResult = {
    fromId,
    intoId,
    googleEventsDeleted: 0,
    googleDeleteFailures: 0,
    localItemsDeleted: 0,
    localSyncedEventsDeleted: 0,
  };

  if (deleteGoogleEvents && googleAuth) {
    const calendar = google.calendar({ version: 'v3', auth: googleAuth });
    const rows = await store.listCalendarItems({ subjectId: fromId });
    for (const r of rows) {
      try {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: r.eventId });
        result.googleEventsDeleted++;
      } catch (err) {
        const status =
          (err as { code?: number; status?: number }).code ??
          (err as { status?: number }).status;
        if (status === 404 || status === 410) {
          // Already gone  -  count as success for this audit's purposes.
          result.googleEventsDeleted++;
        } else {
          result.googleDeleteFailures++;
          logger.warn(
            { err, eventId: r.eventId },
            'dedup: failed to delete google event',
          );
        }
      }
    }
  }

  result.localItemsDeleted = await store.deleteCalendarItemsForSubject(fromId);
  result.localSyncedEventsDeleted = await store.deleteSyncedEventsForSubject(fromId);
  deleteSubject(fromId);

  logger.info(result, 'dedup: merge complete');
  return result;
}

export interface MergeEventOptions {
  canonicalEventId: string;
  redundantEventIds: string[];
  store: StateStore;
  googleAuth: OAuth2Client;
}

export interface MergeEventResult {
  canonicalEventId: string;
  googleEventsDeleted: number;
  googleDeleteFailures: number;
  redirectsRecorded: number;
  localRowsDeleted: number;
}

/**
 * Collapse one or more redundant calendar events into a canonical one. For
 * each redundant id we look up the local row that produced it (so we know
 * which (subject_id, item_id) needs to be redirected), delete the Google
 * event, drop the local rows, and record a redirect so the next sync routes
 * that same (subject_id, item_id) into the canonical event instead of
 * recreating the duplicate.
 */
export async function mergeEvent(opts: MergeEventOptions): Promise<MergeEventResult> {
  const { canonicalEventId, redundantEventIds, store, googleAuth } = opts;
  const calendar = google.calendar({ version: 'v3', auth: googleAuth });
  const result: MergeEventResult = {
    canonicalEventId,
    googleEventsDeleted: 0,
    googleDeleteFailures: 0,
    redirectsRecorded: 0,
    localRowsDeleted: 0,
  };

  for (const redundant of redundantEventIds) {
    if (redundant === canonicalEventId) continue;
    // Look up the local row so we know what (subject_id, item_id) to redirect.
    const allRows = await store.listCalendarItems({});
    const rows = allRows.filter((r) => r.eventId === redundant);
    for (const row of rows) {
      await store.setEventRedirect(row.subjectId, row.itemId, canonicalEventId);
      result.redirectsRecorded++;
    }

    try {
      await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: redundant });
      result.googleEventsDeleted++;
    } catch (err) {
      const status =
        (err as { code?: number; status?: number }).code ??
        (err as { status?: number }).status;
      if (status === 404 || status === 410) {
        result.googleEventsDeleted++;
      } else {
        result.googleDeleteFailures++;
        logger.warn({ err, eventId: redundant }, 'dedup: failed to delete google event');
      }
    }

    // Local rows pointing at the redundant event id are no longer useful  - 
    // the data lives on the canonical event going forward.
    result.localRowsDeleted += await store.deleteCalendarItemByEventId(redundant);
  }

  logger.info(result, 'dedup: event merge complete');
  return result;
}
