import type { OAuth2Client } from 'google-auth-library';
import {
  createSubject,
  findSubject,
  updateSubject,
  type Subject,
} from '../config/subjectsStore.js';
import type { CalendarEvent } from '../agent/schema.js';
import { upsertEvent } from '../sync/calendar.js';
import type { StateStore } from '../state/store.js';
import { logger } from '../logger.js';
import type {
  SfuCourse,
  SfuMeeting,
  SfuSchedule,
  SfuSection,
  SfuTerm,
} from './sfuSchema.js';

const TZ = 'America/Vancouver';

const BYDAY: Record<string, string> = {
  Mon: 'MO', Tue: 'TU', Wed: 'WE', Thu: 'TH', Fri: 'FR', Sat: 'SA', Sun: 'SU',
};

const DOW_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function termLabel(term: SfuTerm): string {
  // term.label is "2026 Summer"; UI convention is "Summer 2026".
  const m = /^(\d{4})\s+(\w+)$/.exec(term.label);
  return m ? `${m[2]} ${m[1]}` : term.label;
}

function subjectIdFor(course: SfuCourse): string {
  return `${course.subject}${course.number}`.toLowerCase();
}

function destinationFolderFor(baseFolder: string, course: SfuCourse): string {
  const base = baseFolder.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return `${base}/${course.code}`;
}

/** Pick the primary instructor for a course: the first non-"Staff" name on a
 *  LEC section, falling back to whatever's on the first section. */
function primaryInstructor(course: SfuCourse): string {
  const lec = course.sections.find((s) => s.type === 'LEC' && s.instructor && s.instructor !== 'Staff');
  if (lec?.instructor) return lec.instructor;
  const any = course.sections.find((s) => s.instructor && s.instructor !== 'Staff');
  return any?.instructor ?? course.sections[0]?.instructor ?? 'TBD';
}

/** Walk forward from `fromIsoDate` (inclusive) to the next date whose weekday
 *  matches `day`. Returns ISO yyyy-mm-dd. */
