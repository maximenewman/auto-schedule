/* global React, Util */
const { useMemo } = React;

function statusPills() {
  const s = window.SYNC_STATUS;
  const googleLabel = s.googleAuthOk ? 'Google OK' : 'Google re-auth needed';
  let coursysLabel;
  if (!s.coursysAuthOk) coursysLabel = 'CourSys expired';
  else if (s.coursysExpiresInDays != null) coursysLabel = `CourSys · expires in ${s.coursysExpiresInDays}d`;
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

function SubjectsPage({ now }) {
  return (
    <div data-screen-label="Subjects">
      <SubNav
        title="Subjects"
        right={(
          <>
            <button
              className="btn-ghost-pill"
              onClick={() => alert('Add a Subject entry to src/config/subjects.ts and restart the server.')}>
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
              {window.SUBJECTS.length} subjects · auto-synced from{' '}
              <code style={{ background: 'var(--parchment)', padding: '2px 6px', borderRadius: 4, fontSize: 14 }}>src/config/subjects.ts</code>
            </div>
          </div>
          {statusPills()}
        </div>

        <div className="subjects-grid">
          {window.SUBJECTS.map((s) => {
            const next = window.EVENTS
              .filter((e) => e.subjectId === s.id && e.start > now)
              .sort((a, b) => a.start - b.start)[0];
            const upcomingDeadlines = window.EVENTS
              .filter((e) => e.subjectId === s.id && (e.kind === 'assignment' || e.kind === 'midterm' || e.kind === 'exam') && e.start > now).length;
            const files = (window.SUBJECT_FILES[s.id] || []).length;
            return (
              <a key={s.id} href={`#/subjects/${s.id}`} className="subject-card">
                <div className="accent" style={{ background: s.color }}></div>
                <div className="code">{s.code}</div>
                <div className="name">{s.name}</div>
                <div className="prof">{s.professor}{s.room ? ` · ${s.room}` : ''}</div>
                {next ? (
                  <div style={{ marginTop: 14, fontSize: 13, color: 'var(--ink-muted-80)' }}>
                    <span style={{ color: 'var(--ink-muted-48)' }}>Next · </span>
                    {next.summary.replace(/^(Lecture|Tutorial|Office hours) · /, '')}
                    <div style={{ fontSize: 12, color: 'var(--ink-muted-48)', marginTop: 2 }}>
                      {Util.relTime(next.start, now)} · {Util.fmtTime(next.start)}
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
          <a
            href="#/subjects"
            className="subject-card"
            onClick={(e) => { e.preventDefault(); alert('Add a Subject entry to src/config/subjects.ts and restart the server.'); }}
            style={{ border: '1px dashed var(--hairline)', alignItems: 'center', justifyContent: 'center', textAlign: 'center', minHeight: 220 }}>
            <div style={{ fontSize: 32, color: 'var(--ink-muted-32)', marginBottom: 4 }}>+</div>
            <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--ink-muted-80)' }}>Add subject</div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted-48)', marginTop: 4 }}>Edits src/config/subjects.ts</div>
          </a>
        </div>
      </div>
    </div>
  );
}

function PipelineBlock() {
  const s = window.SYNC_STATUS;
  const lastLabel = s.lastRunISO
    ? new Date(s.lastRunISO).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: false })
    : '—';
  const nextLabel = s.nextRunISO
    ? new Date(s.nextRunISO).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: false })
    : '—';
  const errColor = s.agentErrorsLastWeek === 0 ? '#1f8a5b' : '#c97a17';
  return (
    <div className="sources-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0' }}>
        <span style={{ color: 'var(--ink-muted-48)' }}>Last sync</span>
        <span>{lastLabel}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0', borderTop: '1px solid var(--divider-soft)' }}>
        <span style={{ color: 'var(--ink-muted-48)' }}>Items added (last run · 7d)</span>
        <span>{s.itemsAddedLastRun} · {s.itemsAddedLastWeek}</span>
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
  const s = Util.subjectById(id);
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
    <div data-screen-label={`Subject · ${s.code}`}>
      <SubNav
        title={s.code}
        crumbs={[{ label: 'Subjects', href: '#/subjects' }, { label: s.code }]}
      />
      <div className="subject-detail">
        <div className="sd-head">
          <div>
            <div className="code-tag"><span className="swatch" style={{ background: s.color }}></span>{s.code}{s.term ? ` · ${s.term}` : ''}</div>
            <h1>{s.name}</h1>
            <div className="prof">{s.professor}</div>
            <div style={{ marginTop: 12, display: 'flex', gap: 18, color: 'var(--ink-muted-80)', fontSize: 14, flexWrap: 'wrap' }}>
              {s.room && <span>📍 {s.room}</span>}
              <span>📁 <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>{s.destinationFolder}</span></span>
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
                        {e.start.getDate()} · {Util.fmtTimeShort(e.start)}
                      </div>
                      <div>
                        <div className="title">{e.summary.replace(/^(Lecture|Tutorial|Office hours) · /, '')}</div>
                        <div className="sub">{isInstant ? `Due${e.room ? ` · ${e.room}` : ''}` : `${Util.fmtTime(e.start)} – ${Util.fmtTime(e.end)}${e.room ? ` · ${e.room}` : ''}`}</div>
                      </div>
                      <div className={"kind " + e.kind}>{Util.kindLabel(e.kind)}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="sd-section">
              <h2>Files</h2>
              <div className="sec-sub">Synced to <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}>{s.destinationFolder}</span> · de-duplicated by SHA-256.</div>
              <div className="files-list">
                {files.length === 0 && <div style={{ padding: '14px 18px', color: 'var(--ink-muted-48)', fontSize: 14 }}>No files downloaded yet.</div>}
                {files.map((f) => (
                  <div key={f.filename} className="file-row">
                    <span className="file-icon">{(f.filename.split('.').pop() || 'FILE').toUpperCase().slice(0, 4)}</span>
                    <div className="name">
                      {f.filename}
                      <div className="meta">Added {f.addedISO ? new Date(f.addedISO).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</div>
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

            <div className="sd-section">
              <h2 style={{ fontSize: 21 }}>Config</h2>
              <pre style={{ background: 'var(--ink)', color: '#fff', borderRadius: 'var(--r-lg)', padding: '18px 20px',
                fontSize: 12, lineHeight: 1.6, overflowX: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
{`{
  id: '${s.id}',
  code: '${s.code}',
  name: '${s.name}',
  professor: '${s.professor}',
  destinationFolder:
    '${s.destinationFolder}',
  sources: [${s.sources.map((src) => src.type === 'email'
    ? `\n    { type: 'email', label: '${src.label}' }`
    : `\n    { type: 'site', url: '${src.url}' }`).join(',')}
  ],
}`}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { SubjectsPage, SubjectDetail });
