import { google, type calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { CalendarEvent } from '../agent/schema.js';
import { logger } from '../logger.js';
import type { StateStore } from '../state/store.js';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? 'primary';
const TIME_ZONE = 'America/Vancouver';

/**
 * Google Calendar event IDs must be base32hex (a-v + 0-9), 5–1024 chars, lowercase.
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
      // Everything else (spaces, punctuation) → '0'.
      return '0';
    })
    .join('');
  // Squeeze any runs that became >1 zero, and trim leading zeros (must still be ≥5 chars).
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
  return {
    summary: event.summary,
    description: descriptionParts.join('\n'),
    location: event.room ?? undefined,
    start: { dateTime: event.startDateTime, timeZone: TIME_ZONE },
    end: { dateTime: event.endDateTime, timeZone: TIME_ZONE },
  };
}

export async function upsertEvent(
  auth: OAuth2Client,
  subjectId: string,
  event: CalendarEvent,
  store?: StateStore,
): Promise<{ eventId: string; action: 'inserted' | 'updated' }> {
  const calendar = google.calendar({ version: 'v3', auth });
  const eventId = sanitizeEventId(subjectId, event.itemId);
  const resource = toCalendarResource(event);

  try {
    await calendar.events.update({
      calendarId: CALENDAR_ID,
      eventId,
      requestBody: { id: eventId, ...resource },
    });
    store?.recordSyncedEvent(eventId, subjectId, event.itemId);
    logger.info({ eventId, subjectId, itemId: event.itemId }, 'calendar updated');
    return { eventId, action: 'updated' };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code
      ?? (err as { status?: number }).status;
    if (status === 404) {
      await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: { id: eventId, ...resource },
      });
      store?.recordSyncedEvent(eventId, subjectId, event.itemId);
      logger.info({ eventId, subjectId, itemId: event.itemId }, 'calendar inserted');
      return { eventId, action: 'inserted' };
    }
    throw err;
  }
}
