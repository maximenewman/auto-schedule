// Mock data for auto-schedule UI.
// "Today" is anchored to Monday, May 11, 2026 to match the project context.

window.TODAY = new Date(2026, 4, 11, 10, 22, 0); // Mon May 11 2026, 10:22am

// ---- Subjects -----------------------------------------------------------
window.SUBJECTS = [
  {
    id: 'cmpt307',
    code: 'CMPT 307',
    name: 'Data Structures and Algorithms',
    professor: 'Valentine Kabanets',
    room: 'AQ 3149',
    color: '#0066cc', // blue
    term: 'Summer 2026',
    destinationFolder: 'D:/Desktop/University/Summer 2026/CMPT 307',
    sources: [
      { type: 'email', label: 'CMPT 307' },
      { type: 'site', url: 'https://coursys.sfu.ca/2026su-cmpt-307-d1/pages/' },
    ],
  },
  {
    id: 'cmpt354',
    code: 'CMPT 354',
    name: 'Database Systems I',
    professor: 'Fred Popowich',
    room: 'SUR 3090',
    color: '#1f8a5b', // green
    term: 'Summer 2026',
    destinationFolder: 'D:/Desktop/University/Summer 2026/CMPT 354',
    sources: [
      { type: 'email', label: 'CMPT 354' },
      { type: 'site', url: 'https://coursys.sfu.ca/2026su-cmpt-354-d1/pages/' },
    ],
  },
  {
    id: 'cmpt376w',
    code: 'CMPT 376W',
    name: 'Professional Responsibility & Technical Writing',
    professor: 'Diana Cukierman',
    room: 'AQ 3005',
    color: '#c97a17', // amber
    term: 'Summer 2026',
    destinationFolder: 'D:/Desktop/University/Summer 2026/CMPT 376W',
    sources: [
      { type: 'email', label: 'CMPT 376W' },
      { type: 'site', url: 'https://coursys.sfu.ca/2026su-cmpt-376w-d1/pages/' },
    ],
  },
  {
    id: 'math232',
    code: 'MATH 232',
    name: 'Applied Linear Algebra',
    professor: 'Jonathan Jedwab',
    room: 'WMC 3260',
    color: '#7d4cdb', // purple
    term: 'Summer 2026',
    destinationFolder: 'D:/Desktop/University/Summer 2026/MATH 232',
    sources: [
      { type: 'site', url: 'https://coursys.sfu.ca/2026su-math-232-d1/pages/' },
    ],
  },
  {
    id: 'stat270',
    code: 'STAT 270',
    name: 'Introduction to Probability and Statistics',
    professor: 'Richard Lockhart',
    room: 'SSCB 9201',
    color: '#0f8a8a', // teal
    term: 'Summer 2026',
    destinationFolder: 'D:/Desktop/University/Summer 2026/STAT 270',
    sources: [
      { type: 'email', label: 'STAT 270' },
      { type: 'site', url: 'https://coursys.sfu.ca/2026su-stat-270-d1/pages/' },
    ],
  },
];

// ---- Events -------------------------------------------------------------
// Helper to make Date(year, monthIndex, day, hour, minute)
function d(y, m, day, h, min) { return new Date(y, m - 1, day, h || 0, min || 0); }

// Generate recurring lecture instances for a week range
function recur(subjectId, kind, summary, dayName, startH, startM, endH, endM, room) {
  const dayMap = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
  const target = dayMap[dayName];
  const out = [];
  const weekStarts = [d(2026, 5, 4), d(2026, 5, 11), d(2026, 5, 18), d(2026, 5, 25)];
  weekStarts.forEach((ws) => {
    const dt = new Date(ws.getTime());
    const offset = (target - dt.getDay() + 7) % 7;
    dt.setDate(dt.getDate() + offset);
    const start = new Date(dt.getTime()); start.setHours(startH, startM || 0, 0, 0);
    const end = new Date(dt.getTime()); end.setHours(endH, endM || 0, 0, 0);
    const isoDay = start.getFullYear() + '-' + String(start.getMonth() + 1).padStart(2, '0') + '-' + String(start.getDate()).padStart(2, '0');
    out.push({
      itemId: `${kind}-${isoDay}`,
      subjectId, kind, summary, start, end, room,
    });
  });
  return out;
}

