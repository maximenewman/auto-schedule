/* global React, Util */
const { useState, useEffect, useMemo, useCallback } = React;

const HOUR_START = 8;
const HOUR_END = 22;
const HOUR_PX = 44;

function WeekGrid({ weekStart, now, onEventClick }) {
  const days = Array.from({ length: 7 }, (_, i) => Util.addDays(weekStart, i));
  const events = Util.eventsForWeek(weekStart);
  const hours = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => i + HOUR_START);

  return (
    <div className="week-grid">
      <div className="day-head spacer"></div>
      {days.map((d, i) => {
        const isToday = Util.sameDay(d, now);
        return (
          <div key={i} className={"day-head" + (isToday ? " today" : "")}>
            <div className="dow">{d.toLocaleDateString('en-US', { weekday: 'short' })}</div>
            <div className="dom">{d.getDate()}</div>
          </div>
        );
      })}

      {/* Hour gutter */}
      <div className="hour-col">
        {hours.map((h) => (
          <div key={h} className="hour-cell">
            <span className="hour-label">{Util.fmtTimeShort(new Date(2026, 0, 1, h, 0))}</span>
          </div>
        ))}
      </div>

      {days.map((d, i) => {
        const isToday = Util.sameDay(d, now);
        const dayEvents = events.filter((e) => Util.sameDay(e.start, d));
        return (
          <div key={i} className={"day-col" + (isToday ? " today" : "")}
            style={{ height: (HOUR_END - HOUR_START) * HOUR_PX }}>
            {hours.map((h) => (
              <div key={h} className="hour-cell" style={{ borderRight: 0 }}></div>
            ))}
            {isToday && Util.hoursDecimal(now) >= HOUR_START && Util.hoursDecimal(now) <= HOUR_END && (
              <div className="now-line" style={{ top: (Util.hoursDecimal(now) - HOUR_START) * HOUR_PX }}></div>
            )}
            {dayEvents.map((e) => {
              const subj = Util.subjectById(e.subjectId);
              if (!subj) return null;
              const isInstant = e.start.getTime() === e.end.getTime();
              const startH = Util.hoursDecimal(e.start);
              const endH = isInstant ? startH + 0.6 : Util.hoursDecimal(e.end);
              if (endH < HOUR_START || startH > HOUR_END) return null;
              const top = (Math.max(startH, HOUR_START) - HOUR_START) * HOUR_PX;
              const height = (Math.min(endH, HOUR_END) - Math.max(startH, HOUR_START)) * HOUR_PX - 2;
              return (
                <div key={e.itemId + e.start.toISOString()}
                  className={"event kind-" + e.kind}
                  style={{ top, height, borderLeftColor: subj.color }}
                  onClick={() => onEventClick && onEventClick(e)}
                  title={`${subj.code} · ${e.summary} · ${Util.fmtTime(e.start)}`}>
                  <div className="ev-time">{isInstant ? `Due ${Util.fmtTime(e.start)}` : `${Util.fmtTime(e.start)}`}</div>
                  <div className="ev-title">{subj.code} · {e.summary.replace(/^(Lecture|Tutorial|Office hours) · /, '')}</div>
                  {e.room && height > 50 && <div className="ev-room">{e.room}</div>}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function NowHero({ now }) {
  const { happening, next } = Util.classifyNow(now);
  if (happening) {
    const subj = Util.subjectById(happening.subjectId);
    if (!subj) return null;
    const totalMin = Util.minutesBetween(happening.start, happening.end);
    const elapsed = Util.minutesBetween(happening.start, now);
    const pct = Math.max(0, Math.min(100, (elapsed / totalMin) * 100));
    const remaining = Math.max(0, Math.round(totalMin - elapsed));
    return (
      <div className="now-hero">
        <div className="now-badge"><span className="pulse" style={{ background: subj.color }}></span>Now</div>
        <h2>{subj.code} · {happening.summary.replace(/^(Lecture|Tutorial|Office hours) · /, '')}</h2>
        <div className="meta">{Util.fmtTime(happening.start)} – {Util.fmtTime(happening.end)} · {happening.room}</div>
        <div className="progress"><div style={{ width: pct + '%', background: subj.color }}></div></div>
        <div className="meta" style={{ marginTop: 8, fontSize: 12 }}>
          {remaining} min remaining · {Util.kindLabel(happening.kind)}
        </div>
      </div>
    );
  }
  if (next) {
    const subj = Util.subjectById(next.subjectId);
    if (!subj) return null;
    return (
      <div className="next-card">
        <div className="label">Up next</div>
        <div className="title">{subj.code} · {next.summary.replace(/^(Lecture|Tutorial|Office hours) · /, '')}</div>
        <div className="meta">{Util.fmtTime(next.start)} – {Util.fmtTime(next.end)} · {next.room}</div>
        <div className="in">{Util.relTime(next.start, now)}</div>
      </div>
    );
  }
  return (
    <div className="next-card">
      <div className="label">All clear</div>
      <div className="title">No more events today</div>
      <div className="meta">Enjoy the rest of your day.</div>
    </div>
  );
}

function TodayList({ now }) {
  const today = Util.eventsForDay(now);
  return (
    <div className="today-list">
      <h3>Today · {Util.fmtDayLong(now)}</h3>
      {today.length === 0 && <div style={{ padding: '12px 22px', color: 'var(--ink-muted-48)', fontSize: 14 }}>Nothing scheduled.</div>}
      {today.map((e) => {
        const subj = Util.subjectById(e.subjectId);
        if (!subj) return null;
        const isInstant = e.start.getTime() === e.end.getTime();
        const past = e.end < now;
        const cur = !isInstant && e.start <= now && e.end > now;
        return (
          <div key={e.subjectId + '-' + e.itemId} className={"today-row" + (past ? " past" : "") + (cur ? " now" : "")}>
            <div className="time">{Util.fmtTime(e.start)}</div>
            <div className="bar" style={{ background: subj.color }}></div>
            <div className="title">
              {subj.code} · {e.summary.replace(/^(Lecture|Tutorial|Office hours) · /, '')}
              <span className="sub">{isInstant ? `Due · ${Util.kindLabel(e.kind)}` : `${Util.kindLabel(e.kind)} · ${e.room}`}</span>
            </div>
            <div className="right">{isInstant ? '' : Util.fmtTime(e.end)}</div>
          </div>
        );
      })}
    </div>
  );
}

function TodayTimeline({ now }) {
  const today = Util.eventsForDay(now);
  return (
    <div className="today-tl">
      <h3>Today · {Util.fmtDayLong(now)}</h3>
      <div className="tl-rail">
        {today.length === 0 && <div style={{ color: 'var(--ink-muted-48)', fontSize: 14 }}>Nothing scheduled.</div>}
        {today.map((e) => {
          const subj = Util.subjectById(e.subjectId);
          if (!subj) return null;
          const past = e.end < now;
          const isInstant = e.start.getTime() === e.end.getTime();
          const cur = !isInstant && e.start <= now && e.end > now;
          return (
            <div key={e.subjectId + '-' + e.itemId} className={"tl-item" + (past ? " past" : "") + (cur ? " now" : "")}>
              <div className="tl-time">{Util.fmtTimeShort(e.start)}</div>
              <div className="tl-dot" style={{ borderColor: cur ? subj.color : (past ? undefined : subj.color), background: cur ? subj.color : undefined }}></div>
              <div className="tl-title">{subj.code} · {e.summary.replace(/^(Lecture|Tutorial|Office hours) · /, '')}</div>
              <div className="tl-sub">{Util.kindLabel(e.kind)} · {e.room}{isInstant ? '' : ` · until ${Util.fmtTimeShort(e.end)}`}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Deadlines({ now }) {
  const items = Util.upcomingDeadlines(now, 5);
  return (
    <div className="deadlines">
      <h3>Upcoming deadlines</h3>
      {items.length === 0 && <div style={{ color: 'var(--ink-muted-48)', fontSize: 14 }}>No upcoming deadlines.</div>}
      {items.map((e) => {
        const subj = Util.subjectById(e.subjectId);
        if (!subj) return null;
        const mins = Util.minutesBetween(now, e.start);
        const urgent = mins < 48 * 60;
        const when = e.start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        return (
          <a key={e.subjectId + '-' + e.itemId} href={`#/subjects/${subj.id}`} className="deadline-row" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div>
              <div className="dr-title">{subj.code} · {e.summary}</div>
              <div className="dr-sub">{Util.kindLabel(e.kind)} · {when}</div>
            </div>
            <div className={"dr-when" + (urgent ? " urgent" : "")}>{Util.relTime(e.start, now)}</div>
          </a>
        );
      })}
    </div>
  );
}

function SyncPill() {
  const s = window.SYNC_STATUS;
  if (s.running) {
    return (
      <div className="sync-pill">
        <span className="dot" style={{ background: '#0066cc' }}></span>
        Syncing…
      </div>
    );
  }
  if (!s.lastRunISO) {
    return (
      <div className="sync-pill">
        <span className="dot" style={{ background: '#a8a8ad' }}></span>
        No sync yet
      </div>
    );
  }
  const t = new Date(s.lastRunISO).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: false,
  });
  return (
    <div className="sync-pill">
      <span className="dot"></span>
      Synced {t} · {s.itemsAddedLastRun} added
    </div>
  );
}

function IcalSubscriptionButton() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const close = () => { setOpen(false); setError(null); setResult(null); };

  const openModal = async () => {
    setOpen(true);
    if (!loaded) {
      try {
        const res = await fetch('/api/settings/ical-url');
        const body = await res.json();
        setUrl(body.url ?? '');
      } catch (err) {
        setError(err.message || String(err));
      } finally {
        setLoaded(true);
      }
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/ical-url', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setUrl(body.url ?? '');
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/import/ical', { method: 'POST' });
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

  const modal = open ? (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal import-result" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>CourSys iCal subscription</h2>
          <button type="button" className="close" onClick={close} aria-label="Close">✕</button>
        </header>
        <div className="body">
          <p style={{ fontSize: 13, color: 'var(--ink-muted-80)', margin: '4px 0 12px' }}>
            Paste the global iCal URL from CourSys. It's used as the default ingestion source on every pipeline run — events are attributed to subjects by their <code>CATEGORIES</code> field, and unrecognised course codes auto-create subjects.
          </p>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--ink-muted-48)', marginBottom: 4 }}>iCal URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://coursys.sfu.ca/calendar/.../calendar.ics"
            style={{ width: '100%', padding: '8px 10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}
          />
          {result && (
            <div className="summary" style={{ marginTop: 14 }}>
              Fetched {result.fetched} VEVENTs · attributed {result.attributed} · auto-created {result.subjectsCreated} subjects<br />
              Events inserted: {result.eventsInserted} · updated: {result.eventsUpdated} · unchanged: {result.eventsUnchanged}
              {result.failures > 0 ? ` · failures: ${result.failures}` : ''}
            </div>
          )}
          {error && <div className="form-error" style={{ marginTop: 12 }}>{error}</div>}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn-ghost-pill" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save URL'}</button>
          <button type="button" className="btn-primary" onClick={syncNow} disabled={busy || !url.trim()}>{busy ? 'Syncing…' : 'Sync now'}</button>
        </footer>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button type="button" className="btn-ghost-pill" onClick={openModal}>iCal subscription</button>
      {modal && ReactDOM.createPortal(modal, document.body)}
    </>
  );
}

function ImportSfuButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = React.useRef(null);

  const close = () => { setResult(null); setError(null); };

  const handleFile = async (file) => {
    close();
    const baseFolder = window.prompt(
      'Base folder for class file downloads (subjects will be created as <base>/<COURSE CODE>):',
      window.localStorage.getItem('sfuImportBaseFolder') || 'downloads',
    );
    if (baseFolder == null) return;
    window.localStorage.setItem('sfuImportBaseFolder', baseFolder);

    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('pdf', file, file.name);
      fd.append('baseFolder', baseFolder);
      const res = await fetch('/api/import/sfu', { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setResult(body);
      await window.bootData();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const modal = (result || error) ? (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal import-result" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{error ? 'Import failed' : 'Schedule imported'}</h2>
          <button type="button" className="close" onClick={close} aria-label="Close">✕</button>
        </header>
        <div className="body">
          {error ? (
            <div className="form-error">{error}</div>
          ) : (
            <>
              <div className="term-line">
                Term: <strong>{result.term.label}</strong> · {result.term.startDate} → {result.term.endDate}
              </div>
              <ul className="course-list">
                {result.courses.map((c) => (
                  <li key={c.code}>
                    <strong>{c.code}</strong> — {c.title}
                    <div className="sub">
                      {c.sections} section{c.sections === 1 ? '' : 's'} · {c.meetings} meeting{c.meetings === 1 ? '' : 's'}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="summary">
                Subjects created: {result.result.subjectsCreated} · merged: {result.result.subjectsMerged}<br />
                Events inserted: {result.result.eventsInserted} · updated: {result.result.eventsUpdated} · unchanged: {result.result.eventsUnchanged}
                {result.result.failures > 0 ? ` · failures: ${result.result.failures}` : ''}
              </div>
            </>
          )}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn-primary" onClick={close}>Done</button>
        </footer>
      </div>
    </div>
  ) : null;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files && e.target.files[0];
          if (f) handleFile(f);
        }}
      />
      <button
        type="button"
        className="btn-ghost-pill"
        onClick={() => inputRef.current && inputRef.current.click()}
        disabled={busy}
      >
        {busy ? 'Importing…' : 'Import SFU schedule'}
      </button>
      {/* Portal to body so the fixed-position backdrop isn't constrained by
          the sticky SubNav it lives in, which would push it down on scroll. */}
      {modal && ReactDOM.createPortal(modal, document.body)}
    </>
  );
}

function SchedulePage({ now, tweaks, onSyncDone }) {
  const [weekStart, setWeekStart] = useState(() => Util.startOfWeek(now));
  const [syncing, setSyncing] = useState(false);
  const weekEnd = Util.addDays(weekStart, 6);

  const heroVariant = tweaks.hero || 'hero';

  const handleSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await window.api.sync();
      if (!res.started) {
        console.warn('sync rejected', res);
        return;
      }
      // Poll status until the run finishes. The 30s status poller in app.jsx
      // will pick the new data up too, but a tighter poll here gives the user
      // immediate feedback on a manually-triggered run.
      const targetRunId = res.runId;
      const start = Date.now();
      while (Date.now() - start < 5 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 1500));
        const status = await window.api.status();
        window.SYNC_STATUS = status;
        if (status.lastRun && status.lastRun.runId === targetRunId) {
          await window.refreshData();
          break;
        }
      }
    } catch (err) {
      console.error('sync failed', err);
    } finally {
      setSyncing(false);
      if (onSyncDone) onSyncDone();
    }
  }, [syncing, onSyncDone]);

  return (
    <div data-screen-label="Schedule">
      <SubNav
        title="Schedule"
        right={(
          <>
            <SyncPill />
            <IcalSubscriptionButton />
            <ImportSfuButton />
            <button className="btn-ghost-pill" onClick={() => window.location.hash = '#/subjects'}>Subjects</button>
            <button
              className="btn-primary"
              onClick={handleSync}
              disabled={syncing || window.SYNC_STATUS.running}>
              {syncing || window.SYNC_STATUS.running ? 'Syncing…' : 'Sync now'}
            </button>
          </>
        )}
      />
      <div className="schedule-grid">
        <section className="week">
          <div className="week-head">
            <div>
              <div className="title">{Util.fmtMonthRange(weekStart, weekEnd)}</div>
              <div className="sub">Week of {weekStart.toLocaleDateString('en-US', { weekday: 'long' })}</div>
            </div>
            <div className="week-nav">
              <button className="nav-btn" onClick={() => setWeekStart(Util.addDays(weekStart, -7))} aria-label="Previous week">‹</button>
              <button className="today-btn" onClick={() => setWeekStart(Util.startOfWeek(now))}>Today</button>
              <button className="nav-btn" onClick={() => setWeekStart(Util.addDays(weekStart, 7))} aria-label="Next week">›</button>
            </div>
          </div>
          <WeekGrid weekStart={weekStart} now={now} />
        </section>
        <aside className="side-rail">
          {heroVariant === 'hero' && <NowHero now={now} />}
          {heroVariant === 'timeline' && <TodayTimeline now={now} />}
          {heroVariant === 'list' && <TodayList now={now} />}
          {heroVariant === 'hero' && <TodayList now={now} />}
          <Deadlines now={now} />
        </aside>
      </div>
    </div>
  );
}

Object.assign(window, { SchedulePage });
