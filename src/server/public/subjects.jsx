/* global React, Util */
const { useState, useCallback, useMemo } = React;

const COLOR_OPTIONS = ['#0066cc', '#1f8a5b', '#c97a17', '#7d4cdb', '#0f8a8a', '#d04a5b'];

function statusPills() {
  const s = window.SYNC_STATUS;
  const googleLabel = s.googleAuthOk ? 'Google OK' : 'Google re-auth needed';
  let coursysLabel;
  if (!s.coursysAuthOk) coursysLabel = 'CourSys expired';
  else if (s.coursysExpiresInDays != null) coursysLabel = `CourSys  -  expires in ${s.coursysExpiresInDays}d`;
  else coursysLabel = 'CourSys OK';
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <div className="sync-pill">
        <span className={"dot" + (s.googleAuthOk ? '' : ' warn')}></span>
        {googleLabel}
      </div>
      <div className="sync-pill">
        <span className={"dot" + (
          s.coursysAuthOk && (s.coursysExpiresInDays == null || s.coursysExpiresInDays > 2)
            ? '' : ' warn'
        )}></span>
        {coursysLabel}
      </div>
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
    term: '',
    color: COLOR_OPTIONS[0],
    destinationFolder: '',
    sources: [{ type: 'email', label: '' }],
  };
}

function normalizeSubjectForApi(s) {
  const cleanSources = s.sources
    .map((src) => {
      if (src.type === 'email') return { type: 'email', label: (src.label || '').trim() };
      return { type: 'site', url: (src.url || '').trim() };
    })
    .filter((src) => (src.type === 'email' ? src.label : src.url));

  const out = {
    id: s.id.trim(),
    name: s.name.trim(),
    professor: (s.professor || '').trim(),
    destinationFolder: s.destinationFolder.trim(),
    sources: cleanSources,
  };
  if (s.code && s.code.trim()) out.code = s.code.trim();
  if (s.room && s.room.trim()) out.room = s.room.trim();
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
  const updateSource = (i, patch) => setForm((f) => {
    const next = [...f.sources];
    next[i] = { ...next[i], ...patch };
    return { ...f, sources: next };
  });
  const addSource = (type) => setForm((f) => ({
    ...f,
    sources: [...f.sources, type === 'email' ? { type: 'email', label: '' } : { type: 'site', url: '' }],
  }));
  const removeSource = (i) => setForm((f) => ({
    ...f,
    sources: f.sources.filter((_, j) => j !== i),
  }));

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
            <label className="span-2">
              <span>Destination folder</span>
              <input
                type="text"
                value={form.destinationFolder}
                onChange={(e) => update({ destinationFolder: e.target.value })}
                required
                placeholder="D:/Desktop/University/Summer 2026/CMPT 307"
                style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}
              />
            </label>
          </div>

          <fieldset className="sources-fieldset">
            <legend>Sources</legend>
            {form.sources.map((src, i) => (
              <div key={i} className="source-edit">
                <select
                  value={src.type}
                  onChange={(e) => {
                    const t = e.target.value;
                    updateSource(i, t === 'email' ? { type: 'email', label: '' } : { type: 'site', url: '' });
                  }}>
                  <option value="email">email</option>
                  <option value="site">site</option>
                </select>
                {src.type === 'email' ? (
                  <input
                    type="text"
                    placeholder="Gmail label"
                    value={src.label || ''}
                    onChange={(e) => updateSource(i, { label: e.target.value })}
                  />
                ) : (
                  <input
                    type="url"
                    placeholder="https://coursys.sfu.ca/.../pages/"
                    value={src.url || ''}
                    onChange={(e) => updateSource(i, { url: e.target.value })}
                  />
                )}
                <button type="button" className="btn-icon" onClick={() => removeSource(i)} aria-label="Remove source">-</button>
              </div>
            ))}
            <div className="source-add">
              <button type="button" className="btn-ghost-pill" onClick={() => addSource('email')}>+ Email source</button>
              <button type="button" className="btn-ghost-pill" onClick={() => addSource('site')}>+ Site source</button>
            </div>
          </fieldset>

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
              {visibleSubjects.length} subjects  -  stored in{' '}
              <code style={{ background: 'var(--parchment)', padding: '2px 6px', borderRadius: 4, fontSize: 14 }}>data/subjects.json</code>
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
                <div className="prof">{s.professor}{s.room ? `  -  ${s.room}` : ''}</div>
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
                  <div className="stat"><div className="n">{s.sources.length}</div><div className="l">Sources</div></div>
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
            <div style={{ fontSize: 12, color: 'var(--ink-muted-48)', marginTop: 4 }}>Writes to data/subjects.json</div>
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

