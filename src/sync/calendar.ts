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

function strEq(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '') === (b ?? '');
}

function dateTimeEq(
  a: calendar_v3.Schema$EventDateTime | undefined,
  b: calendar_v3.Schema$EventDateTime | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const aStr = a.dateTime ?? a.date ?? '';
  const bStr = b.dateTime ?? b.date ?? '';
  if (!aStr && !bStr) return true;
  if (!aStr || !bStr) return false;
  if (aStr === bStr) return true;
  // Same instant in different timezone formats? `2026-05-13T13:30:00-07:00`
  // and `2026-05-13T20:30:00Z` are equal — Google often returns events with
  // a normalised UTC `Z` form even though we wrote them with a -07:00
  // offset. Without this fallback we'd PATCH every recurring event on
  // every sync because the strings differ.
  const aMs = Date.parse(aStr);
  const bMs = Date.parse(bStr);
  if (Number.isNaN(aMs) || Number.isNaN(bMs)) return false;
  return aMs === bMs;
}

function recurrenceEq(a: string[] | undefined, b: string[] | undefined): boolean {
  const an = a ?? [];
  const bn = b ?? [];
  if (an.length !== bn.length) return false;
  for (let i = 0; i < an.length; i++) if (an[i] !== bn[i]) return false;
  return true;
}

/** Build a PATCH body with a per-field policy:
 *
 *  - `summary` and `description` are the fields the user is most likely to
 *    edit by hand on Google Calendar. We keep fill-only-empty for them so
 *    a handwritten title or note doesn't get clobbered by the source.
 *  - `location`, `start`, `end`, and `recurrence` are structural fields
 *    driven entirely by the source (iCal feed, PDF schedule). If the
 *    source says the room moved or the lecture time shifted, push it
 *    through — even if Google's existing value is non-empty. Otherwise
 *    real updates never propagate, which is the bug.
 */
function buildPatch(
  existing: calendar_v3.Schema$Event,
  next: calendar_v3.Schema$Event,
): { patch: calendar_v3.Schema$Event; reasons: string[]; protectStructural: boolean } {
  const patch: calendar_v3.Schema$Event = {};
  const reasons: string[] = [];

  // Distinguish the two recurring shapes — they behave differently under
  // PATCH:
  //   - MASTER (has `recurrence`, no `recurringEventId`): PATCHing start/
  //     end/recurrence rewrites DTSTART for the whole series. Without a
  //     guard, a per-occurrence iCal item would slide every weekly meeting
  //     to its own date. We protect masters from non-recurring sources.
  //   - INSTANCE (has `recurringEventId`, no own `recurrence`): PATCH is
  //     exactly the operation Google offers for per-occurrence overrides
  //     (a room move on a single Tuesday, a one-off time shift). Letting
  //     patches flow here is what we actually want — the previous blanket
  //     `existingIsRecurring` check turned every iCal upsert into a noop.
  const existingIsMaster =
    (existing.recurrence?.length ?? 0) > 0 && !existing.recurringEventId;
  const nextIsRecurring = !!(next.recurrence && next.recurrence.length > 0);
  const protectStructural = existingIsMaster && !nextIsRecurring;

  if (isEmpty(existing.summary) && !isEmpty(next.summary)) {
    patch.summary = next.summary;
    reasons.push('summary:filled');
  }
  if (isEmpty(existing.description) && !isEmpty(next.description)) {
    patch.description = next.description;
    reasons.push('description:filled');
  }

  if (protectStructural) {
    return { patch, reasons, protectStructural };
  }

  if (!isEmpty(next.location) && !strEq(existing.location, next.location ?? null)) {
    patch.location = next.location;
    reasons.push(`location:${JSON.stringify(existing.location ?? '')}->${JSON.stringify(next.location ?? '')}`);
  }
  if (next.start && !dateTimeEq(existing.start ?? undefined, next.start)) {
    patch.start = next.start;
    reasons.push(`start:${existing.start?.dateTime ?? existing.start?.date ?? '-'}->${next.start.dateTime ?? next.start.date ?? '-'}`);
  }
  if (next.end && !dateTimeEq(existing.end ?? undefined, next.end)) {
    patch.end = next.end;
    reasons.push(`end:${existing.end?.dateTime ?? existing.end?.date ?? '-'}->${next.end.dateTime ?? next.end.date ?? '-'}`);
  }
  if (
    next.recurrence && next.recurrence.length > 0 &&
    !recurrenceEq(existing.recurrence ?? undefined, next.recurrence)
  ) {
    patch.recurrence = next.recurrence;
    reasons.push('recurrence:changed');
  }

  return { patch, reasons, protectStructural };
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

  // Soft-deleted on Google: `events.get` still returns the tombstoned
  // entity (with `status: "cancelled"`) but `events.list` filters it out
  // when `showDeleted: false`. That's why reconcile reports "missing" and
  // then every retry no-ops — the GET succeeds, the diff is empty against
  // the carcass, and the event is never revived. Undelete it the way
  // Google documents: PATCH it back to `confirmed` with the source body.
  // A fresh `events.insert` with the same id would 409.
  if (existing.status === 'cancelled') {
    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      requestBody: { ...resource, status: 'confirmed' },
    });
    await recordLocal();
    logger.info(
      { eventId, subjectId, itemId: event.itemId },
      'calendar restored (was cancelled on Google)',
    );
    return { eventId, action: 'inserted' };
  }

  const { patch, reasons, protectStructural } = buildPatch(existing, resource);
  if (Object.keys(patch).length === 0) {
    await recordLocal();
    // Distinguish the two real shapes of "noop": either the source really
    // did match Google, or `protectStructural` blocked us from touching
    // start/end/location/recurrence because the existing event is a
    // recurring instance the iCal item is routing through. The latter
    // means upstream changes WILL silently fail to propagate — that's
    // worth surfacing.
    if (protectStructural) {
      logger.info(
        {
          eventId, subjectId, itemId: event.itemId,
          incomingStart: resource.start?.dateTime ?? resource.start?.date,
          existingStart: existing.start?.dateTime ?? existing.start?.date,
          incomingLocation: resource.location,
          existingLocation: existing.location,
        },
        'calendar unchanged (recurring event; structural updates skipped to protect the master)',
      );
    } else {
      logger.info(
        { eventId, subjectId, itemId: event.itemId },
        'calendar unchanged (source matches Google)',
      );
    }
    return { eventId, action: 'noop' };
  }
  await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    requestBody: patch,
  });
  await recordLocal();
  logger.info(
    {
      eventId, subjectId, itemId: event.itemId,
      fields: Object.keys(patch),
      reasons,
    },
    'calendar patched',
  );
  return { eventId, action: 'updated' };
}
