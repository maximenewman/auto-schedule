/**
 * Post-sync subject enrichment.
 *
 * iCal + announcements give us a course code and a list of meetings but
 * never name the instructor. After every iCal sync we call
 * api.sfucourses.com for each subject that's still missing a real
 * professor name, find the section that matches (using the section_code
 * we parsed out of the CourSys UID), and write the primary instructor
 * back into the subjects table.
 *
 * Fill-only-empty: we never overwrite a name the user (or PDF bootstrap)
 * already typed. Failures are silent — the network call is strictly
 * best-effort.
 */

import {
  loadSubjects,
  updateSubject,
  type Subject,
} from '../config/subjectsStore.js';
import type { StateStore } from '../state/store.js';
import {
  fetchSections,
  pickPrimaryInstructor,
  pickSection,
  termToApiParam,
} from '../sources/sfuCoursesApi.js';
import { logger } from '../logger.js';

const HIDDEN_SUBJECT_IDS = new Set(['holidays']);
const PLACEHOLDER_NAMES = new Set(['', 'tbd', 'staff', 'staff member', 'tba']);

export interface EnrichOptions {
  store: StateStore;
  userId?: number;
  onProgress?: (e: EnrichProgress) => void;
}

export type EnrichProgress =
  | { stage: 'enrich'; status: 'start'; total: number }
  | { stage: 'enrich'; status: 'tick'; processed: number; total: number; subjectId: string; filled: boolean }
  | { stage: 'enrich'; status: 'done'; filled: number; tried: number };

export interface EnrichResult {
  tried: number;
  filled: number;
  skipped: number;
}

export async function enrichSubjects(opts: EnrichOptions): Promise<EnrichResult> {
  const result: EnrichResult = { tried: 0, filled: 0, skipped: 0 };
  const subjects = await loadSubjects(opts.store, opts.userId);
  const candidates = subjects.filter((s) => needsEnrichment(s));
  logger.info(
    {
      totalSubjects: subjects.length,
      candidates: candidates.length,
      candidateIds: candidates.map((s) => s.id),
      skippedReasons: subjects
        .filter((s) => !needsEnrichment(s))
        .map((s) => ({
          id: s.id,
          why: HIDDEN_SUBJECT_IDS.has(s.id)
            ? 'hidden'
            : `professor="${s.professor}" (not placeholder)`,
        })),
    },
    'enrich: pass starting',
  );
  opts.onProgress?.({ stage: 'enrich', status: 'start', total: candidates.length });

  let processed = 0;
  for (const subject of candidates) {
    result.tried++;
    let filled = false;
    try {
      const updated = await enrichOne(subject, opts.store, opts.userId);
      if (updated) {
        result.filled++;
        filled = true;
      } else {
        result.skipped++;
      }
    } catch (err) {
      result.skipped++;
      logger.warn(
        { err: (err as Error).message, subjectId: subject.id },
        'enrich: subject lookup failed',
      );
    }
    processed++;
    opts.onProgress?.({
      stage: 'enrich',
      status: 'tick',
      processed,
      total: candidates.length,
      subjectId: subject.id,
      filled,
    });
  }
  opts.onProgress?.({
    stage: 'enrich',
    status: 'done',
    filled: result.filled,
    tried: result.tried,
  });
  logger.info(result, 'enrich: pass complete');
  return result;
}

function needsEnrichment(s: Subject): boolean {
  if (HIDDEN_SUBJECT_IDS.has(s.id)) return false;
  const name = (s.professor ?? '').trim().toLowerCase();
  return PLACEHOLDER_NAMES.has(name);
}