function firstOccurrence(fromIsoDate: string, day: string): string {
  const target = DOW_INDEX[day];
  if (target === undefined) throw new Error(`unknown day "${day}"`);
  // Anchor at noon UTC so getUTCDay() returns the calendar weekday regardless
  // of host timezone.
  const d = new Date(`${fromIsoDate}T12:00:00Z`);
  for (let i = 0; i < 7; i++) {
    if (d.getUTCDay() === target) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  throw new Error('unreachable');
}

/** Resolve the wall-clock offset for `America/Vancouver` at a specific local
 *  moment. Returns "-07:00" (PDT) or "-08:00" (PST) in 2026. Using Intl to
 *  read off the zone's current offset means we don't hand-roll DST rules. */
function offsetFor(localDate: string): string {
  // Sample at noon local; DST transitions happen at 02:00 so noon is unambiguous.
  const sample = new Date(`${localDate}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    timeZoneName: 'longOffset',
  }).formatToParts(sample);
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-08:00';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(tzName);
  if (!m) return '-08:00';
  const sign = m[1]!;
  const hh = m[2]!;
  const mm = m[3] ?? '00';
  return `${sign}${hh}:${mm}`;
}

function localIso(date: string, time: string): string {
  // "2026-05-12" + "14:30" -> "2026-05-12T14:30:00-07:00"
  return `${date}T${time}:00${offsetFor(date)}`;
}

/** UNTIL in the RRULE must be UTC. Pad to end-of-day on the term-end date in
 *  the local zone so the last occurrence is included regardless of offset. */
function untilUtc(localEndDate: string): string {
  const localOffset = offsetFor(localEndDate); // "-07:00"
  const iso = `${localEndDate}T23:59:59${localOffset}`;
  const utc = new Date(iso);
  const y = utc.getUTCFullYear();
  const M = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utc.getUTCDate()).padStart(2, '0');
  const h = String(utc.getUTCHours()).padStart(2, '0');
  const mn = String(utc.getUTCMinutes()).padStart(2, '0');
  const s = String(utc.getUTCSeconds()).padStart(2, '0');
  return `${y}${M}${d}T${h}${mn}${s}Z`;
}

function kindFor(sectionType: string): CalendarEvent['kind'] {
  switch (sectionType) {
    case 'LEC': return 'lecture';
    case 'TUT': return 'tutorial';
    case 'SEM': return 'lecture';
    default: return 'other';
  }
}

function itemIdFor(section: SfuSection, meeting: SfuMeeting): string {
  // Deterministic per (section, day, start-time, start-date). The startDate
  // disambiguates one-off midterms (same section, different week).
  const parts = [
    section.type.toLowerCase(),
    section.code.toLowerCase(),
    meeting.day.toLowerCase(),
    meeting.startTime.replace(':', ''),
    meeting.startDate,
  ];
  return parts.join('-');
}

function buildEvent(course: SfuCourse, section: SfuSection, meeting: SfuMeeting): CalendarEvent {
  const dtStartDate = meeting.recurring
    ? firstOccurrence(meeting.startDate, meeting.day)
    : meeting.startDate;
  const startDateTime = localIso(dtStartDate, meeting.startTime);
  const endDateTime = localIso(dtStartDate, meeting.endTime);

  const summaryBits = [course.code, section.type];
  if (section.type !== 'LEC' && section.code) summaryBits.push(section.code);
  const summary = summaryBits.join(' ');

  const descLines = [
    course.title,
    `Section ${section.type} ${section.code}`,
  ];
  if (section.instructor) descLines.push(`Instructor: ${section.instructor}`);
  if (section.classNumber) descLines.push(`Class Number: ${section.classNumber}`);
  if (section.delivery) descLines.push(section.delivery);
  if (section.campus) descLines.push(section.campus);

  const event: CalendarEvent = {
    itemId: itemIdFor(section, meeting),
    kind: kindFor(section.type),
    summary,
    description: descLines.join('\n'),
    room: meeting.location,
    startDateTime,
    endDateTime,
    attachments: [],
  };

  if (meeting.recurring) {
    const byday = BYDAY[meeting.day];
    if (byday) {
      event.recurrence = [
        `RRULE:FREQ=WEEKLY;BYDAY=${byday};UNTIL=${untilUtc(meeting.endDate)}`,
      ];
    }
  }

  return event;
}

function mergeSubject(existing: Subject, next: Subject): Subject {
  // Fill-only-empty: keep anything the user has typed. We never touch
  // `sources` because the bootstrap doesn't know about email/site sources
  // that may have been added by hand.
  return {
    id: existing.id,
    code: existing.code ?? next.code,
    name: existing.name || next.name,
    professor: existing.professor || next.professor,
    room: existing.room ?? next.room,
    term: existing.term ?? next.term,
    color: existing.color ?? next.color,
    destinationFolder: existing.destinationFolder || next.destinationFolder,
    sources: existing.sources,
  };
}

export interface BootstrapOptions {
  baseFolder: string;
  googleAuth: OAuth2Client;
  store: StateStore;
  userId?: number;
  sourceLabel?: string;
}

export interface BootstrapResult {
  subjectsCreated: number;
  subjectsMerged: number;
  eventsInserted: number;
  eventsUpdated: number;
  eventsUnchanged: number;
  failures: number;
}

export async function bootstrapFromSchedule(
  schedule: SfuSchedule,
  opts: BootstrapOptions,
): Promise<BootstrapResult> {
  const result: BootstrapResult = {
    subjectsCreated: 0,
    subjectsMerged: 0,
    eventsInserted: 0,
    eventsUpdated: 0,
    eventsUnchanged: 0,
    failures: 0,
  };

  // Pass 1: subjects.
  const term = termLabel(schedule.term);
  for (const course of schedule.courses) {
    const id = subjectIdFor(course);
    const next: Subject = {
      id,
      code: course.code,
      name: course.title || course.code,
      professor: primaryInstructor(course),
      term,
      destinationFolder: destinationFolderFor(opts.baseFolder, course),
      sources: [],
    };

    const existing = await findSubject(opts.store, id, opts.userId);
    if (!existing) {
      await createSubject(opts.store, next, opts.userId);
      result.subjectsCreated++;
    } else {
      const merged = mergeSubject(existing, next);
      await updateSubject(opts.store, id, merged, opts.userId);
      result.subjectsMerged++;
    }
  }

  // Pass 2: events.
  const sourceLabel = opts.sourceLabel ?? 'pdf:sfu';
  for (const course of schedule.courses) {
    const subjectId = subjectIdFor(course);
    for (const section of course.sections) {
      for (const meeting of section.meetings) {
        const event = buildEvent(course, section, meeting);
        try {
          const r = await upsertEvent(
            opts.googleAuth,
            subjectId,
            event,
            opts.store,
            sourceLabel,
            opts.userId,
          );
          if (r.action === 'inserted') result.eventsInserted++;
          else if (r.action === 'updated') result.eventsUpdated++;
          else result.eventsUnchanged++;
        } catch (err) {
          result.failures++;
          logger.error(
            { err, subjectId, itemId: event.itemId },
            'bootstrap: calendar upsert failed',
          );
        }
      }
    }
  }
  logger.info(result, 'bootstrap finished');
  return result;
}
