import type { OAuth2Client } from 'google-auth-library';
import {
  createSubject,
  findSubject,
  loadSubjects,
  type Subject,
} from '../config/subjectsStore.js';
import type { Store } from '../state/store.js';
import type { CalendarEvent, EventKind } from '../agent/schema.js';
import type { StateStore } from '../state/store.js';
import { upsertEvent } from '../sync/calendar.js';
import { parseIcal, type IcalEvent } from '../sources/icalParser.js';
import { mergeSubject, mergeEvent } from './dedup.js';
import { planDedup } from './dedupAgent.js';
import { logger } from '../logger.js';

export type IcalProgress =
  | { stage: 'fetch'; status: 'start' }
  | { stage: 'fetch'; status: 'done'; fetched: number }
  | { stage: 'upsert'; status: 'start'; total: number }
  | { stage: 'upsert'; status: 'tick'; processed: number; total: number }
  | { stage: 'upsert'; status: 'done'; inserted: number; updated: number; unchanged: number; failures: number; subjectsCreated: number }
  | { stage: 'dedup'; status: 'analyzing' }
  | { stage: 'dedup'; status: 'tick'; processed: number; total: number; kind: 'subject' | 'event'; detail?: string }
  | { stage: 'dedup'; status: 'done'; subjectMerges: number; eventMerges: number; googleEventsDeleted: number; warning?: string }
  | { stage: 'done'; result: IcalRunResult }
  | { stage: 'error'; message: string };

export interface IcalRunResult {
  fetched: number;
  attributed: number;
  unattributed: number;
  subjectsCreated: number;
  eventsInserted: number;
  eventsUpdated: number;
  eventsUnchanged: number;
  failures: number;
  subjectMerges: number;
  eventMerges: number;
  googleEventsDeleted: number;
  dedupWarning?: string;
}

export const ICAL_URL_SETTING = 'coursys.ical_url';
export const HOLIDAYS_SUBJECT_ID = 'holidays';

// "CMPT 307" / "STAT 271"  -  a course code as it appears in the wild.
const COURSE_CODE_RE = /^([A-Z]{2,4})\s*(\d{2,3}[A-Z]?)$/;
// CourSys embeds the course code in every UID it emits, e.g.
//   "2026sucmpt307d1-1452740-20260512T143000-3@courses.cs.sfu.ca"
// breaks down as <YEAR><SEASON><DEPT><NUM>[<COURSE_SUFFIX>]<SECTION>-...
// where:
//   COURSE_SUFFIX is a single letter that's actually part of the course
//     number (e.g. "W" for writing-intensive courses like CMPT 320W).
//   SECTION is the section code  -  a letter (D, E, G, R, ...) followed by
//     digits (D1, D2, E1, ...).
// Capturing `\d{2,3}[a-z]?` was the original bug  -  it greedily absorbed
// the section letter into the course number, turning "cmpt307d1" into
// course "307D" instead of "307" + section "D1".
const COURSYS_UID_RE = /^\d{4}(?:sp|su|fa)([a-z]{2,4})(\d{2,3}[wu]?)(?:[a-z]\d+)?-/i;

export interface IcalSyncOptions {
  googleAuth: OAuth2Client;
  store: StateStore;
  userId?: number;
  baseFolder?: string;
}

export interface IcalSyncResult {
  fetched: number;
  attributed: number;
  unattributed: number;
  subjectsCreated: number;
  /** Events skipped because the would-be auto-created subject had no
   *  current/future lecture / tutorial / deadline anchoring it as a
   *  real class the user is taking this term. */
  skippedInactive: number;
  eventsInserted: number;
  eventsUpdated: number;
  eventsUnchanged: number;
  failures: number;
}

/** Event kinds that count as "the student is actively in this class".
 *  An iCal-only mention of a course with nothing but holidays / generic
 *  metadata won't anchor a new subject card. */
