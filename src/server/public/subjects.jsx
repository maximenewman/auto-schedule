/* global React, Util */
const { useState, useCallback, useMemo } = React;

const COLOR_OPTIONS = ['#0066cc', '#1f8a5b', '#c97a17', '#7d4cdb', '#0f8a8a', '#d04a5b'];

async function connectGoogle() {
  const res = await fetch('/api/google/start-url');
  if (!res.ok) {
    alert('Could not start the Google connect flow (HTTP ' + res.status + ').');
    return;
  }
  const { url } = await res.json();
  window.location.assign(url);
}

async function disconnectGoogle() {
  await fetch('/api/google/disconnect', { method: 'POST' });
  await window.refreshData();
  window.location.reload();
}

async function setCanvasToken() {
  const token = window.prompt(
    'Paste your Canvas access token.\n(Canvas -> Account -> Settings -> New access token)',
  );
  if (!token || !token.trim()) return;
  const res = await fetch('/api/canvas/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: token.trim() }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(body.error || 'Canvas rejected the token.');
    return;
  }
  alert(`Canvas connected as ${body.canvasUser}. Importing courses now...`);
  await importFromCanvas();
}

async function importFromCanvas() {
  const res = await fetch('/api/import/canvas', { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || 'Canvas import failed to start.');
    return;
  }
  // NDJSON stream — drain it so we only reload once the run is done.
  try { await res.text(); } catch { /* stream interrupted */ }
  window.location.reload();
}

function statusPills() {
  const s = window.SYNC_STATUS;
  const confirmDisconnect = () => {
    if (window.confirm('Disconnect Google Calendar? Events stay in the app; they just stop syncing to Google.')) {
      disconnectGoogle();
    }
  };
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      {s.canvasConfigured ? (
        <button type="button" className="sync-pill" onClick={importFromCanvas}
                title="Pull courses, announcements, events, and files from Canvas">
          <span className="dot"></span>
          Canvas connected
          <span className="action">Sync now</span>
        </button>
      ) : (
        <button type="button" className="sync-pill" onClick={setCanvasToken}
                title="Paste a Canvas access token to auto-import your courses">
          <span className="dot warn"></span>
          <span className="action">Add Canvas token</span>
        </button>
      )}
      {s.googleAuthOk ? (
        <button type="button" className="sync-pill" onClick={confirmDisconnect}
                title="Events sync to your Google Calendar">
          <span className="dot"></span>
          Google Calendar on
          <span className="action">Disconnect</span>
        </button>
      ) : (
        <button type="button" className="sync-pill" onClick={connectGoogle}
                title="Optional: mirror your schedule into Google Calendar">
          <span className="dot warn"></span>
          <span className="action">Connect Google Calendar</span>
        </button>
      )}
    </div>
  );
}

function emptySubject() {
  return {
    id: '',
    code: '',
    name: '',
    professor: '',
    room: '',
    section: '',
    term: '',
    color: COLOR_OPTIONS[0],
  };
}

