import type { OAuth2Client } from 'google-auth-library';
import {
  createSubject,
  findSubject,
  loadSubjects,
  type Subject,
} from '../config/subjectsStore.js';
import type { StateStore } from '../state/store.js';
import type { CalendarEvent, EventKind } from '../agent/schema.js';
import { writeEvent } from '../sync/calendar.js';
import {
  CanvasClient,
  type CanvasCalendarEvent,
  type CanvasCourse,
} from '../sources/canvasClient.js';
import { logger } from '../logger.js';

export type CanvasProgress =
  | { stage: 'courses'; status: 'start' }
  | { stage: 'courses'; status: 'done'; courses: number; subjectsCreated: number }
  | { stage: 'announcements'; status: 'start' }
  | { stage: 'announcements'; status: 'done'; fetched: number; inserted: number; updated: number }
  | { stage: 'events'; status: 'start' }
  | { stage: 'events'; status: 'tick'; processed: number; total: number }
  | { stage: 'events'; status: 'done'; written: number; failures: number }
  | { stage: 'files'; status: 'start' }
  | { stage: 'files'; status: 'done'; downloaded: number; skipped: number; failures: number }
  | { stage: 'done'; result: CanvasSyncResult }
  | { stage: 'error'; message: string };

export interface CanvasSyncResult {
  courses: number;
  subjectsCreated: number;
  announcementsFetched: number;
  announcementsInserted: number;
  announcementsUpdated: number;
  eventsWritten: number;
  eventFailures: number;
  filesDownloaded: number;
  filesSkipped: number;
  fileFailures: number;
}

export interface CanvasSyncOptions {
  store: StateStore;
  userId?: number;
  /** null = user has no Google Calendar connected; local rows only. */
  googleAuth: OAuth2Client | null;
  /** Injected by Phase 4 (Tigris) — absent means skip the files step. */
  fileSink?: (opts: {
    client: CanvasClient;
    courseId: number;
    subjectId: string;
    userId?: number;
  }) => Promise<{ downloaded: number; skipped: number; failures: number }>;
}

/** How far back announcements/events reach: covers a full term. */
const LOOKBACK_DAYS = 150;
const LOOKAHEAD_DAYS = 210;

/**
 * Full Canvas ingestion for one user:
 *   courses -> subjects (auto-create, matched by canvas_course_id or code)
 *   announcements -> announcements table (extract_status='pending' feeds the
 *     LLM pass — see announcementExtract.ts)
 *   calendar events + assignment due dates -> writeEvent directly (already
 *     structured; no LLM involved)
 *   files -> optional fileSink (object storage, Phase 4)
 */
