/**
 * Thin client for https://api.sfucourses.com — an unofficial wrapper around
 * SFU's course-outlines REST API. We only call /v1/rest/sections here;
 * that endpoint returns every section for a (term, dept, number) tuple
 * with its instructor list, which is exactly what the subject-enrichment
 * step needs.
 */

import { logger } from '../logger.js';

const BASE = 'https://api.sfucourses.com';
const TIMEOUT_MS = 5000;

export interface SfuInstructor {
  name: string;
  email?: string;
}

export interface SfuSectionDetail {
  section: string;          // "D100"
  classNumber?: string;     // "6327"
  deliveryMethod?: string;  // "In Person"
  instructors: SfuInstructor[];
  schedules: SfuSectionSchedule[];
}

export interface SfuSectionSchedule {
  campus?: string;
  days?: string;             // "Mo,We,Fr"
  startDate?: string;        // "2024-09-03"
  endDate?: string;          // "2024-12-06"
  startTime?: string;        // "10:30"
  endTime?: string;          // "11:20"
  sectionCode?: string;      // "LEC"
}

export interface SfuCourseSections {
  dept: string;
  number: string;
  term: string;
  title?: string;
  units?: string;
  sections: SfuSectionDetail[];
}

/** Convert our `Subject.term` value ("Summer 2026", "Fall 2025", "Spring 2026")
 *  into the format api.sfucourses.com expects ("2026-summer", "2025-fall",
 *  "2026-spring"). Returns null when the string doesn't parse. */
export function termToApiParam(term: string | null | undefined): string | null {
  if (!term) return null;
  const m = /^(spring|summer|fall)\s+(\d{4})$/i.exec(term.trim());
  if (!m) {
    // Also accept the inverse layout the SFU PDF emits: "2026 Summer".
    const m2 = /^(\d{4})\s+(spring|summer|fall)$/i.exec(term.trim());
    if (!m2) return null;
    return `${m2[1]}-${m2[2]!.toLowerCase()}`;
  }
  return `${m[2]}-${m[1]!.toLowerCase()}`;
}

/** GET /v1/rest/sections?term=2026-summer&dept=cmpt&number=307 */
export async function fetchSections(
  termApi: string,
  dept: string,
  number: string,
): Promise<SfuCourseSections | null> {
  const url = new URL('/v1/rest/sections', BASE);
  url.searchParams.set('term', termApi);
  url.searchParams.set('dept', dept.toLowerCase());
  url.searchParams.set('number', number.toLowerCase());

  const started = Date.now();
  logger.info(
    { url: url.toString(), termApi, dept: dept.toLowerCase(), number: number.toLowerCase() },
    'sfucourses: GET',
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'auto-schedule/1.0 (+https://github.com/maximenewman/auto-schedule)',
      },
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - started;
    if (res.status === 404) {
      logger.info(
        { url: url.toString(), status: 404, elapsedMs },
        'sfucourses: 404 — no outline for this (term, dept, number)',
      );
      return null;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(
        { url: url.toString(), status: res.status, elapsedMs, body: body.slice(0, 200) },
        'sfucourses: non-OK response',
      );
      return null;
    }
    const body = (await res.json()) as unknown;
    // The endpoint is documented as returning Array<Array<CourseWithSectionDetails>>
    // but in practice often returns a flat array of courses. `flattenSectionsResponse`
    // handles both shapes.
    const flat = flattenSectionsResponse(body);
    const first = flat[0];
    if (!first) {
      logger.warn(
        { url: url.toString(), status: 200, elapsedMs, bodyType: Array.isArray(body) ? 'array' : typeof body },
        'sfucourses: 200 but response had no courses',
      );
      return null;
    }
    logger.info(
      {
        url: url.toString(), status: 200, elapsedMs,
        dept: first.dept, number: first.number, term: first.term,
        sections: first.sections.length,
        sectionCodes: first.sections.map((s) => s.section),
      },
      'sfucourses: got sections',
    );
    return first;
  } catch (err) {
    logger.warn(
      { url: url.toString(), err: (err as Error).message, elapsedMs: Date.now() - started },
      'sfucourses: fetch failed',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function flattenSectionsResponse(body: unknown): SfuCourseSections[] {
  if (!Array.isArray(body)) return [];
  const out: SfuCourseSections[] = [];
  for (const item of body) {
    if (Array.isArray(item)) {
      for (const c of item) if (looksLikeCourse(c)) out.push(c as SfuCourseSections);
    } else if (looksLikeCourse(item)) {
      out.push(item as SfuCourseSections);
    }
  }
  return out;
}

function looksLikeCourse(v: unknown): v is SfuCourseSections {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.dept === 'string' && typeof o.number === 'string' && Array.isArray(o.sections);
}

/** Pick the section that matches `targetSection` (case-insensitive), falling
 *  back to the first LEC section in the response. Returns null when no
 *  section is suitable. */
export function pickSection(
  course: SfuCourseSections,
  targetSection: string | null,
): SfuSectionDetail | null {
  if (course.sections.length === 0) {
    logger.warn(
      { dept: course.dept, number: course.number },
      'sfucourses: course has no sections at all',
    );
    return null;
  }
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '').toUpperCase();
  if (targetSection) {
    const exact = course.sections.find(
      (s) => norm(s.section) === norm(targetSection),
    );
    if (exact) {
      logger.info(
        {
          dept: course.dept, number: course.number,
          targetSection, matched: exact.section,
          instructors: exact.instructors.map((i) => i.name),
        },
        'sfucourses: exact section match',
      );
      return exact;
    }
    logger.warn(
      {
        dept: course.dept, number: course.number,
        targetSection,
        available: course.sections.map((s) => s.section),
      },
      'sfucourses: target section not found in response — falling back to first LEC',
    );
  }
  const lec = course.sections.find((s) =>
    s.schedules.some((sch) => sch.sectionCode === 'LEC'),
  );
  const picked = lec ?? course.sections[0] ?? null;
  if (picked) {
    logger.info(
      {
        dept: course.dept, number: course.number,
        picked: picked.section,
        viaFallback: !targetSection ? 'no-target' : 'no-match',
        instructors: picked.instructors.map((i) => i.name),
      },
      'sfucourses: fallback section pick',
    );
  }
  return picked;
}

/** Of a section's instructors, pick the "primary" one. The sfucourses API
 *  doesn't expose roleCode, but instructors are listed in primary-first
 *  order in practice — first non-empty name wins. */
export function pickPrimaryInstructor(section: SfuSectionDetail): SfuInstructor | null {
  if (section.instructors.length === 0) {
    logger.warn({ section: section.section }, 'sfucourses: section has no instructors listed');
    return null;
  }
  for (const i of section.instructors) {
    if (i.name && i.name.trim()) return i;
  }
  logger.warn(
    { section: section.section, instructors: section.instructors },
    'sfucourses: all instructor names were empty',
  );
  return null;
}