function PipelineBlock() {
  const s = window.SYNC_STATUS;
  const lastLabel = s.lastRunISO
    ? new Date(s.lastRunISO).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: false })
    : ' - ';
  const nextLabel = s.nextRunISO
    ? new Date(s.nextRunISO).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: false })
    : ' - ';
  const errColor = s.agentErrorsLastWeek === 0 ? '#1f8a5b' : '#c97a17';
  return (
    <div className="sources-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0' }}>
        <span style={{ color: 'var(--ink-muted-48)' }}>Last sync</span>
        <span>{lastLabel}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0', borderTop: '1px solid var(--divider-soft)' }}>
        <span style={{ color: 'var(--ink-muted-48)' }}>Items added (last run  -  7d)</span>
        <span>{s.itemsAddedLastRun}  -  {s.itemsAddedLastWeek}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0', borderTop: '1px solid var(--divider-soft)' }}>
        <span style={{ color: 'var(--ink-muted-48)' }}>Agent errors (7d)</span>
        <span style={{ color: errColor }}>{s.agentErrorsLastWeek === 0 ? 'None' : s.agentErrorsLastWeek}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0', borderTop: '1px solid var(--divider-soft)' }}>
        <span style={{ color: 'var(--ink-muted-48)' }}>Next run</span>
        <span>{nextLabel}</span>
      </div>
    </div>
  );
}

function SubjectDetail({ id, now }) {
  const [editing, setEditing] = useState(false);
  const s = Util.subjectById(id);

  const handleDelete = useCallback(async () => {
    if (!s) return;
    if (!window.confirm(`Delete ${s.code || s.id}? Pipeline state and downloaded files stay on disk, but the subject won't be synced anymore.`)) return;
    const res = await fetch(`/api/subjects/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(`Delete failed: ${body.error || `HTTP ${res.status}`}`);
      return;
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
  const status = window.SYNC_STATUS;
  const lastSync = status.lastRunISO
    ? new Date(status.lastRunISO).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: false })
    : 'never';

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
            <div className="code-tag"><span className="swatch" style={{ background: s.color }}></span>{s.code || s.id}{s.term ? `  -  ${s.term}` : ''}</div>
            <h1>{s.name}</h1>
            <div className="prof">{s.professor}</div>
            <div style={{ marginTop: 12, display: 'flex', gap: 18, color: 'var(--ink-muted-80)', fontSize: 14, flexWrap: 'wrap' }}>
              {s.room && <span> {s.room}</span>}
              <span> <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>{s.destinationFolder}</span></span>
            </div>
          </div>
          <div className="right">
            <div className="sync-pill"><span className="dot"></span>Synced {lastSync}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted-48)' }}>{allItems.length} items synced this term</div>
          </div>
        </div>

        <div className="sd-grid">
          <div>
            <div className="sd-section">
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
              <h2>Files</h2>
              <div className="sec-sub">Synced to <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}>{s.destinationFolder}</span>  -  de-duplicated by SHA-256.</div>
              <div className="files-list">
                {files.length === 0 && <div style={{ padding: '14px 18px', color: 'var(--ink-muted-48)', fontSize: 14 }}>No files downloaded yet.</div>}
                {files.map((f) => (
                  <div key={f.filename} className="file-row">
                    <span className="file-icon">{(f.filename.split('.').pop() || 'FILE').toUpperCase().slice(0, 4)}</span>
                    <div className="name">
                      {f.filename}
                      <div className="meta">Added {f.addedISO ? new Date(f.addedISO).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ' - '}</div>
                    </div>
                    <div className="size">{f.size}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div>
            <div className="sd-section" style={{ marginTop: 0 }}>
              <h2 style={{ fontSize: 21 }}>Sources</h2>
              <div className="sources-card">
                {s.sources.map((src, i) => (
                  <div key={i} className="source-row">
                    <div className={"badge " + src.type}>{src.type}</div>
                    <div className={"value " + (src.type === 'site' ? 'mono' : '')}>
                      {src.type === 'email' ? `Label: ${src.label}` : src.url}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="sd-section">
              <h2 style={{ fontSize: 21 }}>Pipeline</h2>
              <PipelineBlock />
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
    </div>
  );
}

Object.assign(window, { SubjectsPage, SubjectDetail });