const ACTIVE_KINDS = new Set(['lecture', 'tutorial', 'assignment', 'midterm', 'exam']);

/** A course only anchors a subject card if it has at least one
 *  lecture/tutorial/deadline that ends today or later. Past-term courses
 *  the CourSys feed still emits (CMPT 426 from Fall 2025 etc) fail this
 *  check and don't get created. */
function isActiveAnchor(ev: IcalEvent, todayMs: number): boolean {
  if (isHoliday(ev)) return false;
  if (!ACTIVE_KINDS.has(kindFor(ev))) return false;
  const endMs = Date.parse(ev.dtend);
  if (Number.isNaN(endMs)) return false;
  return endMs >= todayMs;
}

/**
 * Pull the CourSys global iCal feed, parse it, and upsert every VEVENT into
 * Google Calendar. Events are attributed to subjects via the CATEGORIES
 * field; an unrecognised course code triggers an auto-created Subject row
 * (the user can edit professor/folder later via the dashboard).
 */
export async function syncIcalSubscription(
  url: string,
  opts: IcalSyncOptions,
  onProgress?: (e: IcalProgress) => void,
): Promise<IcalSyncResult> {
  const result: IcalSyncResult = {
    fetched: 0,
    attributed: 0,
    unattributed: 0,
    subjectsCreated: 0,
    skippedInactive: 0,
    eventsInserted: 0,
    eventsUpdated: 0,
    eventsUnchanged: 0,
    failures: 0,
  };

  onProgress?.({ stage: 'fetch', status: 'start' });
  const text = await fetchIcal(url);
  const events = parseIcal(text);
  result.fetched = events.length;
  logger.info({ url, count: events.length }, 'ical: fetched');
  onProgress?.({ stage: 'fetch', status: 'done', fetched: events.length });
  onProgress?.({ stage: 'upsert', status: 'start', total: events.length });

  const baseFolder = opts.baseFolder ?? 'downloads';
  // Lookup index for subjects. Keys are *normalised*  -  case-folded, no
  // spaces  -  so that "CMPT 307", "cmpt307", "CMPT307" all hit the same row.
  // This is what stops a PDF-bootstrap subject (id "cmpt307") from being
  // duplicated when iCal later refers to it as "CMPT 307".
  const subjectCache = new Map<string, Subject>();
  for (const s of await loadSubjects(opts.store, opts.userId)) {
    subjectCache.set(normalizeCode(s.id), s);
    if (s.code) subjectCache.set(normalizeCode(s.code), s);
  }

  // First pass: which course codes have at least one lecture / tutorial /
  // deadline that's still on the horizon? Only those will be allowed to
  // auto-create a subject card. Subjects that already exist locally (PDF
  // bootstrap, manual entry, prior sync) are not subject to this gate —
  // we keep upserting their events regardless of activity.
  const todayMs = Date.parse(
    new Date().toISOString().slice(0, 10) + 'T00:00:00Z',
  );
  const activeCodes = new Set<string>();
  for (const ev of events) {
    if (!isActiveAnchor(ev, todayMs)) continue;
    const code = pickCourseCode(ev);
    if (code) activeCodes.add(normalizeCode(code));
  }
  logger.info(
    { activeCodes: [...activeCodes] },
    'ical: active course codes for this sync',
  );

  let processed = 0;
  // Emit a tick every ~5 events or on the last one. With ~200 VEVENTs and
  // ~200ms per Google API call the user sees ~10 progress updates over the
  // 40-ish-second run, enough for the bar to feel alive.
  const tickEvery = Math.max(1, Math.floor(events.length / 20));
  for (const ev of events) {
    let subject: Subject | undefined;
    let displayCode: string;

    if (isHoliday(ev)) {
      subject = subjectCache.get(normalizeCode(HOLIDAYS_SUBJECT_ID));
      if (!subject) {
        subject = await autoCreateHolidaysSubject(opts.store, baseFolder, opts.userId);
        subjectCache.set(normalizeCode(subject.id), subject);
        result.subjectsCreated++;
      }
      displayCode = 'HOLIDAY';
    } else {
      const code = pickCourseCode(ev);
      if (!code) {
        result.unattributed++;
        logger.warn(
          { uid: ev.uid, categories: ev.categories },
          'ical: no course code on event',
        );
        continue;
      }
      displayCode = code;
      subject = subjectCache.get(normalizeCode(code));
      if (!subject) {
        // Gate auto-creation on the activity check. CourSys returns
        // every course the student has ever touched (CMPT 426 from Fall
        // 2025 etc); we only want subject cards for classes they're in
        // *now*, defined as: has at least one lecture/tutorial/deadline
        // ending today or later.
        if (!activeCodes.has(normalizeCode(code))) {
          result.skippedInactive++;
          continue;
        }
        subject = await autoCreateSubject(opts.store, code, baseFolder, opts.userId);
        subjectCache.set(normalizeCode(subject.id), subject);
        subjectCache.set(normalizeCode(code), subject);
        result.subjectsCreated++;
      }
    }
    result.attributed++;

    const calEvent = toCalendarEvent(ev, displayCode);
    try {
      const r = await upsertEvent(
        opts.googleAuth,
        subject.id,
        calEvent,
        opts.store,
        'ical:coursys',
        opts.userId,
      );
      if (r.action === 'inserted') result.eventsInserted++;
      else if (r.action === 'updated') result.eventsUpdated++;
      else result.eventsUnchanged++;
    } catch (err) {
      result.failures++;
      logger.error(
        { err, uid: ev.uid, subjectId: subject.id },
        'ical: calendar upsert failed',
      );
    }
    processed++;
    if (processed % tickEvery === 0 || processed === events.length) {
      onProgress?.({
        stage: 'upsert',
        status: 'tick',
        processed,
        total: events.length,
      });
    }
  }
  onProgress?.({
    stage: 'upsert',
    status: 'done',
    inserted: result.eventsInserted,
    updated: result.eventsUpdated,
    unchanged: result.eventsUnchanged,
    failures: result.failures,
    subjectsCreated: result.subjectsCreated,
  });
  logger.info(result, 'ical: sync finished');
  return result;
}

