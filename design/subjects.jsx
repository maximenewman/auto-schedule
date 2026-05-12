/* global React, Util */
const { useMemo } = React;

function SubjectsPage({ now }) {
  return (
    <div data-screen-label="Subjects">
      <SubNav
        title="Subjects"
        right={(
          <>
            <button className="btn-ghost-pill">Import from CourSys</button>
            <button className="btn-primary">Add subject</button>
          </>
        )}
      />
      <div className="subjects-page">
        <div className="hero">
          <div>
            <h1>Your classes</h1>
            <div className="sub">{window.SUBJECTS.length} subjects · Summer 2026 · auto-synced from <code style={{ background: 'var(--parchment)', padding: '2px 6px', borderRadius: 4, fontSize: 14 }}>src/config/subjects.ts</code></div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="sync-pill"><span className="dot"></span>Google OK</div>
            <div className="sync-pill"><span className="dot warn"></span>CourSys · expires in 4d</div>
          </div>
        </div>

        <div className="subjects-grid">
          {window.SUBJECTS.map((s) => {
            const next = window.EVENTS
              .filter((e) => e.subjectId === s.id && e.start > now)
              .sort((a, b) => a.start - b.start)[0];
            const upcomingDeadlines = window.EVENTS
              .filter((e) => e.subjectId === s.id && (e.kind === 'assignment' || e.kind === 'midterm') && e.start > now).length;
            const files = (window.SUBJECT_FILES[s.id] || []).length;
            return (
              <a key={s.id} href={`#/subjects/${s.id}`} className="subject-card">
                <div className="accent" style={{ background: s.color }}></div>
                <div className="code">{s.code}</div>
                <div className="name">{s.name}</div>
                <div className="prof">{s.professor} · {s.room}</div>
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
          <a href="#/subjects" className="subject-card" style={{ border: '1px dashed var(--hairline)', alignItems: 'center', justifyContent: 'center', textAlign: 'center', minHeight: 220 }}>
            <div style={{ fontSize: 32, color: 'var(--ink-muted-32)', marginBottom: 4 }}>+</div>
            <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--ink-muted-80)' }}>Add subject</div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted-48)', marginTop: 4 }}>Adds an entry to subjects.ts</div>
          </a>
        </div>
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

  return (
    <div data-screen-label={`Subject · ${s.code}`}>
      <SubNav
        title={s.code}
        crumbs={[{ label: 'Subjects', href: '#/subjects' }, { label: s.code }]}
        right={(
          <>
            <button className="btn-ghost-pill">Edit</button>
            <button className="btn-primary">Open in calendar</button>
          </>
        )}
      />
      <div className="subject-detail">
        <div className="sd-head">
          <div>
            <div className="code-tag"><span className="swatch" style={{ background: s.color }}></span>{s.code} · {s.term}</div>
            <h1>{s.name}</h1>
            <div className="prof">{s.professor}</div>
            <div style={{ marginTop: 12, display: 'flex', gap: 18, color: 'var(--ink-muted-80)', fontSize: 14 }}>
              <span>📍 {s.room}</span>
              <span>📁 <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>{s.destinationFolder}</span></span>
            </div>
          </div>
          <div className="right">
            <div className="sync-pill"><span className="dot"></span>Synced 08:00 today</div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted-48)' }}>{allItems.length} items synced this term</div>
          </div>
        </div>

        <div className="sd-grid">
          <div>
            <div className="sd-section">
              <h2>Upcoming</h2>
              <div className="sec-sub">Lectures, tutorials, and deadlines extracted from this subject's sources.</div>
              <div className="assignment-list">
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
                        <div className="sub">{isInstant ? `Due · ${e.room}` : `${Util.fmtTime(e.start)} – ${Util.fmtTime(e.end)} · ${e.room}`}</div>
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
                {files.map((f) => (
                  <div key={f.filename} className="file-row">
                    <span className="file-icon">PDF</span>
                    <div className="name">
                      {f.filename}
                      <div className="meta">Added {new Date(f.addedISO).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
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
              <div className="sources-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0' }}>
                  <span style={{ color: 'var(--ink-muted-48)' }}>Last sync</span>
                  <span>Today, 08:00</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0', borderTop: '1px solid var(--divider-soft)' }}>
                  <span style={{ color: 'var(--ink-muted-48)' }}>Items added</span>
                  <span>1 today · 6 this week</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0', borderTop: '1px solid var(--divider-soft)' }}>
                  <span style={{ color: 'var(--ink-muted-48)' }}>Agent errors</span>
                  <span style={{ color: '#1f8a5b' }}>None</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0', borderTop: '1px solid var(--divider-soft)' }}>
                  <span style={{ color: 'var(--ink-muted-48)' }}>Next run</span>
                  <span>Tonight, 20:00</span>
                </div>
              </div>
            </div>

            <div className="sd-section">
              <h2 style={{ fontSize: 21 }}>Config</h2>
              <pre style={{ background: 'var(--ink)', color: '#fff', borderRadius: 'var(--r-lg)', padding: '18px 20px',
                fontSize: 12, lineHeight: 1.6, overflowX: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
{`{
  id: '${s.id}',
  name: '${s.code}',
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