async function enrichOne(
  subject: Subject,
  store: StateStore,
  userId?: number,
): Promise<boolean> {
  logger.info(
    {
      subjectId: subject.id,
      code: subject.code,
      term: subject.term,
      section: subject.section ?? null,
      currentProfessor: subject.professor,
    },
    'enrich: starting subject',
  );

  const { dept, number } = splitCode(subject);
  if (!dept || !number) {
    logger.warn(
      { subjectId: subject.id, code: subject.code },
      'enrich: skip — cannot split dept/number from code',
    );
    return false;
  }
  const termApi = termToApiParam(subject.term);
  if (!termApi) {
    logger.warn(
      { subjectId: subject.id, term: subject.term },
      'enrich: skip — could not map subject.term to an api term string',
    );
    return false;
  }
  logger.info(
    { subjectId: subject.id, dept, number, termApi },
    'enrich: ready to query sfucourses',
  );

  const course = await fetchSections(termApi, dept, number);
  if (!course) {
    logger.warn(
      { subjectId: subject.id, dept, number, termApi },
      'enrich: skip — sfucourses returned no course',
    );
    return false;
  }

  // Prefer the section stored on the subject row itself (filled at
  // auto-create time from the CourSys UID). Fall back to scanning local
  // calendar items for a LEC with a sectionCode — covers data written
  // before subject.section existed.
  let targetSection: string | null = subject.section ?? null;
  let sectionSource: 'subject.section' | 'lecture-event-row' | 'any-event-row' | 'none' =
    targetSection ? 'subject.section' : 'none';
  if (!targetSection) {
    const items = await store.listCalendarItems({ subjectId: subject.id }, userId);
    const lecRow = items.find((i) => i.kind === 'lecture' && i.sectionCode);
    if (lecRow?.sectionCode) {
      targetSection = lecRow.sectionCode;
      sectionSource = 'lecture-event-row';
    } else {
      const anyRow = items.find((i) => i.sectionCode);
      if (anyRow?.sectionCode) {
        targetSection = anyRow.sectionCode;
        sectionSource = 'any-event-row';
      }
    }
  }
  logger.info(
    { subjectId: subject.id, targetSection, sectionSource },
    'enrich: target section resolved',
  );

  const section = pickSection(course, targetSection);
  if (!section) {
    logger.warn(
      { subjectId: subject.id, targetSection },
      'enrich: skip — no section picked from sfucourses response',
    );
    return false;
  }

  const instructor = pickPrimaryInstructor(section);
  if (!instructor) {
    logger.warn(
      { subjectId: subject.id, pickedSection: section.section },
      'enrich: skip — picked section has no instructor name',
    );
    return false;
  }

  // Last-line safety: do not overwrite a non-placeholder value, even if we
  // think we're enriching. needsEnrichment() should have filtered already
  // but the underlying row may have been edited between then and now.
  const fresh = subjects(await loadSubjects(store, userId), subject.id);
  if (fresh && !needsEnrichment(fresh)) {
    logger.info(
      { subjectId: subject.id, currentProfessor: fresh.professor },
      'enrich: skip — subject got a real professor between detection and write',
    );
    return false;
  }

  await updateSubject(
    store,
    subject.id,
    {
      ...subject,
      professor: instructor.name,
      // If the subject was missing a section, persist whatever section we
      // ended up matching against so the next sync can short-circuit.
      section: subject.section ?? section.section ?? undefined,
    },
    userId,
  );
  logger.info(
    {
      subjectId: subject.id,
      filledProfessor: instructor.name,
      section: section.section,
      email: instructor.email ?? null,
    },
    'enrich: filled professor from sfucourses',
  );
  return true;
}

function splitCode(s: Subject): { dept: string | null; number: string | null } {
  // Prefer the user-facing code (e.g. "CMPT 307"). Fall back to splitting
  // the id (e.g. "cmpt307").
  const code = s.code ?? s.id;
  const m = /^([A-Z]{2,4})\s*(\d{2,3}[A-Z]?)$/i.exec(code);
  if (!m) return { dept: null, number: null };
  return { dept: m[1]!.toLowerCase(), number: m[2]!.toLowerCase() };
}

function subjects(all: Subject[], id: string): Subject | undefined {
  return all.find((s) => s.id === id);
}