export async function syncCanvas(
  opts: CanvasSyncOptions,
  onProgress?: (e: CanvasProgress) => void,
): Promise<CanvasSyncResult> {
  const result: CanvasSyncResult = {
    courses: 0,
    subjectsCreated: 0,
    announcementsFetched: 0,
    announcementsInserted: 0,
    announcementsUpdated: 0,
    eventsWritten: 0,
    eventFailures: 0,
    filesDownloaded: 0,
    filesSkipped: 0,
    fileFailures: 0,
  };

  const token = await opts.store.getCanvasToken(opts.userId);
  if (!token) {
    throw new Error('no Canvas token configured — paste one in Settings first');
  }
  const client = new CanvasClient(token.token, token.baseUrl);

  try {
    // ---- courses -> subjects -------------------------------------------
    onProgress?.({ stage: 'courses', status: 'start' });
    const courses = await client.listActiveCourses();
    result.courses = courses.length;

    const subjectByCourseId = new Map<number, Subject>();
    for (const course of courses) {
      const subject = await resolveSubject(course, opts);
      if (!subject) continue;
      if (subject.created) result.subjectsCreated++;
      subjectByCourseId.set(course.id, subject.subject);
    }
    onProgress?.({
      stage: 'courses',
      status: 'done',
      courses: result.courses,
      subjectsCreated: result.subjectsCreated,
    });

    const courseIds = [...subjectByCourseId.keys()];
    const startDate = isoDaysFromNow(-LOOKBACK_DAYS);
    const endDate = isoDaysFromNow(LOOKAHEAD_DAYS);

    // ---- announcements --------------------------------------------------
    onProgress?.({ stage: 'announcements', status: 'start' });
    const announcements = courseIds.length
      ? await client.listAnnouncements(courseIds, startDate)
      : [];
    result.announcementsFetched = announcements.length;
    for (const a of announcements) {
      const courseId = Number(a.context_code.replace('course_', ''));
      const subject = subjectByCourseId.get(courseId);
      try {
        const r = await opts.store.upsertAnnouncement(
          {
            entryId: `canvas:${a.id}`,
            subjectId: subject?.id ?? null,
            courseCode: subject?.code ?? null,
            title: a.title,
            contentHtml: a.message ?? '',
            link: a.html_url ?? null,
            author: a.author?.display_name ?? null,
            publishedAt: a.posted_at,
            updatedAt: null,
          },
          opts.userId,
        );
        if (r.inserted) result.announcementsInserted++;
        else result.announcementsUpdated++;
      } catch (err) {
        logger.error({ err, id: a.id }, 'canvas: announcement upsert failed');
      }
    }
    onProgress?.({
      stage: 'announcements',
      status: 'done',
      fetched: result.announcementsFetched,
      inserted: result.announcementsInserted,
      updated: result.announcementsUpdated,
    });

    // ---- structured events (no LLM) --------------------------------------
    onProgress?.({ stage: 'events', status: 'start' });
    const [events, assignments] = courseIds.length
      ? await Promise.all([
          client.listCalendarEvents(courseIds, 'event', { startDate, endDate }),
          client.listCalendarEvents(courseIds, 'assignment', { startDate, endDate }),
        ])
      : [[], []];
    const all = [...events, ...assignments];
    let processed = 0;
    const tickEvery = Math.max(1, Math.floor(all.length / 20));
    for (const ev of all) {
      const courseId = Number(ev.context_code.replace('course_', ''));
      const subject = subjectByCourseId.get(courseId);
      if (!subject) { processed++; continue; }
      const calEvent = toCalendarEvent(ev, subject);
      if (!calEvent) { processed++; continue; }
      try {
        await writeEvent(
          opts.googleAuth,
          subject.id,
          calEvent,
          opts.store,
          'canvas',
          opts.userId,
        );
        result.eventsWritten++;
      } catch (err) {
        result.eventFailures++;
        logger.error({ err, id: ev.id, subjectId: subject.id }, 'canvas: event write failed');
      }
      processed++;
      if (processed % tickEvery === 0 || processed === all.length) {
        onProgress?.({ stage: 'events', status: 'tick', processed, total: all.length });
      }
    }
    onProgress?.({
      stage: 'events',
      status: 'done',
      written: result.eventsWritten,
      failures: result.eventFailures,
    });

    // ---- files (Phase 4 hook) --------------------------------------------
    if (opts.fileSink) {
      onProgress?.({ stage: 'files', status: 'start' });
      for (const [courseId, subject] of subjectByCourseId) {
        try {
          const r = await opts.fileSink({
            client,
            courseId,
            subjectId: subject.id,
            userId: opts.userId,
          });
          result.filesDownloaded += r.downloaded;
          result.filesSkipped += r.skipped;
          result.fileFailures += r.failures;
        } catch (err) {
          result.fileFailures++;
          logger.error({ err, courseId }, 'canvas: file sync failed for course');
        }
      }
      onProgress?.({
        stage: 'files',
        status: 'done',
        downloaded: result.filesDownloaded,
        skipped: result.filesSkipped,
        failures: result.fileFailures,
      });
    }

    onProgress?.({ stage: 'done', result });
    logger.info(result, 'canvas: sync finished');
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({ stage: 'error', message });
    throw err;
  }
}

/** "CMPT 307 D100" / "CMPT307-D100" / "Su26 CMPT 307" -> "CMPT 307". */
function parseCourseCode(raw: string): string | null {
  const m = /\b([A-Z]{2,4})[\s-]?(\d{2,3}[A-Z]?)\b/i.exec(raw);
  if (!m) return null;
  return `${m[1]!.toUpperCase()} ${m[2]!.toUpperCase()}`;
}