/**
 * Full ingestion workflow used by the dashboard's "Sync now" button: pull
 * the iCal feed, upsert to Google, then auto-dedup any subjects whose codes
 * differ only by a section letter (the cmpt307 <-> cmpt307d case). Dedup is
 * destructive on Google  -  duplicate events under the stale event-id prefix
 * are deleted so the next call sees a clean state.
 */
export async function runFullIcalSync(
  url: string,
  opts: IcalSyncOptions,
  onProgress?: (e: IcalProgress) => void,
): Promise<IcalRunResult> {
  try {
    const sync = await syncIcalSubscription(url, opts, onProgress);

    onProgress?.({ stage: 'dedup', status: 'analyzing' });
    const { plan, warning: agentWarning } = await planDedup({
      store: opts.store,
      googleAuth: opts.googleAuth,
      userId: opts.userId,
    });
    if (agentWarning) {
      logger.warn({ agentWarning }, 'ical: dedup agent returned a warning');
    }
    const totalMerges = plan.subjectMerges.length + plan.eventMerges.length;
    let processed = 0;
    let subjectMerges = 0;
    let eventMerges = 0;
    let googleDeleted = 0;

    // Subjects first: merging a subject re-attributes its events, which keeps
    // the subsequent event-merge plan coherent (canonical event ids stay
    // valid).
    for (const m of plan.subjectMerges) {
      try {
        const r = await mergeSubject({
          fromId: m.fromId,
          intoId: m.intoId,
          store: opts.store,
          userId: opts.userId,
          googleAuth: opts.googleAuth,
          deleteGoogleEvents: true,
        });
        subjectMerges++;
        googleDeleted += r.googleEventsDeleted;
      } catch (err) {
        logger.error({ err, merge: m }, 'ical: subject merge failed');
      }
      processed++;
      onProgress?.({
        stage: 'dedup', status: 'tick',
        processed, total: totalMerges,
        kind: 'subject', detail: `${m.fromId} -> ${m.intoId}`,
      });
    }

    for (const m of plan.eventMerges) {
      try {
        const r = await mergeEvent({
          canonicalEventId: m.canonicalEventId,
          redundantEventIds: m.redundantEventIds,
          store: opts.store,
          userId: opts.userId,
          googleAuth: opts.googleAuth,
        });
        eventMerges++;
        googleDeleted += r.googleEventsDeleted;
      } catch (err) {
        logger.error({ err, merge: m }, 'ical: event merge failed');
      }
      processed++;
      onProgress?.({
        stage: 'dedup', status: 'tick',
        processed, total: totalMerges,
        kind: 'event', detail: `${m.redundantEventIds.length} -> ${m.canonicalEventId.slice(0, 12)}...`,
      });
    }

    onProgress?.({
      stage: 'dedup', status: 'done',
      subjectMerges, eventMerges, googleEventsDeleted: googleDeleted,
      warning: agentWarning,
    });

    const result: IcalRunResult = {
      fetched: sync.fetched,
      attributed: sync.attributed,
      unattributed: sync.unattributed,
      subjectsCreated: sync.subjectsCreated,
      eventsInserted: sync.eventsInserted,
      eventsUpdated: sync.eventsUpdated,
      eventsUnchanged: sync.eventsUnchanged,
      failures: sync.failures,
      subjectMerges,
      eventMerges,
      googleEventsDeleted: googleDeleted,
      dedupWarning: agentWarning,
    };
    onProgress?.({ stage: 'done', result });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({ stage: 'error', message });
    throw err;
  }
}