window.EVENTS = [
  // Lectures (recurring)
  ...recur('cmpt307', 'lecture', 'Lecture · Greedy algorithms', 'mon', 10, 30, 12, 20, 'AQ 3149'),
  ...recur('cmpt307', 'lecture', 'Lecture · Dynamic programming', 'wed', 10, 30, 12, 20, 'AQ 3149'),
  ...recur('cmpt307', 'tutorial', 'Tutorial · D101', 'fri', 13, 30, 14, 20, 'AQ 5005'),

  ...recur('cmpt354', 'lecture', 'Lecture · Relational algebra', 'tue', 14, 30, 16, 20, 'SUR 3090'),
  ...recur('cmpt354', 'lecture', 'Lecture · SQL joins & subqueries', 'thu', 14, 30, 16, 20, 'SUR 3090'),

  ...recur('cmpt376w', 'lecture', 'Lecture · Audience & argument', 'mon', 14, 30, 16, 20, 'AQ 3005'),
  ...recur('cmpt376w', 'lecture', 'Lecture · Peer review workshop', 'wed', 14, 30, 16, 20, 'AQ 3005'),

  ...recur('math232', 'lecture', 'Lecture · Vector spaces', 'mon', 8, 30, 10, 20, 'WMC 3260'),
  ...recur('math232', 'lecture', 'Lecture · Linear transformations', 'wed', 8, 30, 10, 20, 'WMC 3260'),
  ...recur('math232', 'tutorial', 'Tutorial · D102', 'thu', 12, 30, 13, 20, 'WMC 2830'),

  ...recur('stat270', 'lecture', 'Lecture · Discrete distributions', 'tue', 10, 30, 12, 20, 'SSCB 9201'),
  ...recur('stat270', 'lecture', 'Lecture · Joint distributions', 'thu', 10, 30, 12, 20, 'SSCB 9201'),

  // Office hours
  { itemId: 'oh-kabanets-2026-05-12', subjectId: 'cmpt307', kind: 'office-hours',
    summary: 'Office hours · Kabanets', start: d(2026,5,12,15,0), end: d(2026,5,12,16,0), room: 'TASC1 8011' },
  { itemId: 'oh-popowich-2026-05-13', subjectId: 'cmpt354', kind: 'office-hours',
    summary: 'Office hours · Popowich', start: d(2026,5,13,11,0), end: d(2026,5,13,12,0), room: 'TASC1 9417' },

  // Assignments / midterms (point-in-time, due)
  { itemId: 'a2', subjectId: 'cmpt307', kind: 'assignment',
    summary: 'Assignment 2 due · Greedy & DP problems',
    start: d(2026,5,15,23,59), end: d(2026,5,15,23,59), room: 'CourSys' },
  { itemId: 'a3', subjectId: 'cmpt307', kind: 'assignment',
    summary: 'Assignment 3 due · Network flow',
    start: d(2026,5,22,23,59), end: d(2026,5,22,23,59), room: 'CourSys' },
  { itemId: 'midterm-1', subjectId: 'cmpt307', kind: 'midterm',
    summary: 'Midterm 1 · Chapters 1–4',
    start: d(2026,5,20,18,30), end: d(2026,5,20,20,30), room: 'AQ 3149' },

  { itemId: 'lab2', subjectId: 'cmpt354', kind: 'assignment',
    summary: 'Lab 2 due · Schema design',
    start: d(2026,5,14,23,59), end: d(2026,5,14,23,59), room: 'CourSys' },
  { itemId: 'project-proposal', subjectId: 'cmpt354', kind: 'assignment',
    summary: 'Project proposal due',
    start: d(2026,5,21,23,59), end: d(2026,5,21,23,59), room: 'CourSys' },

  { itemId: 'memo-2', subjectId: 'cmpt376w', kind: 'assignment',
    summary: 'Memo draft 2 due',
    start: d(2026,5,13,23,59), end: d(2026,5,13,23,59), room: 'CourSys' },

  { itemId: 'a3-math', subjectId: 'math232', kind: 'assignment',
    summary: 'Assignment 3 due · Eigenvalues',
    start: d(2026,5,16,23,59), end: d(2026,5,16,23,59), room: 'CourSys' },
  { itemId: 'midterm-1-math', subjectId: 'math232', kind: 'midterm',
    summary: 'Midterm 1 · Chapters 1–3',
    start: d(2026,5,19,18,30), end: d(2026,5,19,20,30), room: 'WMC 3260' },

  { itemId: 'a4-stat', subjectId: 'stat270', kind: 'assignment',
    summary: 'Assignment 4 due · Conditional probability',
    start: d(2026,5,17,23,59), end: d(2026,5,17,23,59), room: 'CourSys' },
];

