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
  canvasConfigured: false,
  canvasTokenUpdatedAt: null,
  running: null,
};

// Defensive JSON fetcher: returns the fallback (default `null`) when the
// request fails or the server responds with non-200. Without this every
// 401/404/500 sent the caller a `{error}` object which then crashed when
// callers expected an array.
async function fetchJson(url, opts, fallback = null) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      console.warn('fetchJson:', url, 'HTTP', res.status);
      return fallback;
    }
    return await res.json();
  } catch (err) {
    console.warn('fetchJson:', url, err);
    return fallback;
  }
}

const api = {
  subjects:    ()      => fetchJson('/api/subjects', undefined, []),
  subject:     (id)    => fetchJson(`/api/subjects/${id}`),
  events:      (from, to) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to)   params.set('to',   to);
    const q = params.toString();
    return fetchJson(`/api/events${q ? '?' + q : ''}`, undefined, []);
  },
  subjEvents:  (id, from, to) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to)   params.set('to',   to);
    const q = params.toString();
    return fetchJson(`/api/subjects/${id}/events${q ? '?' + q : ''}`, undefined, []);
  },
  files:       (id)    => fetchJson(`/api/subjects/${encodeURIComponent(id)}/files`, undefined, []),
  fileUrl:     (id, disposition) =>
    fetchJson(`/api/files/${encodeURIComponent(id)}/url?disposition=${disposition || 'inline'}`),
  status:      ()      => fetchJson('/api/status', undefined, window.SYNC_STATUS),
  sync:        ()      => fetchJson('/api/sync', { method: 'POST' }, { started: false }),
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
    id: row.id,
    filename: row.filename,
    size,
    addedISO: row.addedISO,
    folderPath: row.folderPath || '',
  };
}

/** Trigger a browser download of a stored file via a short-lived URL. */
window.downloadStoredFile = async function downloadStoredFile(fileId, filename) {
  const res = await api.fileUrl(fileId, 'attachment');
  if (!res || !res.url) {
    alert('Could not get a download link — is object storage configured?');
    return;
  }
  const a = document.createElement('a');
  a.href = res.url;
  a.download = filename || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
};

function toArray(x) { return Array.isArray(x) ? x : []; }

window.bootData = async function bootData() {
  const [subjects, events, status] = await Promise.all([
    api.subjects(),
    api.events(),
    api.status(),
  ]);
  window.SUBJECTS = toArray(subjects);
  window.EVENTS = toArray(events).map(hydrateEvent);
  if (status && typeof status === 'object') window.SYNC_STATUS = status;

  // Files per subject — fan out, but only after we know the subject IDs.
  // `api.files` is a stub right now (the endpoint was retired); the loop
  // stays so when object-storage lands the call site is already shaped.
  const filesEntries = await Promise.all(
    window.SUBJECTS.map(async (s) => [s.id, toArray(await api.files(s.id)).map(hydrateFile)]),
  );
  window.SUBJECT_FILES = Object.fromEntries(filesEntries);
};

/** Refresh just the volatile bits — events + status. */
window.refreshData = async function refreshData() {
  const [events, status] = await Promise.all([api.events(), api.status()]);
  window.EVENTS = toArray(events).map(hydrateEvent);
  if (status && typeof status === 'object') window.SYNC_STATUS = status;
};
