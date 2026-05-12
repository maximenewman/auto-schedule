export type Source =
  | { type: 'email'; label: string }
  | { type: 'site'; url: string };

export interface Subject {
  id: string;
  name: string;
  professor: string;
  destinationFolder: string;
  sources: Source[];
}

export const subjects: Subject[] = [
  // Example — replace with real subjects before running.
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
    name: 'CMPT 307',
    professor: 'TBD',
    destinationFolder: 'D:/Desktop/University/Summer 2026/CMPT 307',
    sources: [
      { type: 'email', label: 'CMPT 307' },
      { type: 'site', url: 'https://coursys.sfu.ca/2026su-cmpt-307-d1/pages/' },
    ],
  },
  {
    id: 'stat271',
    name: 'STAT 271',
    professor: 'TBD',
    destinationFolder: 'D:/Desktop/University/Summer 2026/STAT 271',
    sources: [
      { type: 'email', label: 'STAT 271' },
    ],
  },
  {
    id: 'stat302',
    name: 'STAT 302',
    professor: 'TBD',
    destinationFolder: 'D:/Desktop/University/Summer 2026/STAT 302',
    sources: [
      { type: 'email', label: 'STAT 302' },
    ],
  },
];
