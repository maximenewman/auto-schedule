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
];
