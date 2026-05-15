import { google, type calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { CalendarItemRow } from '../state/store.js';
import type { StateStore } from '../state/store.js';
import { loadSubjects } from '../config/subjectsStore.js';
import type { Subject } from '../config/subjects.js';
import { logger } from '../logger.js';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? 'primary';

export interface ListEventsOptions {
  fromISO?: string;
  toISO?: string;
  subjectId?: string;
  userId?: number;
}

/**
 * Read events directly from Google Calendar. The local SQLite cache is used
 * only to enrich each Google event with the subjectId/itemId/kind metadata
 * that lives outside Google. Anything Google has but the local DB doesn't
 * (e.g. user-added events) is skipped  -  the dashboard only shows events
 * tied to managed subjects.
 *
 * `singleEvents: true` asks Google to expand recurring events into their
 * individual instances, so the caller never has to interpret RRULEs.
 */
export async function listGoogleEvents(
  auth: OAuth2Client,
  store: StateStore,
  opts: ListEventsOptions = {},
): Promise<CalendarItemRow[]> {
  const calendar = google.calendar({ version: 'v3', auth });
  // Window: default to ~30 days back / 180 days forward so a typical term
  // is fully covered without unbounded paging.
  const now = Date.now();
  const timeMin = opts.fromISO ?? new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = opts.toISO ?? new Date(now + 180 * 24 * 60 * 60 * 1000).toISOString();

  const items: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500,
      pageToken,
    });
    if (res.data.items) items.push(...res.data.items);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  // Build a lookup: every locally-known event id (master event id for
  // recurrences) -> metadata we need to attach.
  const localRows = await store.listCalendarItems(
    opts.subjectId ? { subjectId: opts.subjectId } : {},
    opts.userId,
  );
  const localById = new Map<string, CalendarItemRow>();
  for (const r of localRows) localById.set(r.eventId, r);

  // Fallback attribution: when an event on Google has no local row (typical
  // after a dedup/merge that wiped the local cache, or for events created
  // before this user existed), try to recover the subject from the summary
  // by matching a course code against our subject list. Without this, the
  // events silently disappear from the UI.
  const allSubjects = await loadSubjects(store, opts.userId);
  const subjectsByNormCode = new Map<string, Subject>();
  for (const s of allSubjects) {
    subjectsByNormCode.set(normCode(s.id), s);
    if (s.code) subjectsByNormCode.set(normCode(s.code), s);
  }

  const out: CalendarItemRow[] = [];
  let viaLocal = 0;
  let viaSummary = 0;
  let unattributed = 0;
  const unattributedSample: string[] = [];
  for (const ev of items) {
    if (!ev.id) continue;
    const startISO = ev.start?.dateTime ?? ev.start?.date ?? null;
    const endISO = ev.end?.dateTime ?? ev.end?.date ?? startISO;
    if (!startISO || !endISO) continue;

    // For recurring instances Google emits `<masterId>_<occurrenceTimestamp>`
    // and exposes `recurringEventId` pointing at the master. Either one
    // should match a row we wrote when bootstrapping / syncing.
    const masterKey = ev.recurringEventId ?? ev.id;
    const local = localById.get(masterKey);

    let subjectId: string;
    let itemId: string;
    let kind: CalendarItemRow['kind'];
    let attachments: CalendarItemRow['attachments'] = [];
    let sourceLabel: string | null = null;
    let lastSyncedAt = '';
    let cachedSummary = '';
    let cachedDescription = '';
    let cachedRoom: string | null = null;

    if (local) {
      subjectId = local.subjectId;
      itemId = local.itemId;
      kind = local.kind;
      attachments = local.attachments;
      sourceLabel = local.sourceLabel;
      lastSyncedAt = local.lastSyncedAt;
      cachedSummary = local.summary;
      cachedDescription = local.description;
      cachedRoom = local.room;
      viaLocal++;
    } else {
      const guessed = guessSubjectFromSummary(ev.summary, subjectsByNormCode);
      if (!guessed) {
        unattributed++;
        if (unattributedSample.length < 3) {
          unattributedSample.push(
            `${ev.id} | ${ev.summary ?? '(no summary)'} | ${startISO}`,
          );
        }
        continue;
      }
      subjectId = guessed.id;
      itemId = ev.id;
      kind = 'other';
      sourceLabel = 'google';
      lastSyncedAt = new Date().toISOString();
      viaSummary++;
    }

    if (opts.subjectId && subjectId !== opts.subjectId) continue;

    out.push({
      eventId: ev.id,
      subjectId,
      itemId,
      kind,
      // Prefer the Google value  -  if the user edited it on Google, we
      // surface that. Fall back to the local cache when Google has nothing.
      summary: ev.summary ?? cachedSummary,
      description: ev.description ?? cachedDescription,
      startISO,
      endISO,
      room: ev.location ?? cachedRoom,
      attachments,
      recurrence: null,
      sourceLabel,
      lastSyncedAt,
    });
  }
  logger.info(
    {
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      googleCount: items.length,
      matchedLocal: viaLocal,
      matchedViaSummary: viaSummary,
      unattributed,
      unattributedSample,
      subjectId: opts.subjectId,
    },
    'google calendar read',
  );
  return out;
}

function normCode(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase();
}

function guessSubjectFromSummary(
  summary: string | null | undefined,
  index: Map<string, Subject>,
): Subject | null {
  if (!summary) return null;
  // Match the first "<DEPT> <NUM>" token in the summary, e.g. "CMPT 307 LEC".
  const m = /\b([A-Z]{2,4})\s*(\d{2,3}[A-Z]?)\b/.exec(summary);
  if (!m) return null;
  return index.get(normCode(`${m[1]}${m[2]}`)) ?? null;
}
