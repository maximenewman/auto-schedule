export type Source =
  | { type: 'email'; label: string }
  | { type: 'site'; url: string };

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
  destinationFolder: string;
  sources: Source[];
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

export const subjects: Subject[] = [
  // Example  -  replace with real subjects before running.
  // {
  //   id: 'cmpt307',
  //   name: 'CMPT 307',
  //   professor: 'TBD',
  //   destinationFolder: 'downloads/cmpt307',
  //   sources: [
  //     { type: 'email', label: 'school/cmpt307' },
  //     { type: 'site', url: 'https://coursys.sfu.ca/2026sp-cmpt-307-d1/' },
  //   ],
  // },
  {
    id: 'cmpt307',
    code: 'CMPT 307',
    name: 'Data Structures and Algorithms',
    professor: 'Valentine Kabanets',
    term: 'Summer 2026',
    color: '#0066cc',
    destinationFolder: 'D:/Desktop/University/Summer 2026/CMPT 307',
    sources: [
      { type: 'email', label: 'CMPT 307' },
      { type: 'site', url: 'https://coursys.sfu.ca/2026su-cmpt-307-d1/pages/' },
    ],
  },
  {
    id: 'stat271',
    code: 'STAT 271',
    name: 'Probability and Statistics for Computing Science',
    professor: 'Sonja Isberg',
    term: 'Summer 2026',
    color: '#0f8a8a',
    destinationFolder: 'D:/Desktop/University/Summer 2026/STAT 271',
    sources: [
      { type: 'email', label: 'STAT 271' },
    ],
  },
  {
    id: 'stat302',
    code: 'STAT 302',
    name: 'Analysis of Experimental and Observational Data',
    professor: 'Gamage Harsha Perera',
    term: 'Summer 2026',
    color: '#1f8a5b',
    destinationFolder: 'D:/Desktop/University/Summer 2026/STAT 302',
    sources: [
      { type: 'email', label: 'STAT 302' },
    ],
  },
];
