import { createRequire } from 'node:module';
import {
  SfuScheduleSchema,
  type SfuCourse,
  type SfuDay,
  type SfuMeeting,
  type SfuSchedule,
  type SfuSection,
} from './sfuSchema.js';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse') as {
  PDFParse: new (opts: { data: Buffer | Uint8Array }) => {
    getText: () => Promise<{ text: string }>;
    destroy: () => Promise<void>;
  };
};

const MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

const DAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

const COURSE_HEADER =
  /^([A-Z]{2,4})\s+(\d{2,3}[A-Z]?)\s+(\d{4})\s+(Spring|Summer|Fall):\s+([A-Z][a-z]{2}\s+\d{1,2})\s*-\s*([A-Z][a-z]{2}\s+\d{1,2})\s*$/;
const SECTION_HEADER = /^(LEC|TUT|LAB|SEM|DIS|STD|OLC|PRA|SMR|WKS)\s+([A-Z0-9]+)\s*$/;
const MEETING =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Z][a-z]{2}\s+\d{1,2})(?:\s*-\s*([A-Z][a-z]{2}\s+\d{1,2}))?:\s+(\d{1,2}:\d{2}\s+[AP]M)\s+to\s+(\d{1,2}:\d{2}\s+[AP]M)(?:\s+(.+))?\s*$/;
const CLASS_NUMBER = /^Class Number:\s*(\S.*)$/;
const SEATS = /^Seats:\s*(\S.*)$/;
const WAIT_LIST = /^Wait List:\s*(\S.*)$/;
const UNITS = /^(\d+(?:\.\d+)?)\s+Units\s*$/;
const PRINTED_BY = /^Printed by:\s*(.+)$/;
const FOOTER_DATE = /^\d{1,2}\/\d{1,2}\/\d{2},?\s+\d{1,2}:\d{2}\s+[AP]M/;
const PAGE_MARK = /^--\s*\d+\s+of\s+\d+\s*--$/;
const CAMPUS_HINT = /Campus$/;
const DELIVERY_VALUES = new Set(['In Person', 'Remote', 'Online', 'Hybrid', 'Blended']);
const LOCATION_HINT = /\s-\s[A-Z0-9]/;

