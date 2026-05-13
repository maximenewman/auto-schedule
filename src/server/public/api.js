// Replaces the prototype's data.js. Same globals, but populated from the
// server instead of inlined. The shape exposed to the rest of the SPA is
// identical so util.jsx / schedule.jsx / subjects.jsx don't have to know.

window.TODAY = new Date();

window.SUBJECTS = [];
window.EVENTS = [];
window.SUBJECT_FILES = {};
window.SYNC_STATUS = {
  lastRunISO: null,
  nextRunISO: null,
  itemsAddedLastRun: 0,
  itemsAddedLastWeek: 0,
  agentErrorsLastWeek: 0,
  googleAuthOk: false,
  coursysAuthOk: false,
  coursysExpiresInDays: null,
  running: null,
};

const api = {
  subjects:    ()      => fetch('/api/subjects').then(r => r.json()),
  subject:     (id)    => fetch(`/api/subjects/${id}`).then(r => r.json()),
  events:      (from, to) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to)   params.set('to',   to);
    const q = params.toString();
    return fetch(`/api/events${q ? '?' + q : ''}`).then(r => r.json());
  },
  subjEvents:  (id, from, to) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to)   params.set('to',   to);
    const q = params.toString();
    return fetch(`/api/subjects/${id}/events${q ? '?' + q : ''}`).then(r => r.json());
  },
  files:       (id)    => fetch(`/api/subjects/${id}/files`).then(r => r.json()),
  status:      ()      => fetch('/api/status').then(r => r.json()),
  sync:        ()      => fetch('/api/sync', { method: 'POST' }).then(r => r.json()),
};

window.api = api;

/** Parse server event rows into the shape the rest of the SPA expects. */
function hydrateEvent(row) {
  return {
    itemId:    row.itemId,
    subjectId: row.subjectId,
    kind:      row.kind,
    summary:   row.summary,
    start:     new Date(row.startISO),
    end:       new Date(row.endISO),
    room:      row.room ?? '',
    description: row.description ?? '',
    attachments: row.attachments ?? [],
    sourceLabel: row.sourceLabel,
  };
}

function hydrateFile(row) {
  // The server returns size in bytes (or null). Render as a short string for the UI.
  let size = '';
  if (typeof row.size === 'number') {
    if (row.size > 1024 * 1024) size = (row.size / 1024 / 1024).toFixed(1) + ' MB';
    else if (row.size > 1024)   size = Math.round(row.size / 1024) + ' KB';
    else                        size = row.size + ' B';
  }
  return {
    filename: row.filename,
    size,
    addedISO: row.addedISO,
    path: row.path,
  };
}

window.bootData = async function bootData() {
  const [subjects, events, status] = await Promise.all([
    api.subjects(),
    api.events(),
    api.status(),
  ]);
  window.SUBJECTS = subjects;
  window.EVENTS = events.map(hydrateEvent);
  window.SYNC_STATUS = status;

  // Files per subject  -  fan out, but only after we know the subject IDs.
  const filesEntries = await Promise.all(
    subjects.map(async (s) => [s.id, (await api.files(s.id)).map(hydrateFile)]),
  );
  window.SUBJECT_FILES = Object.fromEntries(filesEntries);
};

/** Refresh just the volatile bits  -  events + status. */
window.refreshData = async function refreshData() {
  const [events, status] = await Promise.all([api.events(), api.status()]);
  window.EVENTS = events.map(hydrateEvent);
  window.SYNC_STATUS = status;
};