function normalizeCode(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase();
}

async function resolveSubject(
  course: CanvasCourse,
  opts: CanvasSyncOptions,
): Promise<{ subject: Subject; created: boolean } | null> {
  // 1. Already linked to this Canvas course.
  const linked = await opts.store.getSubjectByCanvasCourseId(course.id, opts.userId);
  if (linked) return { subject: linked, created: false };

  // 2. Same course created by another source (iCal, PDF) — match on the
  //    normalized code and stamp the Canvas id onto it.
  const code = parseCourseCode(course.course_code) ?? parseCourseCode(course.name);
  if (code) {
    const subjects = await loadSubjects(opts.store, opts.userId);
    const hit = subjects.find(
      (s) => normalizeCode(s.id) === normalizeCode(code) ||
             (s.code && normalizeCode(s.code) === normalizeCode(code)),
    );
    if (hit) {
      await opts.store.setSubjectCanvasCourseId(hit.id, course.id, opts.userId);
      return { subject: hit, created: false };
    }
  }

  // 3. Auto-create. Without a recognizable code we skip the course — Canvas
  //    lists things like "Co-op Prep" shells that aren't classes.
  if (!code) {
    logger.info({ courseId: course.id, name: course.name }, 'canvas: no course code — skipping');
    return null;
  }
  const id = code.replace(/\s+/g, '').toLowerCase();
  const subject: Subject = {
    id,
    code,
    name: course.name || code,
    professor: 'TBD',
    destinationFolder: `downloads/${code}`,
  };
  if (course.term?.name && !/default/i.test(course.term.name)) {
    subject.term = course.term.name;
  }
  try {
    await createSubject(opts.store, subject, opts.userId);
  } catch {
    const existing = await findSubject(opts.store, id, opts.userId);
    if (!existing) return null;
    await opts.store.setSubjectCanvasCourseId(existing.id, course.id, opts.userId);
    return { subject: existing, created: false };
  }
  await opts.store.setSubjectCanvasCourseId(id, course.id, opts.userId);
  logger.info({ id, code, courseId: course.id }, 'canvas: auto-created subject');
  return { subject, created: true };
}

function toCalendarEvent(ev: CanvasCalendarEvent, subject: Subject): CalendarEvent | null {
  if (ev.assignment) {
    const due = ev.assignment.due_at ?? ev.start_at;
    if (!due) return null;
    const dueMs = Date.parse(due);
    return {
      itemId: `canvas-assignment-${ev.assignment.id}`,
      kind: 'assignment' as EventKind,
      summary: `${subject.code ?? subject.name} ${ev.title}`,
      description: [stripHtml(ev.description), ev.assignment.html_url ?? ev.html_url]
        .filter(Boolean)
        .join('\n'),
      room: null,
      // Anchor a 30-minute block ending at the due time so it's visible on
      // the schedule instead of being a zero-length instant.
      startDateTime: new Date(dueMs - 30 * 60 * 1000).toISOString(),
      endDateTime: new Date(dueMs).toISOString(),
      attachments: [],
    };
  }
  if (!ev.start_at) return null;
  const end = ev.end_at ?? ev.start_at;
  return {
    itemId: `canvas-event-${ev.id}`,
    kind: kindFromTitle(ev.title),
    summary: ev.title,
    description: [stripHtml(ev.description), ev.html_url].filter(Boolean).join('\n'),
    room: ev.location_name ?? null,
    startDateTime: ev.start_at,
    endDateTime: end,
    attachments: [],
  };
}

function kindFromTitle(title: string): EventKind {
  const t = title.toLowerCase();
  if (t.includes('midterm')) return 'midterm';
  if (t.includes('final') || t.includes('exam') || t.includes('quiz')) return 'exam';
  if (t.includes('office hour')) return 'office-hours';
  if (t.includes('tutorial')) return 'tutorial';
  if (t.includes('lab')) return 'lab';
  if (t.includes('lecture')) return 'lecture';
  return 'other';
}

function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