function toIsoDate(year: number, monthAbbrev: string, day: number): string {
  const m = MONTHS[monthAbbrev];
  if (!m) throw new Error(`unknown month abbrev "${monthAbbrev}"`);
  return `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseMonthDay(text: string): { month: string; day: number } {
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})$/.exec(text.trim());
  if (!m) throw new Error(`bad month-day "${text}"`);
  return { month: m[1]!, day: Number(m[2]) };
}

function toIso24Time(text: string): string {
  const m = /^(\d{1,2}):(\d{2})\s+([AP])M$/i.exec(text.trim());
  if (!m) throw new Error(`bad time "${text}"`);
  let h = Number(m[1]);
  const min = m[2]!;
  const ampm = m[3]!.toUpperCase();
  if (ampm === 'A') {
    if (h === 12) h = 0;
  } else if (h !== 12) {
    h += 12;
  }
  return `${String(h).padStart(2, '0')}:${min}`;
}

function tryMeetingLine(line: string, year: number): {
  meeting: SfuMeeting;
  inlineLocation: string | null;
} | null {
  const m = MEETING.exec(line);
  if (!m) return null;
  const day = m[1] as SfuDay;
  const startMd = parseMonthDay(m[2]!);
  const endMd = m[3] ? parseMonthDay(m[3]) : startMd;
  const startDate = toIsoDate(year, startMd.month, startMd.day);
  const endDate = toIsoDate(year, endMd.month, endMd.day);
  return {
    meeting: {
      day,
      startDate,
      endDate,
      recurring: startDate !== endDate,
      startTime: toIso24Time(m[4]!),
      endTime: toIso24Time(m[5]!),
      location: m[6]?.trim() || null,
    },
    inlineLocation: m[6]?.trim() || null,
  };
}

function isNoise(line: string): boolean {
  if (!line.trim()) return true;
  if (FOOTER_DATE.test(line)) return true;
  if (line.startsWith('https://')) return true;
  if (PAGE_MARK.test(line)) return true;
  if (line.startsWith('Note:')) return true;
  // SFU renders "Enrolled" / "Waitlisted" as a status badge that the PDF text
  // extractor breaks into "E Enrolled nrolled" (icon splits the word). Ignore
  //  -  using these as instructor names is never right.
  if (/^[A-Z]\s+(Enrolled|Waitlisted)\s+\w+$/.test(line)) return true;
  if (/^(Enrolled|Waitlisted|Dropped)$/.test(line)) return true;
  return false;
}

type SectionDraft = SfuSection & {
  _hadOwnMeetings: boolean;
  _pendingLocation: string | null;
};
type CourseDraft = SfuCourse & {
  sections: SectionDraft[];
  _summaryMeetings: SfuMeeting[];
};

function newSection(type: string, code: string): SectionDraft {
  return {
    type,
    code,
    classNumber: '',
    meetings: [],
    _hadOwnMeetings: false,
    _pendingLocation: null,
  };
}

function meetingKey(m: SfuMeeting): string {
  return `${m.day}|${m.startDate}|${m.endDate}|${m.startTime}|${m.endTime}`;
}

export function parseScheduleText(text: string): SfuSchedule {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, ' ').replace(/\s+/g, ' ').trim());

  let printedBy: string | undefined;
  for (const l of lines) {
    const m = PRINTED_BY.exec(l);
    if (m) { printedBy = m[1]!.trim(); break; }
  }

  const courses: CourseDraft[] = [];
  const state: {
    course: CourseDraft | null;
    section: SectionDraft | null;
    pendingInstructor: string | null;
    inNotes: boolean;
    expectTitle: boolean;
    year: number;
  } = {
    course: null,
    section: null,
    pendingInstructor: null,
    inNotes: false,
    expectTitle: false,
    year: 0,
  };

  const commitSection = (): void => {
    const s = state.section;
    const c = state.course;
    if (!s || !c) return;
    if (state.pendingInstructor && !s.instructor) {
      s.instructor = state.pendingInstructor;
    }
    state.pendingInstructor = null;
    c.sections.push(s);
    state.section = null;
    state.inNotes = false;
  };

  const startSection = (type: string, code: string): void => {
    commitSection();
    state.section = newSection(type, code);
    state.inNotes = false;
  };

  for (const raw of lines) {
    if (isNoise(raw)) continue;
    const line = raw;

    const ch = COURSE_HEADER.exec(line);
    if (ch) {
      commitSection();
      const startMd = parseMonthDay(ch[5]!);
      const endMd = parseMonthDay(ch[6]!);
      state.year = Number(ch[3]);
      const draft: CourseDraft = {
        subject: ch[1]!,
        number: ch[2]!,
        code: `${ch[1]} ${ch[2]}`,
        title: '',
        termStart: toIsoDate(state.year, startMd.month, startMd.day),
        termEnd: toIsoDate(state.year, endMd.month, endMd.day),
        sections: [],
        _summaryMeetings: [],
      };
      // de-dupe: same course code may appear once per page (summary + detail)
      const existing = courses.find((c) => c.code === draft.code);
      if (existing) {
        state.course = existing;
      } else {
        courses.push(draft);
        state.course = draft;
      }
      state.expectTitle = true;
      continue;
    }

    const course = state.course;
    if (!course) continue; // ignore preamble

    if (state.expectTitle) {
      state.expectTitle = false;
      const sm = /^(.*Session)\s+(.+)$/.exec(line);
      if (sm) {
        if (!course.session) course.session = sm[1]!.trim();
        if (!course.title) course.title = sm[2]!.trim();
        continue;
      }
      // If line doesn't match, fall through and re-process.
    }

    const sh = SECTION_HEADER.exec(line);
    if (sh) {
      startSection(sh[1]!, sh[2]!);
      continue;
    }

    const sec = state.section;
    const mt = tryMeetingLine(line, state.year);
    if (mt) {
      if (sec && !state.inNotes) {
        sec.meetings.push(mt.meeting);
        sec._hadOwnMeetings = true;
      } else {
        // After Units (inNotes) or with no open section: this is part of the
        // course-summary colored bar that the PDF flows after the section
        // detail. Stash globally; we'll re-attribute in pass 2.
        course._summaryMeetings.push(mt.meeting);
      }
      continue;
    }

    if (sec) {
      const cn = CLASS_NUMBER.exec(line);
      if (cn) { sec.classNumber = cn[1]!.trim(); continue; }
      const st = SEATS.exec(line);
      if (st) { sec.seats = st[1]!.trim(); continue; }
      const wl = WAIT_LIST.exec(line);
      if (wl) { sec.waitList = wl[1]!.trim(); continue; }
      if (CAMPUS_HINT.test(line)) { sec.campus = line; continue; }
      if (DELIVERY_VALUES.has(line)) { sec.delivery = line; continue; }
      const u = UNITS.exec(line);
      if (u) {
        sec.units = Number(u[1]);
        if (state.pendingInstructor && !sec.instructor) {
          sec.instructor = state.pendingInstructor;
          state.pendingInstructor = null;
        }
        state.inNotes = true;
        continue;
      }
      if (state.inNotes) {
        sec.notes = sec.notes ? `${sec.notes}\n${line}` : line;
        continue;
      }
      if (LOCATION_HINT.test(line)) {
        const last = sec.meetings[sec.meetings.length - 1];
        if (last && !last.location) {
          last.location = line;
        } else {
          // Standalone location with no meeting yet (e.g. TUT D101): remember
          // it so the summary-derived meeting picks it up in pass 2.
          sec._pendingLocation = line;
        }
        continue;
      }
      // Anything else: provisional instructor name (last one wins until we
      // hit Units or close the section).
      state.pendingInstructor = line;
      continue;
    }
    // Outside a section but inside a course: ignore stray text.
  }

  commitSection();

  // Pass 2: reattribute summary-pool meetings to empty sections. SFU's PDF
  // flows the colored summary bar either between course headers (small course)
  // or at the bottom of the page (large course), so a meeting that belongs to
  // an earlier course may land in a later course's pool. We pool globally,
  // skip duplicates already owned by some section, and hand the remainder to
  // the lone empty section. When more than one section is empty, we'd need a
  // stronger heuristic  -  log and leave alone for now.
  const ownedKeys = new Set<string>();
  for (const c of courses) {
    for (const s of c.sections) {
      for (const m of s.meetings) ownedKeys.add(meetingKey(m));
    }
  }
  const pooled: SfuMeeting[] = [];
  const seenPool = new Set<string>();
  for (const c of courses) {
    for (const m of c._summaryMeetings) {
      const k = meetingKey(m);
      if (ownedKeys.has(k) || seenPool.has(k)) continue;
      seenPool.add(k);
      pooled.push(m);
    }
  }
  const emptySections: SectionDraft[] = [];
  for (const c of courses) {
    for (const s of c.sections) {
      if (!s._hadOwnMeetings) emptySections.push(s);
    }
  }
  if (pooled.length > 0 && emptySections.length === 1) {
    const target = emptySections[0]!;
    for (const m of pooled) {
      const copy: SfuMeeting = { ...m };
      if (!copy.location && target._pendingLocation) {
        copy.location = target._pendingLocation;
      }
      target.meetings.push(copy);
    }
  }

  // Strip internal markers.
  const courses_: SfuCourse[] = courses.map((c) => ({
    subject: c.subject,
    number: c.number,
    code: c.code,
    title: c.title,
    session: c.session,
    termStart: c.termStart,
    termEnd: c.termEnd,
    sections: c.sections.map((s) => ({
      type: s.type,
      code: s.code,
      classNumber: s.classNumber,
      status: s.status,
      seats: s.seats,
      waitList: s.waitList,
      campus: s.campus,
      delivery: s.delivery,
      instructor: s.instructor,
      units: s.units,
      meetings: s.meetings,
      notes: s.notes,
    })),
  }));

  if (courses_.length === 0) {
    throw new Error('no courses found in PDF text');
  }

  // Term info: take the widest span across all course headers.
  const allStarts = courses_.map((c) => c.termStart).sort();
  const allEnds = courses_.map((c) => c.termEnd).sort();
  const startDate = allStarts[0]!;
  const endDate = allEnds[allEnds.length - 1]!;
  const label = (() => {
    // Infer "<YEAR> <Season>" from first course's termStart.
    const y = startDate.slice(0, 4);
    const m = Number(startDate.slice(5, 7));
    const season = m >= 9 ? 'Fall' : m >= 5 ? 'Summer' : 'Spring';
    return `${y} ${season}`;
  })();

  return SfuScheduleSchema.parse({
    term: { label, startDate, endDate },
    printedBy,
    courses: courses_,
  });
}

export async function parseSchedulePdf(input: Buffer | Uint8Array): Promise<SfuSchedule> {
  const parser = new PDFParse({ data: input });
  try {
    const result = await parser.getText();
    return parseScheduleText(result.text);
  } finally {
    await parser.destroy();
  }
}