function normalizeSubjectForApi(s) {
  const out = {
    id: s.id.trim(),
    name: s.name.trim(),
    professor: (s.professor || '').trim(),
  };
  if (s.code && s.code.trim()) out.code = s.code.trim();
  if (s.room && s.room.trim()) out.room = s.room.trim();
  if (s.section && /^[A-Z]\d{2,4}$/i.test(s.section.trim())) {
    out.section = s.section.trim().toUpperCase();
  }
  if (s.term && s.term.trim()) out.term = s.term.trim();
  if (s.color && /^#[0-9a-fA-F]{6}$/.test(s.color)) out.color = s.color;
  return out;
}

function SubjectForm({ initial, mode, onCancel, onSaved }) {
  const [form, setForm] = useState(() => ({ ...emptySubject(), ...initial }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const isEdit = mode === 'edit';

  const update = (patch) => setForm((f) => ({ ...f, ...patch }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload = normalizeSubjectForApi(form);
      const url = isEdit ? `/api/subjects/${encodeURIComponent(payload.id)}` : '/api/subjects';
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = body.issues
          ? body.issues.map((i) => `${i.path}: ${i.message}`).join('  -  ')
          : (body.error || `HTTP ${res.status}`);
        throw new Error(msg);
      }
      await window.bootData();
      onSaved && onSaved();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit} className="subject-form">
          <header>
            <h2>{isEdit ? `Edit ${form.code || form.id}` : 'Add subject'}</h2>
            <button type="button" className="close" onClick={onCancel} aria-label="Close">x</button>
          </header>

          <div className="grid-2">
            <label>
              <span>id</span>
              <input
                type="text"
                value={form.id}
                onChange={(e) => update({ id: e.target.value })}
                disabled={isEdit}
                required
                placeholder="cmpt307"
                pattern="[a-zA-Z0-9_-]+"
              />
            </label>
            <label>
              <span>Course code</span>
              <input
                type="text"
                value={form.code}
                onChange={(e) => update({ code: e.target.value })}
                placeholder="CMPT 307"
              />
            </label>
            <label className="span-2">
              <span>Name</span>
              <input
                type="text"
                value={form.name}
                onChange={(e) => update({ name: e.target.value })}
                required
                placeholder="Data Structures and Algorithms"
              />
            </label>
            <label>
              <span>Professor</span>
              <input
                type="text"
                value={form.professor}
                onChange={(e) => update({ professor: e.target.value })}
                placeholder="Valentine Kabanets"
              />
            </label>
            <label>
              <span>Default room</span>
              <input
                type="text"
                value={form.room}
                onChange={(e) => update({ room: e.target.value })}
                placeholder="AQ 3149"
              />
            </label>
            <label>
              <span>Section</span>
              <input
                type="text"
                value={form.section || ''}
                onChange={(e) => update({ section: e.target.value })}
                placeholder="D100"
                pattern="[A-Za-z]\d{2,4}"
              />
            </label>
            <label>
              <span>Term</span>
              <input
                type="text"
                value={form.term}
                onChange={(e) => update({ term: e.target.value })}
                placeholder="Summer 2026"
              />
            </label>
            <label>
              <span>Color</span>
              <div className="color-row">
                {COLOR_OPTIONS.map((c) => (
                  <button
                    type="button"
                    key={c}
                    aria-label={c}
                    className={"swatch" + (form.color === c ? ' active' : '')}
                    style={{ background: c }}
                    onClick={() => update({ color: c })}
                  />
                ))}
              </div>
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}
          <footer>
            <button type="button" className="btn-ghost-pill" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Saving...' : isEdit ? 'Save changes' : 'Add subject'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

const PREVIEWABLE_IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

// Group files by their Canvas origin (module name / page title / folder),
// preserving the server's course ordering. Consecutive-run grouping keeps
// "Module 1, Module 2, ..." in the order Canvas presents them.
function groupFilesBySource(files) {
  const groups = [];
  for (const f of files) {
    const label = f.folderPath || 'Other files';
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(f);
    else groups.push({ label, items: [f] });
  }
  return groups;
}

// Accordion over the module groups so a term's worth of files doesn't turn
// the page into an endless scroll. First group starts open; the rest are a
// header + count until clicked.
function FilesBlock({ files, onView }) {
  const groups = groupFilesBySource(files);
  const [open, setOpen] = React.useState(() => new Set(groups.length ? [groups[0].label] : []));
  const toggle = (label) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    return next;
  });
  const allOpen = groups.every((g) => open.has(g.label));

  if (files.length === 0) {
    return (
      <div className="files-list">
        <div style={{ padding: '14px 18px', color: 'var(--ink-muted-48)', fontSize: 14 }}>
          No files synced yet. Click "Sync files" above.
        </div>
      </div>
    );
  }
  return (
    <div>
      <div style={{ textAlign: 'right', margin: '6px 0' }}>
        <button
          type="button"
          className="btn-ghost-pill"
          style={{ fontSize: 12 }}
          onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.label)))}
        >
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      {groups.map((group) => {
        const expanded = open.has(group.label);
        return (
          <div key={group.label} style={{ marginBottom: 8 }}>
            <button
              type="button"
              onClick={() => toggle(group.label)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '9px 12px', cursor: 'pointer', textAlign: 'left',
                background: 'var(--parchment, rgba(0,0,0,0.03))',
                border: '1px solid var(--hairline)', borderRadius: 8,
                font: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--ink-muted-80)',
              }}
            >
              <span style={{ fontSize: 11, width: 12 }}>{expanded ? 'v' : '>'}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {group.label}
              </span>
              <span style={{ fontWeight: 400, color: 'var(--ink-muted-48)', fontSize: 12 }}>
                {group.items.length} file{group.items.length === 1 ? '' : 's'}
              </span>
            </button>
            {expanded && (
              <div className="files-list" style={{ marginTop: 4 }}>
                {group.items.map((f) => (
                  <div
                    key={f.id ?? f.filename}
                    className="file-row"
                    style={{ cursor: 'pointer' }}
                    title="View / download"
                    onClick={() => onView(f)}
                  >
                    <span className="file-icon">{(f.filename.split('.').pop() || 'FILE').toUpperCase().slice(0, 4)}</span>
                    <div className="name">
                      {f.filename}
                      <div className="meta">Updated {f.addedISO ? new Date(f.addedISO).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ' - '}</div>
                    </div>
                    <div className="size">{f.size}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// In-app file viewer: previews PDFs/images inline through a short-lived
// storage URL; everything else gets a download-only card. The Download
// button always fetches a fresh attachment-disposition URL.
function FileViewer({ file, onClose }) {
  const [url, setUrl] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let alive = true;
    window.api.fileUrl(file.id, 'inline').then((res) => {
      if (!alive) return;
      if (res && res.url) setUrl(res.url);
      else setError((res && res.error) || 'Could not load the file.');
    });
    return () => { alive = false; };
  }, [file.id]);

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ext = (file.filename.split('.').pop() || '').toLowerCase();
  const isPdf = ext === 'pdf';
  const isImage = PREVIEWABLE_IMAGE.has(ext);

  let body;
  if (error) {
    body = <div style={{ padding: 24, color: 'var(--ink-muted-48)' }}>{error}</div>;
  } else if (!url) {
    body = <div style={{ padding: 24, color: 'var(--ink-muted-48)' }}>Loading preview...</div>;
  } else if (isPdf) {
    body = <iframe title={file.filename} src={url} style={{ border: 0, width: '100%', height: '100%' }} />;
  } else if (isImage) {
    body = (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', overflow: 'auto' }}>
        <img src={url} alt={file.filename} style={{ maxWidth: '100%', maxHeight: '100%' }} />
      </div>
    );
  } else {
    body = (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--ink-muted-80)' }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>{(ext || 'file').toUpperCase()}</div>
        <div>No inline preview for this file type.</div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(980px, 94vw)', height: '86vh', display: 'flex', flexDirection: 'column' }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file.filename}
          </h2>
          <button
            type="button"
            className="btn-ghost-pill"
            onClick={() => window.downloadStoredFile(file.id, file.filename)}
          >
            Download
          </button>
          <button type="button" className="close" onClick={onClose} aria-label="Close">x</button>
        </header>
        <div style={{ flex: 1, minHeight: 0 }}>{body}</div>
      </div>
    </div>
  );
}

// Synthetic buckets the iCal sync creates that shouldn't appear as a
// regular subject card (events tagged with this id still render in the
// schedule view  -  Util.subjectById still finds them in window.SUBJECTS).
const HIDDEN_SUBJECT_IDS = new Set(['holidays']);

function DedupButton() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState(null); // { subjectMerges, eventMerges }
  const [subjectChecks, setSubjectChecks] = useState({});
  const [eventChecks, setEventChecks] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const close = () => {
    setOpen(false);
    setPlan(null);
    setSubjectChecks({});
    setEventChecks({});
    setError(null);
    setResult(null);
  };

  const openModal = async () => {
    setOpen(true);
    setLoading(true);
    setError(null);
    setResult(null);
    setPlan(null);
    try {
      const res = await fetch('/api/subjects/dedup');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setPlan(body);
      const subs = {};
      (body.subjectMerges || []).forEach((m, i) => { subs[i] = true; });
      const evs = {};
      (body.eventMerges || []).forEach((m, i) => { evs[i] = true; });
      setSubjectChecks(subs);
      setEventChecks(evs);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    if (!plan) return;
    const subjectMerges = (plan.subjectMerges || []).filter((_, i) => subjectChecks[i]);
    const eventMerges = (plan.eventMerges || []).filter((_, i) => eventChecks[i]);
    if (subjectMerges.length === 0 && eventMerges.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/subjects/dedup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subjectMerges, eventMerges }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setResult(body);
      await window.bootData();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const isEmpty = plan && (plan.subjectMerges || []).length === 0 && (plan.eventMerges || []).length === 0;

  const modal = open ? (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal import-result" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Find duplicates</h2>
          <button type="button" className="close" onClick={close} aria-label="Close">x</button>
        </header>
        <div className="body">
          {loading && <div style={{ color: 'var(--ink-muted-80)' }}>Agent is analysing subjects + event clusters...</div>}
          {!loading && isEmpty && !result && (
            <div style={{ color: 'var(--ink-muted-80)', fontSize: 14 }}>
              No duplicates detected by the agent.
            </div>
          )}
          {!loading && plan && !isEmpty && (
            <>
              <p style={{ fontSize: 13, color: 'var(--ink-muted-80)', margin: '4px 0 12px' }}>
                The agent proposes the merges below. Subject merges run first (re-attributing events), then event merges drop duplicate Google entries and record a redirect so future syncs don't recreate them.
              </p>
              {(plan.subjectMerges || []).length > 0 && (
                <>
                  <h3 className="dedup-section-h">Subject merges</h3>
                  <div className="dedup-list">
                    {plan.subjectMerges.map((m, i) => (
                      <label key={`s${i}`} className="dedup-row">
                        <input
                          type="checkbox"
                          checked={!!subjectChecks[i]}
                          onChange={(e) => setSubjectChecks({ ...subjectChecks, [i]: e.target.checked })}
                        />
                        <div style={{ flex: 1 }}>
                          <div><strong>{m.fromId}</strong> -> <strong>{m.intoId}</strong></div>
                          <div className="sub">{m.reason}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </>
              )}
              {(plan.eventMerges || []).length > 0 && (
                <>
                  <h3 className="dedup-section-h">Event merges</h3>
                  <div className="dedup-list">
                    {plan.eventMerges.map((m, i) => (
                      <label key={`e${i}`} className="dedup-row">
                        <input
                          type="checkbox"
                          checked={!!eventChecks[i]}
                          onChange={(e) => setEventChecks({ ...eventChecks, [i]: e.target.checked })}
                        />
                        <div style={{ flex: 1 }}>
                          <div>Keep <code>{m.canonicalEventId.slice(0, 16)}...</code>, drop {m.redundantEventIds.length} other{m.redundantEventIds.length === 1 ? '' : 's'}</div>
                          <div className="sub">{m.reason}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          {result && (
            <div className="summary" style={{ marginTop: 14 }}>
              {result.subjectMerges} subject merge{result.subjectMerges === 1 ? '' : 's'}  -  {result.eventMerges} event merge{result.eventMerges === 1 ? '' : 's'}  -  {result.googleEventsDeleted} Google events removed.
            </div>
          )}
          {error && <div className="form-error" style={{ marginTop: 12 }}>{error}</div>}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn-ghost-pill" onClick={close} disabled={busy}>Close</button>
          {plan && !isEmpty && !result && (
            <button type="button" className="btn-primary" onClick={apply} disabled={busy}>
              {busy ? 'Merging...' : 'Apply selected'}
            </button>
          )}
        </footer>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button type="button" className="btn-ghost-pill" onClick={openModal}>Find duplicates</button>
      {modal && ReactDOM.createPortal(modal, document.body)}
    </>
  );
}

function SubjectsPage({ now }) {
  const [form, setForm] = useState(null); // { mode: 'create' | 'edit', subject? }
  const visibleSubjects = window.SUBJECTS.filter((s) => !HIDDEN_SUBJECT_IDS.has(s.id));

  return (
    <div data-screen-label="Subjects">
      <SubNav
        title="Subjects"
        right={(
          <>
            <DedupButton />
            <button className="btn-primary" onClick={() => setForm({ mode: 'create' })}>
              Add subject
            </button>
          </>
        )}
      />
      <div className="subjects-page">
        <div className="hero">
          <div>
            <h1>Your classes</h1>
            <div className="sub">
              {visibleSubjects.length} subjects  -  synced from Canvas and CourSys
            </div>
          </div>
          {statusPills()}
        </div>

        <div className="subjects-grid">
          {visibleSubjects.map((s) => {
            const next = window.EVENTS
              .filter((e) => e.subjectId === s.id && e.start > now)
              .sort((a, b) => a.start - b.start)[0];
            const upcomingDeadlines = window.EVENTS
              .filter((e) => e.subjectId === s.id && (e.kind === 'assignment' || e.kind === 'midterm' || e.kind === 'exam') && e.start > now).length;
            const files = (window.SUBJECT_FILES[s.id] || []).length;
            return (
              <a key={s.id} href={`#/subjects/${s.id}`} className="subject-card">
                <div className="accent" style={{ background: s.color }}></div>
                <div className="code">{s.code || s.id}</div>
                <div className="name">{s.name}</div>
                <div className="prof">
                  {s.section ? `${s.section} · ` : ''}
                  {s.professor}{s.room ? `  -  ${s.room}` : ''}
                </div>
                {next ? (
                  <div style={{ marginTop: 14, fontSize: 13, color: 'var(--ink-muted-80)' }}>
                    <span style={{ color: 'var(--ink-muted-48)' }}>Next  -  </span>
                    {next.summary.replace(/^(Lecture|Tutorial|Office hours)  -  /, '')}
                    <div style={{ fontSize: 12, color: 'var(--ink-muted-48)', marginTop: 2 }}>
                      {Util.relTime(next.start, now)}  -  {Util.fmtTime(next.start)}
                    </div>
                  </div>
                ) : (
                  <div style={{ marginTop: 14, fontSize: 13, color: 'var(--ink-muted-48)' }}>No upcoming events</div>
                )}
                <div className="stats">
                  <div className="stat"><div className="n">{upcomingDeadlines}</div><div className="l">Due</div></div>
                  <div className="stat"><div className="n">{files}</div><div className="l">Files</div></div>
                </div>
              </a>
            );
          })}
          <button
            type="button"
            onClick={() => setForm({ mode: 'create' })}
            className="subject-card"
            style={{
              border: '1px dashed var(--hairline)', alignItems: 'center', justifyContent: 'center',
              textAlign: 'center', minHeight: 220, background: 'transparent', cursor: 'pointer',
            }}>
            <div style={{ fontSize: 32, color: 'var(--ink-muted-32)', marginBottom: 4 }}>+</div>
            <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--ink-muted-80)' }}>Add subject</div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted-48)', marginTop: 4 }}>Most subjects appear automatically from Canvas / CourSys</div>
          </button>
        </div>
      </div>

      {form && (
        <SubjectForm
          mode={form.mode}
          initial={form.subject ?? {}}
          onCancel={() => setForm(null)}
          onSaved={() => setForm(null)}
        />
      )}
    </div>
  );
}

// Everything with a deadline for this subject: assignments plus
// midterms/exams, soonest first.
function DueBlock({ subjectId, now }) {
  const due = window.EVENTS
    .filter((e) =>
      e.subjectId === subjectId &&
      (e.kind === 'assignment' || e.kind === 'midterm' || e.kind === 'exam') &&
      e.end >= now)
    .sort((a, b) => a.start - b.start);
  if (due.length === 0) {
    return (
      <div className="sources-card">
        <div style={{ padding: '14px 18px', color: 'var(--ink-muted-48)', fontSize: 14 }}>
          Nothing due  -  all caught up.
        </div>
      </div>
    );
  }
  return (
    <div className="assignment-list">
      {due.map((e) => {
        const isInstant = e.start.getTime() === e.end.getTime();
        return (
          <div key={e.itemId + e.start.toISOString()} className="assignment-row">
            <div className="when">
              <span className="day">{e.start.toLocaleDateString('en-US', { weekday: 'short', month: 'short' })}</span>
              {e.start.getDate()}  -  {Util.fmtTimeShort(e.start)}
            </div>
            <div>
              <div className="title">{e.summary.replace(/^(Lecture|Tutorial|Office hours)  -  /, '')}</div>
              <div className="sub">
                {Util.relTime(e.start, now)}
                {isInstant ? `  -  due ${Util.fmtTime(e.start)}` : `  -  ${Util.fmtTime(e.start)} - ${Util.fmtTime(e.end)}`}
                {e.room ? `  -  ${e.room}` : ''}
              </div>
            </div>
            <div className={"kind " + e.kind}>{Util.kindLabel(e.kind)}</div>
          </div>
        );
      })}
    </div>
  );
}

// Latest announcements for one subject, with a link to the filtered
// announcements page.
function AnnouncementsBlock({ subjectId }) {
  const [items, setItems] = React.useState(null);

  React.useEffect(() => {
    let alive = true;
    window.api.announcements(subjectId, 5).then((rows) => {
      if (alive) setItems(Array.isArray(rows) ? rows : []);
    });
    return () => { alive = false; };
  }, [subjectId]);

  if (items === null) {
    return <div className="sources-card"><div style={{ padding: '14px 18px', color: 'var(--ink-muted-48)', fontSize: 14 }}>Loading...</div></div>;
  }
  if (items.length === 0) {
    return <div className="sources-card"><div style={{ padding: '14px 18px', color: 'var(--ink-muted-48)', fontSize: 14 }}>No announcements for this subject yet.</div></div>;
  }
  return (
    <div className="sources-card">
      {items.map((a) => (
        <a
          key={a.entryId}
          href={`#/announcements/${encodeURIComponent(subjectId)}`}
          style={{ display: 'block', padding: '10px 16px', borderTop: '1px solid var(--divider-soft)', textDecoration: 'none' }}
        >
          <div style={{ fontSize: 14, color: 'var(--ink)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.title}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-muted-48)', marginTop: 2 }}>
            {a.publishedAt ? new Date(a.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
            {a.author ? `  -  ${a.author}` : ''}
          </div>
        </a>
      ))}
      <a
        href={`#/announcements/${encodeURIComponent(subjectId)}`}
        style={{ display: 'block', padding: '10px 16px', borderTop: '1px solid var(--divider-soft)', fontSize: 13 }}
      >
        View all announcements {'->'}
      </a>
    </div>
  );
}

function ExamsBlock({ subjectId, now }) {
  const exams = window.EVENTS
    .filter((e) => e.subjectId === subjectId && (e.kind === 'midterm' || e.kind === 'exam') && e.end >= now)
    .sort((a, b) => a.start - b.start);
  if (exams.length === 0) {
    return (
      <div className="sources-card">
        <div style={{ padding: '14px 18px', color: 'var(--ink-muted-48)', fontSize: 14 }}>
          No midterms or exams scheduled.
        </div>
      </div>
    );
  }
  return (
    <div className="assignment-list">
      {exams.map((e) => {
        const isInstant = e.start.getTime() === e.end.getTime();
        return (
          <div key={e.itemId + e.start.toISOString()} className="assignment-row">
            <div className="when">
              <span className="day">{e.start.toLocaleDateString('en-US', { weekday: 'short', month: 'short' })}</span>
              {e.start.getDate()}  -  {Util.fmtTimeShort(e.start)}
            </div>
            <div>
              <div className="title">{e.summary.replace(/^(Lecture|Tutorial|Office hours)  -  /, '')}</div>
              <div className="sub">{isInstant ? `Due${e.room ? `  -  ${e.room}` : ''}` : `${Util.fmtTime(e.start)} - ${Util.fmtTime(e.end)}${e.room ? `  -  ${e.room}` : ''}`}</div>
            </div>
            <div className={"kind " + e.kind}>{Util.kindLabel(e.kind)}</div>
          </div>
        );
      })}
    </div>
  );
}

function SubjectDetail({ id, now }) {
  const [editing, setEditing] = useState(false);
  const [viewingFile, setViewingFile] = useState(null);
  const [syncingFiles, setSyncingFiles] = useState(false);
  const [, forceRender] = useState(0);
  const s = Util.subjectById(id);

  const syncFiles = useCallback(async () => {
    if (syncingFiles) return;
    setSyncingFiles(true);
    try {
      const res = await fetch(`/api/subjects/${encodeURIComponent(id)}/files/sync`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(body.error || 'File sync failed.');
        return;
      }
      const rows = await window.api.files(id);
      window.SUBJECT_FILES[id] = (Array.isArray(rows) ? rows : []).map(window.hydrateFile);
      forceRender((n) => n + 1);
    } finally {
      setSyncingFiles(false);
    }
  }, [id, syncingFiles]);

  const handleDelete = useCallback(async () => {
    if (!s) return;
    if (!window.confirm(
      `Delete ${s.code || s.id}?\n\n`
      + `This will also delete every Google Calendar event tied to this `
      + `subject. Downloaded files on disk are left alone.`
    )) return;
    const res = await fetch(`/api/subjects/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(`Delete failed: ${body.error || `HTTP ${res.status}`}`);
      return;
    }
    // The cascade endpoint returns a 200 with a summary of what it cleaned
    // up. Surface that so users see why a sync took a few seconds.
    const body = await res.json().catch(() => null);
    if (body && body.googleEventsDeleted > 0) {
      console.log(
        `deleted subject ${body.subjectId}: ${body.googleEventsDeleted} Google event(s) removed, `
        + `${body.localItemsDeleted} local row(s) cleaned`,
      );
    }
    await window.bootData();
    window.location.hash = '#/subjects';
  }, [s]);

  if (!s) return (
    <div>
      <SubNav title="Subject not found" crumbs={[{ label: 'Subjects', href: '#/subjects' }, { label: id }]} />
      <div className="subject-detail">Subject not found.</div>
    </div>
  );
  const allItems = window.EVENTS
    .filter((e) => e.subjectId === s.id)
    .sort((a, b) => a.start - b.start);
  const upcoming = allItems.filter((e) => e.start >= Util.startOfWeek(now));
  const files = window.SUBJECT_FILES[s.id] || [];

  return (
    <div data-screen-label={`Subject  -  ${s.code || s.id}`}>
      <SubNav
        title={s.code || s.id}
        crumbs={[{ label: 'Subjects', href: '#/subjects' }, { label: s.code || s.id }]}
        right={(
          <>
            <button className="btn-ghost-pill" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn-ghost-pill danger" onClick={handleDelete}>Delete</button>
          </>
        )}
      />
      <div className="subject-detail">
        <div className="sd-head">
          <div>
            <div className="code-tag"><span className="swatch" style={{ background: s.color }}></span>{s.code || s.id}{s.section ? ` ${s.section}` : ''}{s.term ? `  -  ${s.term}` : ''}</div>
            <h1>{s.name}</h1>
            <div className="prof">{s.professor}</div>
            {s.room && (
              <div style={{ marginTop: 12, fontSize: 14 }}>
                <a href={window.roomFinderUrl(s.room)} target="_blank" rel="noopener noreferrer"
                   title="Open in SFU Room Finder">
                  {s.room} {'↗'}
                </a>
              </div>
            )}
          </div>
        </div>

        <div className="sd-grid sd-grid-3">
          <div className="sd-col-announcements">
            <div className="sd-section" style={{ marginTop: 0 }}>
              <h2 style={{ fontSize: 21 }}>Announcements</h2>
              <div className="sec-sub">Latest posts from Canvas and CourSys for this subject.</div>
              <AnnouncementsBlock subjectId={s.id} />
            </div>
          </div>

          <div>
            <div className="sd-section" style={{ marginTop: 0 }}>
              <h2>Upcoming</h2>
              <div className="sec-sub">Lectures, tutorials, and deadlines extracted from this subject's sources.</div>
              <div className="assignment-list">
                {upcoming.length === 0 && <div style={{ padding: '14px 18px', color: 'var(--ink-muted-48)', fontSize: 14 }}>No upcoming items.</div>}
                {upcoming.slice(0, 12).map((e) => {
                  const isInstant = e.start.getTime() === e.end.getTime();
                  return (
                    <div key={e.itemId + e.start.toISOString()} className="assignment-row">
                      <div className="when">
                        <span className="day">{e.start.toLocaleDateString('en-US', { weekday: 'short', month: 'short' })}</span>
                        {e.start.getDate()}  -  {Util.fmtTimeShort(e.start)}
                      </div>
                      <div>
                        <div className="title">{e.summary.replace(/^(Lecture|Tutorial|Office hours)  -  /, '')}</div>
                        <div className="sub">{isInstant ? `Due${e.room ? `  -  ${e.room}` : ''}` : `${Util.fmtTime(e.start)} - ${Util.fmtTime(e.end)}${e.room ? `  -  ${e.room}` : ''}`}</div>
                      </div>
                      <div className={"kind " + e.kind}>{Util.kindLabel(e.kind)}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="sd-section">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <h2 style={{ flex: 1 }}>Files</h2>
                <button
                  type="button"
                  className="btn-ghost-pill"
                  onClick={syncFiles}
                  disabled={syncingFiles}
                  title="Pull this course's files from Canvas"
                >
                  {syncingFiles ? 'Syncing...' : 'Sync files'}
                </button>
              </div>
              <div className="sec-sub">Mirrored from Canvas into cloud storage  -  one section per module / page, click a section to expand.</div>
              <FilesBlock files={files} onView={setViewingFile} />
            </div>
          </div>

          <div>
            <div className="sd-section" style={{ marginTop: 0 }}>
              <h2 style={{ fontSize: 21 }}>Due</h2>
              <div className="sec-sub">Assignments, midterms, and exams  -  everything with a deadline, soonest first.</div>
              <DueBlock subjectId={s.id} now={now} />
            </div>

            <div className="sd-section">
              <h2 style={{ fontSize: 21 }}>Exams</h2>
              <div className="sec-sub">Midterms and finals for this subject.</div>
              <ExamsBlock subjectId={s.id} now={now} />
            </div>
          </div>
        </div>
      </div>

      {editing && (
        <SubjectForm
          mode="edit"
          initial={s}
          onCancel={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      )}

      {viewingFile && (
        <FileViewer file={viewingFile} onClose={() => setViewingFile(null)} />
      )}
    </div>
  );
}

Object.assign(window, { SubjectsPage, SubjectDetail });
