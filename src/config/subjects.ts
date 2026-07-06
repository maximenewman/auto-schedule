export interface Subject {
  id: string;
  /** Short course code, e.g. "CMPT 307". Shown as the primary label in the UI. */
  code?: string;
  /** Full course name, e.g. "Data Structures and Algorithms". */
  name: string;
  professor: string;
  /** Default lecture room  -  falls back when an event doesn't specify one. */
  room?: string;
  /** SFU section the student is enrolled in, e.g. "D100". Used to pick the
   *  right section when enriching via api.sfucourses.com — different sections
   *  of the same course can have different instructors. */
  section?: string;
  /** Term label, e.g. "Summer 2026". */
  term?: string;
  /**
   * Hex color used by the UI for the event-block accent. Optional: when
   * absent the client derives one deterministically from `id`.
   */
  color?: string;
}

export const SUBJECT_PALETTE = [
  '#0066cc',
  '#1f8a5b',
  '#c97a17',
  '#7d4cdb',
  '#0f8a8a',
];

export function colorForSubject(subject: Subject): string {
  if (subject.color) return subject.color;
  let h = 0;
  for (let i = 0; i < subject.id.length; i++) {
    h = (h * 31 + subject.id.charCodeAt(i)) >>> 0;
  }
  return SUBJECT_PALETTE[h % SUBJECT_PALETTE.length]!;
}
