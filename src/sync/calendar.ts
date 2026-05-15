import { google, type calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { CalendarEvent } from '../agent/schema.js';
import { logger } from '../logger.js';
import type { StateStore } from '../state/store.js';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? 'primary';
const TIME_ZONE = 'America/Vancouver';

/**
 * Google Calendar event IDs must be base32hex (a-v + 0-9), 5-1024 chars, lowercase.
 * We normalize subject.id + itemId to that alphabet so the same item always
 * collides with itself across runs (upsert) and never with anything else.
 */
export function sanitizeEventId(subjectId: string, itemId: string): string {
  const raw = `${subjectId}-${itemId}`.toLowerCase();
  const mapped = raw
    .split('')
    .map((ch) => {
      if (/[0-9a-v]/.test(ch)) return ch;
      // Map disallowed letters w-z to a-d so info isn't lost completely.
      if (ch === 'w') return 'a0';
      if (ch === 'x') return 'b0';
      if (ch === 'y') return 'c0';
      if (ch === 'z') return 'd0';
      // Everything else (spaces, punctuation) -> '0'.
      return '0';
    })
    .join('');
  // Squeeze any runs that became >1 zero, and trim leading zeros (must still be >= 5 chars).
  const compact = mapped.replace(/0{2,}/g, '0');
  return compact.length < 5 ? compact.padEnd(5, '0') : compact;
}

function toCalendarResource(event: CalendarEvent): calendar_v3.Schema$Event {
  const descriptionParts = [event.description];
  if (event.attachments.length > 0) {
    descriptionParts.push('');
    descriptionParts.push('Attachments:');
    for (const a of event.attachments) {
      descriptionParts.push(`- ${a.filename}: ${a.url}`);
    }
  }
  const resource: calendar_v3.Schema$Event = {
    summary: event.summary,
    description: descriptionParts.join('\n'),
    location: event.room ?? undefined,
    start: { dateTime: event.startDateTime, timeZone: TIME_ZONE },
    end: { dateTime: event.endDateTime, timeZone: TIME_ZONE },
  };
  if (event.recurrence && event.recurrence.length > 0) {
    resource.recurrence = event.recurrence;
  }
  return resource;
}

function isEmpty(s: string | null | undefined): boolean {
  return s === undefined || s === null || s.trim() === '';
}

/** Build a patch body containing only fields where the existing event has no
 *  value. Anything the user has typed by hand on the calendar  -  a room change,
 *  a renamed summary, an added note  -  survives subsequent runs. */
function buildFillOnlyPatch(
  existing: calendar_v3.Schema$Event,
  next: calendar_v3.Schema$Event,
): calendar_v3.Schema$Event {
  const patch: calendar_v3.Schema$Event = {};
  if (isEmpty(existing.summary) && !isEmpty(next.summary)) {
    patch.summary = next.summary;
  }
  if (isEmpty(existing.description) && !isEmpty(next.description)) {
    patch.description = next.description;
  }
  if (isEmpty(existing.location) && !isEmpty(next.location)) {
    patch.location = next.location;
  }
  if (!existing.start?.dateTime && !existing.start?.date && next.start) {
    patch.start = next.start;
  }
  if (!existing.end?.dateTime && !existing.end?.date && next.end) {
    patch.end = next.end;
  }
  if (
    (!existing.recurrence || existing.recurrence.length === 0) &&
    next.recurrence && next.recurrence.length > 0
  ) {
    patch.recurrence = next.recurrence;
  }
  return patch;
}

export async function upsertEvent(
  auth: OAuth2Client,
  subjectId: string,
  event: CalendarEvent,
  store?: StateStore,
  sourceLabel?: string,
  userId?: number,
): Promise<{ eventId: string; action: 'inserted' | 'updated' | 'noop' }> {
  const calendar = google.calendar({ version: 'v3', auth });
  // The dedup agent records a redirect when it merges two events that came
  // from different sources (e.g. an iCal D1 lecture into a PDF LEC). Re-run
  // syncs honour that redirect so the same merge doesn't have to happen
  // again on every poll.
  const redirect = store ? await store.getEventRedirect(subjectId, event.itemId, userId) : null;
  const eventId = redirect ?? sanitizeEventId(subjectId, event.itemId);
  const resource = toCalendarResource(event);

  const recordLocal = async () => {
    if (!store) return;
    await store.recordSyncedEvent(eventId, subjectId, event.itemId, userId);
    await store.upsertCalendarItem(eventId, subjectId, event, sourceLabel ?? null, userId);
  };

  let existing: calendar_v3.Schema$Event | null = null;
  try {
    const got = await calendar.events.get({ calendarId: CALENDAR_ID, eventId });
    existing = got.data;
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code
      ?? (err as { status?: number }).status;
    if (status !== 404) throw err;
  }

  if (!existing) {
    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: { id: eventId, ...resource },
    });
    await recordLocal();
    logger.info({ eventId, subjectId, itemId: event.itemId }, 'calendar inserted');
    return { eventId, action: 'inserted' };
  }

  const patch = buildFillOnlyPatch(existing, resource);
  if (Object.keys(patch).length === 0) {
    await recordLocal();
    logger.info({ eventId, subjectId, itemId: event.itemId }, 'calendar unchanged (user value preserved)');
    return { eventId, action: 'noop' };
  }
  await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    requestBody: patch,
  });
  recordLocal();
  logger.info(
    { eventId, subjectId, itemId: event.itemId, fields: Object.keys(patch) },
    'calendar patched (filled empty fields only)',
  );
  return { eventId, action: 'updated' };
}