async function fetchIcal(url: string): Promise<string> {
  // CourSys URLs like https://coursys.sfu.ca/calendar/<uuid>/<userid> have
  // no `.ics` extension  -  the server picks the response format from the
  // Accept header. Without this, it returns HTML and the parser sees no
  // VEVENTs. Google Calendar's iCal-subscribe path sends this header too,
  // which is why a direct subscription works while a bare fetch doesn't.
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'text/calendar, application/calendar+json;q=0.5, */*;q=0.1',
      'User-Agent': 'auto-schedule/1.0 (+https://github.com/maximenewman/auto-schedule)',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `ical fetch failed: HTTP ${res.status} ${res.statusText}${body ? `  -  ${body.slice(0, 200)}` : ''}`,
    );
  }
  const text = await res.text();
  // Sanity check: a successful HTTP response that returned HTML (CourSys
  // login page when the token is wrong) won't have a VCALENDAR header.
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    const ct = res.headers.get('content-type') ?? 'unknown';
    throw new Error(
      `ical response is not iCalendar (content-type: ${ct}). Double-check the URL  -  it should be the personal CourSys calendar token URL, not a course-page link.`,
    );
  }
  return text;
}

function normalizeCode(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase();
}

function pickCourseCode(ev: IcalEvent): string | null {
  // CourSys puts the type ("LEC", "LAB", "MIDT", "HOLIDAY") in CATEGORIES
  // and encodes the course code in the UID. Prefer the UID  -  it's
  // present on every CourSys VEVENT.
  const m = COURSYS_UID_RE.exec(ev.uid);
  if (m) return `${m[1]!.toUpperCase()} ${m[2]!.toUpperCase()}`;
  // Fallback for non-CourSys feeds that may include the course code in
  // CATEGORIES instead.
  for (const c of ev.categories) {
    const m2 = COURSE_CODE_RE.exec(c.trim());
    if (m2) return `${m2[1]} ${m2[2]}`;
  }
  return null;
}

