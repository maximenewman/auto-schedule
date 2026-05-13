import { google, type calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { CalendarItemRow } from '../state/store.js';
import type { StateStore } from '../state/store.js';
import { logger } from '../logger.js';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? 'primary';

export interface ListEventsOptions {
  fromISO?: string;
  toISO?: string;
  subjectId?: string;
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
  const localRows = store.listCalendarItems(
    opts.subjectId ? { subjectId: opts.subjectId } : {},
  );
  const localById = new Map<string, CalendarItemRow>();
  for (const r of localRows) localById.set(r.eventId, r);

  const out: CalendarItemRow[] = [];
  for (const ev of items) {
    if (!ev.id) continue;
    // For recurring instances Google emits `<masterId>_<occurrenceTimestamp>`
    // and exposes `recurringEventId` pointing at the master. Either one
    // should match a row we wrote when bootstrapping / syncing.
    const masterKey = ev.recurringEventId ?? ev.id;
    const local = localById.get(masterKey);
    if (!local) continue;
    if (opts.subjectId && local.subjectId !== opts.subjectId) continue;

    const startISO = ev.start?.dateTime ?? ev.start?.date ?? null;
    const endISO = ev.end?.dateTime ?? ev.end?.date ?? startISO;
    if (!startISO || !endISO) continue;

    out.push({
      eventId: ev.id,
      subjectId: local.subjectId,
      itemId: local.itemId,
      kind: local.kind,
      // Prefer the Google value  -  if the user edited it on Google, we
      // surface that. Fall back to the local cache when Google has nothing.
      summary: ev.summary ?? local.summary,
      description: ev.description ?? local.description,
      startISO,
      endISO,
      room: ev.location ?? local.room,
      attachments: local.attachments,
      recurrence: null,
      sourceLabel: local.sourceLabel,
      lastSyncedAt: local.lastSyncedAt,
    });
  }
  logger.info(
    {
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      googleCount: items.length,
      matchedLocal: out.length,
      subjectId: opts.subjectId,
    },
    'google calendar read',
  );
  return out;
}