// ---- Per-subject attachments and assignments (for detail page) -----------
window.SUBJECT_FILES = {
  cmpt307: [
    { filename: 'lec05-greedy.pdf', size: '2.1 MB', addedISO: '2026-05-11' },
    { filename: 'lec04-divide-conquer.pdf', size: '1.8 MB', addedISO: '2026-05-06' },
    { filename: 'a2.pdf', size: '244 KB', addedISO: '2026-05-04' },
    { filename: 'syllabus.pdf', size: '188 KB', addedISO: '2026-04-30' },
    { filename: 'a1-solutions.pdf', size: '512 KB', addedISO: '2026-04-29' },
  ],
  cmpt354: [
    { filename: 'lec06-sql-joins.pdf', size: '3.4 MB', addedISO: '2026-05-08' },
    { filename: 'lab2-handout.pdf', size: '198 KB', addedISO: '2026-05-07' },
    { filename: 'er-diagrams.pdf', size: '1.1 MB', addedISO: '2026-05-05' },
    { filename: 'syllabus.pdf', size: '210 KB', addedISO: '2026-04-30' },
  ],
  cmpt376w: [
    { filename: 'memo-style-guide.pdf', size: '420 KB', addedISO: '2026-05-09' },
    { filename: 'rubric-memo-2.pdf', size: '88 KB', addedISO: '2026-05-09' },
    { filename: 'syllabus.pdf', size: '156 KB', addedISO: '2026-04-30' },
  ],
  math232: [
    { filename: 'a3-eigenvalues.pdf', size: '320 KB', addedISO: '2026-05-10' },
    { filename: 'lec08-transformations.pdf', size: '1.9 MB', addedISO: '2026-05-08' },
    { filename: 'midterm-review.pdf', size: '670 KB', addedISO: '2026-05-07' },
    { filename: 'syllabus.pdf', size: '174 KB', addedISO: '2026-04-30' },
  ],
  stat270: [
    { filename: 'a4-cond-prob.pdf', size: '256 KB', addedISO: '2026-05-09' },
    { filename: 'lec07-joint.pdf', size: '2.6 MB', addedISO: '2026-05-08' },
    { filename: 'tables-distributions.pdf', size: '92 KB', addedISO: '2026-04-30' },
    { filename: 'syllabus.pdf', size: '198 KB', addedISO: '2026-04-30' },
  ],
};

// ---- Pipeline / sync status (mock) ---------------------------------------
window.SYNC_STATUS = {
  lastRunISO: '2026-05-11T08:00:14',
  nextRunISO: '2026-05-11T20:00:00',
  itemsAddedLastRun: 3,
  itemsAddedLastWeek: 14,
  agentErrorsLastWeek: 0,
  googleAuthOk: true,
  coursysAuthOk: true,
  coursysExpiresInDays: 4,
};