function isHoliday(ev: IcalEvent): boolean {
  return ev.categories.some((c) => c.toUpperCase() === 'HOLIDAY');
}

async function autoCreateSubject(
  store: Store,
  code: string,
  baseFolder: string,
  userId?: number,
): Promise<Subject> {
  const id = code.replace(/\s+/g, '').toLowerCase();
  const base = baseFolder.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  const subject: Subject = {
    id,
    code,
    name: code,
    professor: 'TBD',
    destinationFolder: `${base}/${code}`,
    sources: [],
  };
  try {
    await createSubject(store, subject, userId);
    logger.info({ id, code }, 'ical: auto-created subject');
  } catch (err) {
    // Race between subjectCache lookup and DB write — createSubject throws on
    // conflict. Re-read the row instead so we use the existing one.
    const existing = await findSubject(store, id, userId);
    if (!existing) throw err;
    return existing;
  }
  return subject;
}

async function autoCreateHolidaysSubject(
  store: Store,
  baseFolder: string,
  userId?: number,
): Promise<Subject> {
  const existing = await findSubject(store, HOLIDAYS_SUBJECT_ID, userId);
  if (existing) return existing;
  const base = baseFolder.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  const subject: Subject = {
    id: HOLIDAYS_SUBJECT_ID,
    code: 'Holidays',
    name: 'Holidays',
    professor: '',
    term: '',
    color: '#c97a17',
    destinationFolder: `${base}/Holidays`,
    sources: [],
  };
  try {
    await createSubject(store, subject, userId);
    logger.info({ id: HOLIDAYS_SUBJECT_ID }, 'ical: auto-created holidays subject');
  } catch {
    const re = await findSubject(store, HOLIDAYS_SUBJECT_ID, userId);
    if (re) return re;
  }
  return subject;
}

function toCalendarEvent(ev: IcalEvent, code: string): CalendarEvent {
  const event: CalendarEvent = {
    itemId: itemIdFromUid(ev.uid),
    kind: kindFor(ev),
    summary: ev.summary || code,
    description: ev.description,
    room: ev.location,
    startDateTime: ev.dtstart,
    endDateTime: ev.dtend,
    attachments: [],
  };
  if (ev.rrule) event.recurrence = [ev.rrule];
  return event;
}

function itemIdFromUid(uid: string): string {
  // Strip the @domain part if present, then squash any character that's
  // not a-z0-9-_ into a dash. Keeps the id deterministic across runs.
  const local = uid.split('@')[0] ?? uid;
  return local.replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').slice(0, 80) || 'ical-event';
}

function kindFor(ev: IcalEvent): EventKind {
  const cats = ev.categories.map((c) => c.toUpperCase());
  // CourSys uses fixed-length codes in CATEGORIES  -  match them exactly.
  if (cats.includes('HOLIDAY')) return 'other';
  if (cats.includes('MIDT')) return 'midterm';
  if (cats.includes('EXAM') || cats.includes('FINAL')) return 'exam';
  if (cats.includes('LEC')) return 'lecture';
  if (cats.includes('TUT')) return 'tutorial';
  // No 'lab' kind in our enum; tutorials and labs render the same way.
  if (cats.includes('LAB')) return 'tutorial';
  if (cats.includes('OH') || cats.includes('OFFICE')) return 'office-hours';
  // Fall back to summary keywords for non-CourSys feeds.
  const sum = ev.summary.toLowerCase();
  if (sum.includes('midterm')) return 'midterm';
  if (sum.includes('exam') || sum.includes('final')) return 'exam';
  if (sum.includes('office hour')) return 'office-hours';
  if (sum.includes('due') || sum.includes('assignment') || sum.includes('homework')) return 'assignment';
  if (sum.includes('tutorial')) return 'tutorial';
  if (sum.includes('lecture')) return 'lecture';
  return 'other';
}
