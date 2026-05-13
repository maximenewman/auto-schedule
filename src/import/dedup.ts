import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import {
  deleteSubject,
  loadSubjects,
  type Subject,
} from '../config/subjectsStore.js';
import type { StateStore } from '../state/store.js';
import { logger } from '../logger.js';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? 'primary';
const HIDDEN_IDS = new Set(['holidays']);

export interface DedupSuggestion {
  fromId: string;
  intoId: string;
  fromCode: string;
  intoCode: string;
  reason: string;
  fromEventCount: number;
}

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

function normalize(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase();
}

/**
 * Detect pairs of subjects that almost certainly refer to the same course.
 *
 * Current heuristic: one subject's normalised id/code equals another's plus a
 * single trailing letter (the SFU section letter — D1, E1, etc.). This is
 * how iCal-created subjects collide with PDF-bootstrapped ones when an early
 * regex bug captured the section into the course number. The function is
 * deliberately conservative — it suggests merges, the user confirms.
 */
export function findDuplicateSubjects(
  subjects: Subject[],
  store: StateStore,
): DedupSuggestion[] {
  const candidates = subjects.filter((s) => !HIDDEN_IDS.has(s.id));
  const out: DedupSuggestion[] = [];

  for (const a of candidates) {
    for (const b of candidates) {
      if (a.id === b.id) continue;
      const aKey = normalize(a.code || a.id);
      const bKey = normalize(b.code || b.id);
      // a is canonical, b is duplicate if b == a + single letter.
      if (bKey.length === aKey.length + 1 && bKey.startsWith(aKey)) {
        // Already pushed in the other order? skip
        if (out.some((s) => s.fromId === b.id && s.intoId === a.id)) continue;
        const count = store.listCalendarItems({ subjectId: b.id }).length;
        out.push({
          fromId: b.id,
          intoId: a.id,
          fromCode: b.code || b.id,
          intoCode: a.code || a.id,
          reason: `"${bKey}" is "${aKey}" with a section letter — likely the same course.`,
          fromEventCount: count,
        });
      }
    }
  }
  return out;
}

/**
 * Merge one subject into another. Steps, in order:
 *   1. (optional) Delete every Google Calendar event whose id was derived
 *      from the duplicate subject — otherwise the next sync would create
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
    const rows = store.listCalendarItems({ subjectId: fromId });
    for (const r of rows) {
      try {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: r.eventId });
        result.googleEventsDeleted++;
      } catch (err) {
        const status =
          (err as { code?: number; status?: number }).code ??
          (err as { status?: number }).status;
        if (status === 404 || status === 410) {
          // Already gone — count as success for this audit's purposes.
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

  result.localItemsDeleted = store.deleteCalendarItemsForSubject(fromId);
  result.localSyncedEventsDeleted = store.deleteSyncedEventsForSubject(fromId);
  deleteSubject(fromId);

  logger.info(result, 'dedup: merge complete');
  return result;
}
